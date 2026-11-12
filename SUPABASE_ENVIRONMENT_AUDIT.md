# SUPABASE & ENVIRONMENT AUDIT

**Audited:** 12 Nov 2026
**Method:** `vercel env ls` (names + scopes only). **No secret value was read, printed or copied.**
**Verdict:** **BLOCKED** — configuration is internally consistent, but environment isolation between Preview and Production is not established, and live connectivity/persistence was not verified against production.

---

## 1. Variables present in the Vercel project

Source: `vercel env ls` — the CLI shows names, types and target environments; it does not reveal values here.

| Name | Type | Environments | Used by | Assessment |
|---|---|---|---|---|
| `APP_ENV` | Config | Preview, Production | backend | Present. |
| `APP_SECRET_KEY` | **Secret** | Preview, Production | backend JWT signing | Present, correctly secret. |
| `SUPABASE_DATABASE_URL` | Config | Preview, Production | SQLAlchemy → Postgres | Present. Should be a Secret (it contains a password) — see §4. |
| `SUPABASE_URL` | Config | Preview, Production | DB/Storage client | Present, non-secret. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret** | Preview, Production | **backend only** | Present, correctly secret. **Not** exposed to Vite. |
| `SUPABASE_SECRET_KEY` | Config | Preview, Production | backend (alternative key name) | Present. Should be a Secret. |
| `SUPABASE_PUBLISHABLE_KEY` | Config | Preview, Production | possibly unused by this backend | Present; non-secret by definition. |
| `SUPABASE_JWKS_URL` | Config | Preview, Production | Supabase auth | Present, non-secret. |
| `SUPABASE_FILES_BUCKET` | Config | Preview, Production | private file bucket | Present. |
| `SUPABASE_BACKUP_BUCKET` | Config | Preview, Production | private backup bucket | Present. |
| `GROQ_API_KEY` | Config | Preview, Production | optional voice LLM | Present, but typed **Config**, not Secret — see §4. |
| `GROQ_CHAT_MODEL` | Config | Preview, Production | optional voice LLM | Present, non-secret. |

### Expected but **not** present in Vercel

| Name | Why it is not needed / what it means |
|---|---|
| `VITE_API_BASE_URL` | Supplied by the committed, non-secret `frontend/.env.production` (`/api`). Build-time only. |
| `VITE_VOICE_ENABLED` | Supplied by `frontend/.env.production` (`false`). Build-time only. |
| `FRONTEND_ORIGIN` | Unset → backend defaults to `http://localhost:5173`. **Safe only because the SPA and API share the Vercel origin**, so no CORS preflight is ever needed. Must be set the day the API moves to another host. |
| `ADMIN_INITIAL_USERNAME` / `ADMIN_INITIAL_PASSWORD` | Only bootstrap the first admin; the admin already exists in Supabase. |
| `APP_DATA_DIR` / `APP_INVOICE_DIR` / `APP_BACKUP_DIR` | Meaningless on serverless; the app refuses local SQLite when `APP_ENV=production`. |
| `TOKEN_TTL_SECONDS`, `DB_POOL_SIZE`, … | Optional tuning with safe defaults (8 h TTL, pool 10+10). |

---

## 2. Secret-boundary checks

| Check | Result |
|---|---|
| Service-role key in frontend code | **None** — `grep` of `frontend/src` and the built `dist/assets/*.js` found no `service_role`, `SUPABASE_SERVICE_ROLE_KEY`, `sk_live`, or hard-coded JWT patterns |
| Any `VITE_*` variable carrying a secret | **None** — only `VITE_VOICE_MODEL_*` names appear in the voice chunk |
| Secrets in the repo | `.gitignore` excludes `.env*` (except `.env.example` / `.env.production` which contain public build settings only) |
| Storage access from the browser | Direct Supabase Storage calls only via the backend; browser URLs are pre-signed/backend-mediated |
| Auth on admin APIs | Live: `401` without a token (verified) |
| CSP `connect-src` | `'self'`, `https://*.supabase.co`, `https://*.huggingface.co`, `https://*.hf.co` — no wildcard, no `unsafe-eval` in `script-src` |

---

## 3. Preview ↔ Production isolation — the material finding

`APP_ENV`, `SUPABASE_DATABASE_URL` and the Storage keys are configured for **both Preview and Production with the same scope**. That means **the Preview deployment almost certainly reads and writes the production Supabase database and buckets**.

Consequences:
- Phase 8's instruction “use isolated staging data only; do not create or modify real business records” **cannot be satisfied** with this configuration.
- Any browser-based write test against the preview (customer, order, payment, upload, backup) would touch production data.
- Therefore **no write testing was performed** against the preview.

**Required before any acceptance test:** a dedicated staging Supabase project (or a separate `preview` database/bucket set), with Preview-scoped env vars pointing at it. That is an owner/infrastructure action and was **not** performed here.

---

## 4. Security hygiene observations (no changes made)

1. `GROQ_API_KEY` is typed **Config** rather than **Secret**. Anyone with project read access can view config values. Recommend re-adding it as a Secret — requires approval because it touches project env vars.
2. `SUPABASE_DATABASE_URL` and `SUPABASE_SECRET_KEY` are likewise typed Config despite containing credentials. Same recommendation.
3. Preview and Production share every backend variable — see §3.
4. `FRONTEND_ORIGIN` being unset is currently harmless but fragile; document it in the deploy runbook.
5. The committed `frontend/.env.production` intentionally contains only public values (`VITE_API_BASE_URL=/api`, `VITE_VOICE_ENABLED=false`). This is safe **provided no future edit adds a secret**. Add a CI grep guard if desired.

---

## 5. What could not be verified

| Item | Status |
|---|---|
| Preview DB is reachable from the lambda with the configured pooled URL | **Indirectly PASS** — `/api/health` is 200 and the app boots, which requires `SUPABASE_DATABASE_URL` to be present; but no query was executed against production |
| Postgres pooling under serverless concurrency | **NOT TESTED** |
| Storage upload/download against the real buckets | **NOT TESTED** (would write production objects) |
| Migrations `0003` / `0004` applied in production | **BLOCKED** — no credentials/approval to inspect or apply |
| Backup bucket contents restorable | **NOT TESTED** |
| Supabase project plan / quotas | **NOT TESTED** |

---

## 6. Verdict

**BLOCKED.** Variable **names** are complete and the secret boundary in the client is clean. But Preview and Production share the same data plane, so isolated acceptance testing is impossible without an infrastructure change, and persistence/pooling remain unverified. No environment variable was modified.
