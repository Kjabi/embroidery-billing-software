# FINAL SECURITY & PERFORMANCE REPORT

**Date:** 12 Nov 2026
**Baseline (historical):** frontend 51 passed, backend 157 passed
**Current:** **frontend 51 passed · backend 157 passed · E2E 57 passed · build PASS · audit 0**
**Result:** **PASS locally / BLOCKED for live acceptance**

---

## 1. Test evidence (run in this session)

| Suite | Command | Result |
|---|---|---|
| Frontend unit | `cd frontend && npm test` | **51 / 51 pass**, 0 fail |
| Backend | `cd backend && ../.venv/bin/python -m pytest tests -q` | **157 passed**, 0 fail (19.29 s) |
| E2E (all specs) | `cd tests && node --test --test-concurrency=1 e2e/*.spec.mjs` | **57 / 57 pass**, 0 fail (232.4 s) |
| Production build | `cd frontend && npm run build` | **PASS** (3.79 s) |
| Dependency audit | `cd frontend && npm audit` | **0 vulnerabilities** |
| Desktop audit (prior) | `.runtime/pw/ui_audit.mjs` | 23 / 23 pass |
| Mobile suite (prior) | `.runtime/pw/mobile_suite.mjs` | 105 / 105 checks pass |

### E2E breakdown (57 tests)
| Spec | Tests | Result |
|---|---|---|
| `mobile-shell.spec.mjs` (mobile + desktop shell) | 12 | PASS |
| `mobile-customers.spec.mjs` | 9 | PASS |
| `mobile-orders.spec.mjs` | 11 | PASS |
| `mobile-finance-states.spec.mjs` | 11 | PASS |
| `desktop-regression.spec.mjs` | 8 | PASS |
| `voice-runtime.spec.mjs` | 5 | PASS |
| `voice-model.spec.mjs` | 1 | PASS |

Every spec asserts **zero console errors, zero page errors and zero failed requests** in its own scope (deliberate fault-injection tests unroute their handler and whitelist only the expected 401/abort message).

The backend count is unchanged from baseline (157) — no backend behaviour was modified in this phase. The frontend count is unchanged (51); the new E2E suite adds 57 tests on top.

---

## 2. Security checks

| Check | Method | Result |
|---|---|---|
| No secrets in the frontend bundle | `grep -rIlE "SUPABASE_SERVICE_ROLE_KEY\|service_role\|sk_live\|eyJhbGciOiJIUzI1NiJ9" dist/assets/*.js dist/assets/*.css` | **clean** |
| No service-role key in client code | `grep` across `frontend/src` | **none** |
| Only public `VITE_*` settings in the bundle | `grep -o "VITE_[A-Z_]*"` on `dist` | only `VITE_VOICE_MODEL_{EN,TA,TANGLISH,DTYPE}` |
| Admin APIs reject unauthenticated access (live) | `vercel curl` on the preview | `/api/customers` → **401**, `/api/dashboard/summary` → **401** |
| Admin APIs reject unauthenticated access (local) | backend suite + E2E login flow | PASS |
| Session expiry bounces to login | E2E: all `/api/**` → 401 → login screen | PASS |
| Server-side session revocation | `logout` revokes the `AdminSession` row; `require_admin` checks `revoked` + `expires_at` | unchanged, covered by backend tests |
| Login rate limiting | 5 failures / 15 min per client key | unchanged |
| Upload cap | 4 MB app cap < 4.5 MB platform cap; regression test | PASS |
| Reference-image validation (type + content) | backend tests | PASS |
| Invoice/upload integrity | PDF `%PDF`, > 800 bytes; delete removes Storage objects | PASS |
| CSP / HSTS / XFO / nosniff / referrer / permissions | live headers on `/` | PASS |
| No `unsafe-eval`; `frame-ancestors 'none'` | live CSP | PASS |
| Secrets not printed | all env inspection used names/scopes only | PASS |
| No production DB writes | only GET/HEAD against the preview | PASS |
| No destructive Git operations | working tree preserved; no commit/push | PASS |

### Security fixes made in this phase
1. **WASM runtime no longer fetches from `cdn.jsdelivr.net`** (CSP-blocked). It is now same-origin. This also removes a third-party code-execution dependency from the voice path.
2. **WebGPU→WASM fallback** prevents a hard failure when `navigator.gpu` exists without an adapter (an availability/DoS-ish reliability bug).
3. **Three dev-time dependency vulnerabilities removed** (vite/esbuild/postcss-selector-parser) with a minimal upgrade.

### Security issues found but not changed (require approval / out of scope)
- `GROQ_API_KEY`, `SUPABASE_DATABASE_URL`, `SUPABASE_SECRET_KEY` are stored as Vercel **Config** rather than **Secret**.
- Preview and Production share the same Supabase data plane.
- Starlette 0.38.6 advisories remain until a FastAPI upgrade is approved.
- Some desktop paths still use `window.alert` (pre-existing; not a security issue, but poorer UX).

---

## 3. Performance checks

| Metric | Baseline (`c0f1df2`) | Current |
|---|---|---|
| Initial JS (single file) | 305.27 kB / 80.88 kB gzip | **147.07 kB app + 143.06 kB React + 22.83 kB icons** (32.06 + 45.80 + 4.71 gzip) |
| Initial CSS | 62.86 kB / 11.73 kB gzip | 62.91 kB / 11.73 kB gzip |
| Lazy voice panel | 49.76 kB | 44.33 kB / 13.30 kB gzip |
| Lazy charts | 429.51 kB | 439.66 kB / 116.97 kB gzip |
| Lazy Transformers.js | 598.65 kB | 598.71 kB / 173.58 kB gzip |
| WASM | 26,861.77 kB | 26,861.78 kB (single copy) |
| Startup requests for voice/model | 0 | **0** (asserted) |
| Build time | 7.50 s | 3.79 s |
| Vulnerabilities | 3 (1 high) | **0** |

No startup request was added. The initial payload is split into three immutable-cacheable files so repeat deploys transfer roughly half the JavaScript.

### Performance risks
- The lazy `transformers.web` chunk still exceeds the 500 kB warning threshold by design; it is only fetched when the microphone is pressed.
- First-ever voice use downloads 26.86 MB WASM + Whisper weights. Expected, cached forever, zero server cost.
- Vercel defaults for function duration were not measured under load.

---

## 4. What was *not* verified

| Item | Status |
|---|---|
| Live preview business workflows (login → order → payment → invoice) | **BLOCKED** (Deployment Protection + shared production data) |
| Python 3.12 backend runtime | **NOT TESTED** (local 3.14.3) |
| Physical mobile browsers, iOS Safari voice | **NOT TESTED** |
| Postgres pooling under serverless concurrency | **NOT TESTED** |
| Production migrations / backup restore | **BLOCKED** (credentials/approval) |
| Production deployment & domain | **NOT DONE** (requires approval) |

---

## 5. Verdict

**Local security and performance: PASS.** All 265 automated checks (51 + 157 + 57) are green, the production build is clean, the dependency audit is empty, the client bundle carries no secrets, and the two real runtime defects found this phase (CDN-blocked WASM, missing WebGPU fallback) are fixed and covered by tests. Live acceptance and production readiness remain **BLOCKED** on infrastructure and approval, not on code.
