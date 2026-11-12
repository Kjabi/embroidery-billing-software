# CURRENT DEPLOYMENT STATUS

**Project:** Lalitha's Embroidery Management System (`embroidery-management`)
**Repository:** https://github.com/Kjabi/embroidery-billing-software
**Local:** `~/Documents/embroidery-management`
**Audited:** 12 Nov 2026
**Vercel account:** `abirudhu-4618` (scope `abirudhu-4618s-projects`)
**Vercel CLI:** 65.14.0 (authenticated)

---

## 1. Git state

| Item | Value |
|---|---|
| Branch | `main` (tracking `origin/main`) |
| HEAD | `c0f1df2759205cf17253a85f0d9ca6ea000326eb` |
| HEAD subject | "Prepare embroidery management application for deployment" |
| Remote | `origin` → `https://github.com/Kjabi/embroidery-billing-software.git` (fetch + push) |
| Working tree | **1 modified file** — `frontend/package-lock.json` (dev-only transitive bump: `postcss-selector-parser` 6.1.4 → 6.1.6, `cssesc` dropped) |
| Untracked | none in tracked directories |
| Recent history | `c0f1df2` ← `2ec5591` (customer editing) ← `af974a4` (duplicate-key fix + `/health`) ← `ae51ce6` (backend hardening + release evidence) ← `85c003c` |

The mobile responsive work and its test suite are **committed** inside `c0f1df2` (`frontend/src/mobile/`, `tests/`, mobile shell in `frontend/src/App.jsx`).

---

## 2. Vercel project

