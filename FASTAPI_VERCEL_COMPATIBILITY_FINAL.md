# FASTAPI ↔ VERCEL COMPATIBILITY — FINAL

**Audited:** 12 Nov 2026
**Deployed function:** `api/index.py` (`λ api/index`, **42.11 MB**, region `iad1`)
**Runtime:** Vercel Python **3.12** (auto-detected from the absence of `.python-version` / `pyproject.toml`)
**Verdict:** **PASS for compatibility, BLOCKED for end-to-end acceptance** (workflow tests could not run against the protected preview — see `LIVE_PREVIEW_ACCEPTANCE_REPORT.md`).

---

## 1. Entry point and routing

`api/index.py` prepends `backend/` to `sys.path` and re-exports `main.app`. `vercel.json` rewrites `/api` and `/api/(.*)` to it; everything else falls through to `/index.html`, so the SPA and the API are **same-origin**. This is why `FRONTEND_ORIGIN` can safely stay unset.

Live evidence from the deployment:

| Request | Result |
|---|---|
| `GET /api/health` | `200 {"status":"ok"}` |
| `GET /api/customers` (no token) | `401` |
| `GET /api/dashboard/summary` (no token) | `401` |
| `GET /` | `200`, built `index.html` |
| `GET /assets/*` | `200`, immutable cache |

37 API routes are exposed. The app imports successfully under the serverless guard, so no import-time failure.

---

## 2. Persistence: no business data on Vercel's disk

`backend/main.py` enforces this at import time:

```python
IS_SERVERLESS_DEPLOYMENT = APP_ENV == "production" or os.getenv("VERCEL", "") not in {"", "0", "false"}
if IS_SERVERLESS_DEPLOYMENT:
    if not SUPABASE_DATABASE_URL:
        raise RuntimeError("SUPABASE_DATABASE_URL must be configured for Vercel/production; SQLite is not persistent there.")
    if not storage_is_configured():
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for private production file storage.")
```

- **Database:** Supabase PostgreSQL via `psycopg[binary]`; SQLite is only the local-dev fallback. `pgbouncer` query flags are stripped so the pooled URL is accepted.
- **Reference images / drawings / invoices:** uploaded to the private Supabase Storage bucket (`SUPABASE_FILES_BUCKET`) through backend-only helpers; the service-role key never reaches the browser.
- **Backups:** written to the private `SUPABASE_BACKUP_BUCKET` through a **transient** `tempfile.TemporaryDirectory()` — nothing is retained on the lambda filesystem.
- **Restore:** rejects serverless execution (409) rather than pretending to succeed.

So the answer to “is production data persisted?” is **yes for DB and files, by design and enforced by startup guards**. The local SQLite path and `backend/data` are never used when `APP_ENV=production`.

---

## 3. Serverless constraints

| Constraint | Handling | Status |
|---|---|---|
| 4.5 MB request body cap | App caps reference images at **4 MB** (`MAX_REFERENCE_IMAGE_BYTES`) with a friendly 413 + regression test | PASS |
| Function bundle size (250 MB unzipped) | 42.11 MB | PASS |
| Ephemeral `/tmp` | Only transient PDF/backup scratch space; nothing durable stored | PASS |
| Cold starts | Import-time work is light; SQLAlchemy `pool_pre_ping` handles dropped pooled connections | PASS (observed ≤ 1 s to `/api/health`) |
| Sync endpoints + thread pool | Bounded by `MAX_INFLIGHT_REQUESTS` (`DB_POOL_SIZE + DB_MAX_OVERFLOW`, default 20) with a wait cap, so bursts fail fast instead of hanging | PASS |
| DB pool exhaustion | `pool_size`/`max_overflow` sized to the thread pool | PASS |
| PDF generation (ReportLab) | Pure-Python, CPU-bound, no native shell-outs. Tested locally (PDF ≥ 800 bytes, `%PDF` header) | PASS locally |
| Native wheels for Python 3.12/Linux | `psycopg[binary]`, `Pillow`, `reportlab` publish manylinux 3.12 wheels; the build installed successfully | PASS |
| `faster-whisper` (large ASR model) | Excluded from `backend/requirements-vercel.txt`; production build sets `VITE_VOICE_ENABLED=false` | PASS by exclusion |
| Background tasks | None used for billing; only the local STT path (disabled) | PASS |
| **Function duration limit** | No `maxDuration` configured → Vercel plan default applies. A cold-cache cloud backup that copies many Storage objects could exceed it | **RISK (not tested)** |
| **Process-local state** | Login throttling and voice conversation state are per-instance dictionaries. Multiple lambda instances do not share them | **LIMITATION** |
| **Multi-instance consistency** | Voice conversation continuity can break between invocations; login rate limiting is per-instance (still bounded per instance) | **LIMITATION** |
| **Python 3.12 vs local 3.14.3** | The backend suite (157 tests) ran on Python **3.14.3**, not 3.12 | **NOT TESTED** |

These three gaps are inherent to Vercel Functions and do not break billing, customers, orders, payments, invoices or reports. They matter for: very large backups, brute-force resistance under multi-instance scaling, and voice conversation continuity (voice is disabled in production anyway).

---

## 4. Cost / footprint (free-tier practical)

- One serverless function, one static site: fits Vercel Hobby's function + bandwidth allowances.
- Supabase free tier covers Postgres + two private buckets for a single-shop dataset.
- No paid AI APIs. Voice is off in production; if enabled it runs **on-device** (zero marginal server cost) but pulls a 26.86 MB WASM file + Whisper weights per cold cache.

---

## 5. Decision

| Question | Answer |
|---|---|
| Does FastAPI start on Vercel? | **Yes** (health 200, auth gates 401) |
| Is production data in persistent managed services? | **Yes** (Supabase DB + private Storage) |
| Are uploads/invoices/backups kept off the ephemeral disk? | **Yes**, enforced |
| Are all 37 routes verified against the live deployment? | **No** — Vercel Authentication blocks browser/API acceptance; only health/auth/index/assets were verified |
| Python 3.12 runtime proven? | **No** |
| Verdict | **Compatibility: PASS. Acceptance: BLOCKED.** Not a NO-GO for the architecture — a NO-GO for *claiming* it works until Phase 8 is unblocked and the 3.12 suite is run. |

**Recommendation:** keep FastAPI on Vercel for this single-shop workload. If the unauthenticated preview acceptance reveals function-timeout or multi-instance problems, the smallest safe alternative is to move only the API to a persistent container host (Railway/Fly/Render) and keep the Vercel frontend, with `FRONTEND_ORIGIN` set to the Vercel domain. That is a deployment change, not an application rewrite.