| Setting | Value |
|---|---|
| Project ID | `prj_1Ix6az2rnzQKM8iAzfZig7LywcFK` |
| Root Directory | `.` (repository root) |
| Framework preset | `services` (Vercel's generic preset; `vercel.json` supplies the Vite build/output) |
| Build Command (project) | `None` → overridden by `vercel.json`: `cd frontend && npm ci && npm run build` |
| Output Directory (project) | `None` → overridden by `vercel.json`: `frontend/dist` |
| Node.js Version | `26.x` |
| Region | `iad1` (Washington DC) |
| Build machine | 2 vCPU / 8192 MiB (plan default) |

---

## 3. Deployments

| Deployment | Target | Status | Commit | Age | Aliases |
|---|---|---|---|---|---|
| `https://embroidery-management-4fz8lgeu1-abirudhu-4618s-projects.vercel.app` (`dpl_8G17QsAwHAVu6swKA2TxVMrFZSAZ`) | **Preview** | ● Ready | `c0f1df2` | 24 h | **None confirmed** |
| Production deployments | — | **None exist** | — | — | — |

`vercel ls --environment=production` → *"No deployments found under abirudhu-4618s-projects."*

### Confirmed answers to the phase questions
- **Is the latest GitHub commit still deployed?** Yes — the single deployment was built from `c0f1df2`, which is the current `origin/main` HEAD.
- **Preview or Production?** **Preview.** `target=preview` in the deployment payload.
- **Which domains are assigned to which deployment?** The project has **no confirmed deployment aliases** for this deployment. The preview URL is the only reachable address and it is **protected by Vercel Authentication** (unauthenticated requests receive HTTP 302 to the Vercel auth gate — verified).
- **Are there newer deployments?** No. One deployment total.
- **Build failures or runtime errors?** No. Build completed in 26 s; `api/index` lambda (42.11 MB) deployed; runtime `/api/health` returns `{"status":"ok"}`.

---

## 4. Live preview verification (via authenticated `vercel curl`)

| Request | Result |
|---|---|
| `GET /` | 200 — serves the built `index.html` including the PWA manifest link, `viewport-fit=cover` and `theme-color` |
| `GET /api/health` | 200 `{"status":"ok"}` — FastAPI serverless function is live |
| `GET /api/customers` (no token) | **401** — admin APIs are correctly protected |
| `GET /api/dashboard/summary` (no token) | **401** |
| `GET /assets/index-kIKTjBml.js` | 200, **305,428 bytes** (`application/javascript`) |
| `GET /assets/index-Chhwmzu5.css` | 200, **62,858 bytes** (`text/css`) |
| `GET /assets/ort-wasm-...asyncify.wasm` | 200, **26,861,777 bytes**, `application/wasm`, `cache-control: public, max-age=31536000, immutable`, `access-control-allow-origin: *` |
| `GET /assets/manifest.webmanifest` | 200 but **`content-type: text/html`** — Vercel does not map `.webmanifest`; should be `application/manifest+json` |

**Security headers on `/` (all present):** HSTS (`max-age=31536000; includeSubDomains`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy: microphone=(self), camera=(), geolocation=()`, CSP (`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `script-src 'self'`, `connect-src 'self' https://*.supabase.co https://*.huggingface.co https://*.hf.co`, `worker-src 'self' blob:`).
**Cache headers:** `/` → `public, max-age=0, must-revalidate`; `/assets/*` → `public, max-age=31536000, immutable`.

---

## 5. Build output of the deployed commit (from `vercel inspect --logs`)

```
dist/index.html                                             1.22 kB │ gzip:   0.56 kB
dist/assets/ort-wasm-simd-threaded.asyncify-CxOG5pUO.wasm  26,861.78 kB
dist/assets/index-Chhwmzu5.css                              62.86 kB │ gzip:  11.73 kB
dist/assets/VoiceAssistantPanel-CFGJAOLD.js                 49.76 kB │ gzip:  14.58 kB
dist/assets/index-kIKTjBml.js                              305.27 kB │ gzip:  80.88 kB
dist/assets/FinanceCharts-C6ZxcbHp.js                      429.51 kB │ gzip: 114.60 kB
dist/assets/transformers.web-aaseFeOZ.js                   598.65 kB │ gzip: 174.11 kB
✓ built in 7.50s
(!) Some chunks are larger than 500 kB after minification.
```

**Important correction to the original finding:** `transformers.web` (598.65 kB) is **not** part of the initial bundle. The live `index.html` references only `index-kIKTjBml.js` (305 kB) and `index-Chhwmzu5.css` (63 kB). Transformers.js is already behind a dynamic `import()` in `frontend/src/voice/browserSpeech.js`, and the voice panel itself is behind `React.lazy`. The 598 kB warning is therefore a *chunk-size* warning on an already-lazy chunk, not an initial-payload problem — see `FRONTEND_BUNDLE_OPTIMIZATION_REPORT.md`.

**Python runtime on Vercel:** `No Python version specified in .python-version, pyproject.toml, or Pipfile.lock. Using python version: 3.12` — the serverless runtime is **Python 3.12**, while local tests run on Python 3.14.3. This mismatch is still unverified locally.

---

## 6. Environment variables (names and scopes only — no values read)

| Name | Type | Environments |
|---|---|---|
| `APP_ENV` | Config | Preview, Production |
| `APP_SECRET_KEY` | Secret | Preview, Production |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | Preview, Production |
| `SUPABASE_DATABASE_URL` | Config | Preview, Production |
| `SUPABASE_PUBLISHABLE_KEY` | Config | Preview, Production |
| `SUPABASE_SECRET_KEY` | Config | Preview, Production |
| `SUPABASE_JWKS_URL` | Config | Preview, Production |
| `SUPABASE_BACKUP_BUCKET` | Config | Preview, Production |
| `SUPABASE_FILES_BUCKET` | Config | Preview, Production |
| `SUPABASE_URL` | Config | Preview, Production |
| `GROQ_API_KEY` | Config | Preview, Production |
| `GROQ_CHAT_MODEL` | Config | Preview, Production |

**Not present as Vercel environment variables (by design, supplied another way):**
- `VITE_API_BASE_URL=/api` and `VITE_VOICE_ENABLED=false` come from the committed, non-secret `frontend/.env.production` build-time file.
- `FRONTEND_ORIGIN` is **not set**. The backend defaults to `http://localhost:5173`. This is safe *only* because the frontend and the API are served from the same origin on Vercel (`/api` rewrite), so the browser never issues a cross-origin request. If the API is ever split onto another host, `FRONTEND_ORIGIN` must be set or CORS will block the app.

**Not set and not required for the current architecture:** `ADMIN_INITIAL_USERNAME` / `ADMIN_INITIAL_PASSWORD` (admin is created on first boot against the Supabase database), `APP_DATA_DIR` / `APP_INVOICE_DIR` / `APP_BACKUP_DIR` (serverless has an ephemeral filesystem — see `FASTAPI_VERCEL_COMPATIBILITY_FINAL.md`).

---

## 7. Local verification environment

| Service | URL | Status |
|---|---|---|
| Backend (uvicorn) | `http://127.0.0.1:8010` | ● healthy (`/api/health` → 200) |
| Frontend (Vite dev) | `http://127.0.0.1:5173` | ● serving |

Local data directory: `.runtime/run-20261108/` (SQLite for local runs; production uses Supabase PostgreSQL).

---

## 8. Blockers identified in this phase

| # | Blocker | Severity | Owner action |
|---|---|---|---|
| B1 | **No Production deployment exists.** The only deployment is a Preview with no confirmed aliases and Vercel Authentication in front of it. | High | Approve a Production promotion/deploy after the fixes in Phases 2–4 land. |
| B2 | Preview is protected by Vercel Authentication → external browser acceptance testing needs either protection disabled for the project or a bypass header. | Medium | Owner decision (do not change without approval). |
| B3 | `/assets/manifest.webmanifest` is served as `text/html`. | Low | Fixed in Phase 7 (add a `headers` rule in `vercel.json`). |
| B4 | Python runtime mismatch: Vercel uses 3.12, local suite runs on 3.14.3. | Medium | Install Python 3.12 locally and re-run the backend suite (Phase 5). |
| B5 | `FRONTEND_ORIGIN` unset — safe today only because of same-origin `/api`. | Low | Documented; set only if the API moves to another host. |

---

## 9. Phase 1 conclusion

- The repository is in a clean, reviewable state: one committed head (`c0f1df2`), one trivial dev-only lockfile modification, no destructive or in-flight operations.
- The **live Preview deployment is healthy and up to date** with the current commit, serves the secured admin API correctly (401 without a session), and carries all required security headers.
- The **Production target has never been deployed**. The current situation is a single, protected, alias-less Preview.
- The original "598 kB in the initial bundle" finding is **inaccurate** — it is a lazy chunk; the real initial payload is 305 kB JS + 63 kB CSS.
