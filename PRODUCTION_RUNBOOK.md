# Production Runbook — Lalitha's Apparel

**Date:** 2026-11-08
**Status:** prepared, **NOT EXECUTED**. No production resource was created, migrated or deployed.
**Primary target:** **Vercel** (Services: static Vite `web` + Python ASGI `api`).
**Fallback target:** Oracle Always Free + Docker/Caddy (`deploy/`), retained but not selected.
**Audience:** the owner/operator who will run the deployment.

> Every command below is written to be copy-pasteable, but none has been run against the real
> production environment. Treat the first execution as a supervised change, not a routine one.
> `vercel.json` validates against the published Vercel schema; that is not a deployment test.

## 1. Preconditions (all must be true before step 3)

- [ ] Owner approval to deploy, recorded in writing.
- [ ] Owner decision on the **Vercel plan**. Hobby is non-commercial-use only; a business needs
      Pro (~US$20/month), which conflicts with the ₹0 target.
- [ ] A verified, restorable backup of the production database exists (`BACKUP_RUNBOOK.md`).
- [ ] Migration `0003`/`0004` has been rehearsed on a copy of the real schema
      (`DATABASE_MIGRATION_PLAN.md`) — not just on an empty database.
- [ ] The SPA builds with `VITE_API_BASE_URL=/api` and `VITE_VOICE_ENABLED=false`
      (`frontend/.env.production`, committed; no secrets).
- [ ] A Vercel project can be created, and the **Services** feature is available on the account.
- [ ] Decide how the code reaches Vercel: `npx vercel deploy` from this working tree (includes
      uncommitted files) **or** a Git-connected project (requires committing `vercel.json`,
      `frontend/.env.production`, `backend/requirements-vercel.txt` and `.vercelignore` first —
      approval required).
- [ ] `.vercelignore` is present so the root `.env`, `.runtime/`, `.venv/` and local data are not
      uploaded.
- [ ] A domain you control (optional for the first Preview) is ready to point at Vercel.
- [ ] `APP_SECRET_KEY` was generated with `openssl rand -hex 32`.
- [ ] `ADMIN_INITIAL_PASSWORD` is set for the **first** boot only, and will be removed after.
- [ ] Supabase project is **not paused**; the pooler connection string is correct.
- [ ] Private buckets `lalithas-files` and `lalithas-backups` exist, are private, and have the
      expected MIME allow-lists.
- [ ] Someone is available to watch the first 30 minutes.

If any box is unchecked, stop.

## 2. Environment contract

### 2.1 Vercel project environment variables (Production and Preview)

Set these in **Vercel → Project → Settings → Environment Variables**. Never put a secret in a
`VITE_` variable, and never commit the real values.

| Variable | Required | Notes |
|---|---|---|
| `APP_ENV` | yes | `production` |
| `APP_SECRET_KEY` | yes | 32+ random bytes; rotate on suspected exposure |
| `FRONTEND_ORIGIN` | yes | exact origin(s), comma-separated; `https://<project>.vercel.app` and the custom domain. Never `*` |
| `SUPABASE_DATABASE_URL` | yes | `postgresql+psycopg://…?sslmode=require`; use the **Supavisor session pooler** (port 5432) for synchronous SQLAlchemy |
| `SUPABASE_URL` | yes | project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | backend only; never a `VITE_` var |
| `SUPABASE_FILES_BUCKET` | default | `lalithas-files` |
| `SUPABASE_BACKUP_BUCKET` | default | `lalithas-backups` |
| `ADMIN_INITIAL_USERNAME` | first boot | e.g. `lalithas`; remove or rotate after initialization |
| `ADMIN_INITIAL_PASSWORD` | first boot | remove after initialization |
| `VOICE_STT_PROVIDER` | no | leave unset/`local`; voice is disabled in the browser build |
| `VOICE_LLM_PROVIDER` | no | `deterministic` (default) |
| `DB_POOL_SIZE` | recommended | lower than the default `10` on serverless (e.g. `2`) |
| `DB_MAX_OVERFLOW` | recommended | lower than the default `10` (e.g. `2`) |

Do **not** set `VITE_API_BASE_URL` in Vercel: the committed `frontend/.env.production` already
sets `/api` and `VITE_VOICE_ENABLED=false`. Vercel environment variables would override it, so
leave `VITE_*` unset unless you intentionally change the build.

### 2.2 Build output

- `vercel.json` defines two services: `web` (root `frontend/`, Vite, output `dist`) and `api`
  (root `backend/`, Python 3.12, entrypoint `main:app`).
- `backend/requirements-vercel.txt` intentionally omits `faster-whisper` and `pytest`.
- The browser uses a relative `/api` base; top-level rewrites send `/api` and `/api/(.*)` to the
  `api` service before the SPA catch-all.
- `.vercelignore` keeps the root `.env`, `.runtime/`, `.venv/`, local data and build output out
  of the upload while allowing `frontend/.env.production`.

## 3. Deploy to Vercel (primary path)

### 3.1 Link and configure

```bash
# from the repository root
npx vercel link            # select/create the project
npx vercel env ls          # confirm no VITE_* overrides are set
```

Set every variable from §2.1 for both **Production** and **Preview**. Use the Vercel dashboard
or `npx vercel env add <NAME>`; do not paste secrets into shell history on a shared machine if
you can avoid it.

### 3.2 Deploy a Preview first

```bash
npx vercel deploy          # Preview deployment; prints the Preview URL
```

Expected: the build completes, `/api/health` responds, and the SPA loads from the same URL.
**Do not promote to production until §6 passes on the Preview URL.** If Deployment Protection
(Vercel Authentication) is enabled for Preview, either turn it off for this test or use a
protection-bypass token; otherwise API calls redirect to the Vercel login.

### 3.3 Promote to production

```bash
npx vercel deploy --prod
npx vercel ls              # note the deployment URL and timestamp
```

If Services is unavailable on the account, stop. Do not silently switch to a single Vercel
function without re-testing the `/api` routing and the serverless guards.

### 3.4 Oracle/Caddy fallback (not selected)

The previous Docker/Caddy/systemd path is retained for a self-hosted fallback. Its steps are in
`deploy/` and `STAGING_DEPLOYMENT_REPORT.md`; they were never executed. If the fallback is chosen,
build with `VITE_API_BASE_URL=/api VITE_VOICE_ENABLED=false npm run build`, serve `frontend/dist`
from `/srv/app`, and proxy `/api/*` to the backend. Re-run the entire §6 verification because the
header/proxy behaviour differs from Vercel.

## 4. Apply database migrations (only after the verified backup)

Follow `DATABASE_MIGRATION_PLAN.md` exactly. Summary:

```bash
# 1) snapshot / verify restore first
# 2) apply 0003 in a transaction
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f backend/migrations/0003_session_invoice_snapshots_and_idempotency.sql
# 3) deploy the backend version that understands the new schema
# 4) apply 0004 outside a transaction (concurrent index build)
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f backend/migrations/0004_read_path_indexes.sql
```

Then verify:

```sql
-- expected: tables/columns/indexes exist, sequence >= max invoice
SELECT count(*) FROM admin_sessions;
SELECT * FROM invoice_sequences;
SELECT indexname FROM pg_indexes WHERE tablename IN ('orders','transactions','admin_sessions');
```

Do **not** run `0004` inside `BEGIN/COMMIT`. Serverless functions open connections per request;
apply migrations from a workstation, not from a Vercel function.

## 5. Deploy the frontend

Vercel builds the SPA from `frontend/` using `npm ci` and `npm run build`, with the committed
`frontend/.env.production` (`VITE_API_BASE_URL=/api`, `VITE_VOICE_ENABLED=false`). The same
deployment serves the SPA and proxies `/api` to the Python service.

- Keep the previous deployment available in Vercel for instant rollback (`ROLLBACK_PLAN.md`).
- Do **not** set `VITE_VOICE_ENABLED=true` until the physical microphone matrix passes.
- If you split origins later, set `VITE_API_BASE_URL` to an absolute URL and update
  `FRONTEND_ORIGIN` exactly; do not use `*`.
- Cloudflare Pages is not used (25 MiB per-file limit; see
  `CLOUDFLARE_DEPLOYMENT_COMPATIBILITY.md`).

## 6. Post-deploy verification (do all of it)

```bash
BASE="https://<preview-or-production-url>"

# Same-origin SPA and API
curl -fsS "$BASE/" | grep -qi '<div id="root">' && echo 'SPA OK'
curl -fsS "$BASE/api/health"

# Security headers
curl -sSI "$BASE/api/health" | grep -iE 'strict-transport|content-security|x-content-type|x-frame|referrer-policy|permissions-policy'

# Docs must not be exposed as JSON through the SPA origin (expect HTML/404)
curl -sSI "$BASE/openapi.json"

# An unlisted cross-origin caller must not receive an allow-origin header
curl -sSI -H 'Origin: https://evil.example.com' "$BASE/api/health" | grep -i access-control-allow-origin
```

In the UI, with a real admin login:

- [ ] login succeeds; a wrong password 5× triggers throttling; login works again after the window.
- [ ] logout revokes the session (the old token returns 401).
- [ ] create a customer; create an order with a delivery date; record a payment.
- [ ] generate/download a PDF invoice; confirm the invoice number is correct and unique.
- [ ] replay the same create/payment request → no duplicate row.
- [ ] the voice panel is **absent** (`VITE_VOICE_ENABLED=false`), and the rest of the dashboard works.
- [ ] upload a 4 MB JPEG/PNG reference image and generate the PDF; a file just over 4 MB is
      rejected by the app with a friendly message, not a platform 413.
- [ ] cloud backup from the UI succeeds and the object exists in `lalithas-backups`.
- [ ] `/api/backup` returns a clear `503` if serverless storage is not configured.
- [ ] `/api/restore` returns `409` on serverless (manual restore is an operator action).

Record each result with a timestamp. Any failure stops the rollout.

## 7. Monitoring (minimum for a ₹0 deployment)

| Signal | How | Action |
|---|---|---|
| Liveness | external ping of `/api/health` every 5 min (free uptime checker) | investigate after 2 failures |
| Function errors | Vercel dashboard → Logs; `npx vercel logs <deployment-url>` | inspect 5xx bursts |
| Function duration | Vercel dashboard → Observability | raise limits only after checking queries |
| Supabase pause | dashboard / failed logins | resume project, review inactivity |
| TLS | Vercel manages certificates | re-check after a domain change |
| Backups | verify a restore monthly (`BACKUP_RUNBOOK.md`) | a backup is not real until restored |
| Sessions | monthly `DELETE FROM admin_sessions WHERE revoked OR expires_at < now()` | hygiene |

## 8. Routine maintenance

- **Daily:** confirm the health check is green and a backup ran.
- **Weekly:** check Vercel function errors/duration, Supabase status, and backup objects.
- **Monthly:** restore a backup into a throwaway DB; review dependency advisories; prune sessions.
- **Per release:** deploy a Preview, run §6, then promote; keep the previous deployment.
- **Do not** assume serverless instances share in-memory state: conversation state and rate
  limits are per instance. Session revocation is DB-backed and does work across instances.

## 9. Incident procedures

### 9.1 API returns 5xx / function crash

```bash
npx vercel ls
npx vercel logs <deployment-url>
```
- Config/secret error → fix the Vercel env var, redeploy.
- Bad release → instant rollback (`ROLLBACK_PLAN.md`).
- Database error → check Supabase status; do not retry destructive operations.

### 9.2 Supabase project paused

Logins/API fail. Resume from the Supabase dashboard. No paid auto-resume workaround is
configured. After resume, verify counts and the latest backup.

### 9.3 Function timeout or memory pressure

PDF generation is in memory; very large invoices or uploads can hit the function limit. Check
Vercel logs for duration/memory, reduce payload size, and do not raise limits blindly. There is no
persistent local disk — do not write backups to the filesystem.

### 9.4 Certificate failure

Vercel manages TLS. Usually DNS is wrong or the domain is not verified in the project. Fix DNS /
domain verification in Vercel; do not disable HTTPS.

### 9.5 Suspected secret exposure

Rotate `APP_SECRET_KEY` (invalidates sessions), the admin password, and the Supabase service-role
key. Check logs for abuse. Never paste secrets into tickets or chat.

### 9.6 Duplicate invoice or sequence gap

Stop writes if invoices are affected. Inspect `invoice_sequences` and the max invoice number.
Restore from the last verified backup if integrity is compromised. Do not hand-edit sequences on
production without a snapshot and owner approval.

### 9.7 Login lockout (all users)

The rate limiter is in-memory and per serverless instance, so it may reset on cold start and is
not shared across instances. Investigate whether the proxy makes all clients share one key (see
`SECURITY_AUDIT_REPORT.md` §4.3).

## 10. Known production limitations (accept or fix)

- Vercel **Services** is a Beta feature; runtime behaviour is unverified until Preview passes.
- Vercel **Hobby** is non-commercial-use only; commercial use needs Pro (~US$20/month).
- Serverless instances are ephemeral: in-memory rate limits/conversation state are per instance.
- Each function instance opens up to 20 database connections by default (`DB_POOL_SIZE=10`,
  `DB_MAX_OVERFLOW=10`). Tune these down before load testing against Supabase; the transaction
  pooler requires prepared statements to be disabled, which is not configured here.
- Vercel caps request/response bodies at 4.5 MB. The reference-image upload is limited to 4 MB;
  PDFs embedding a near-limit image must be spot-checked for the response cap.
- PDFs are generated in memory; no persistent local filesystem.
- Supabase Free can pause after inactivity; no SLA.
- No independent verified backup destination yet (`BACKUP_RUNBOOK.md`).
- Voice is **disabled** in production; physical microphone acceptance and Tamil TTS are
  `NOT TESTED` and must pass before re-enabling.
- Open Starlette/FastAPI advisories pending a framework upgrade.
- Tamil/Tanglish speech accuracy is partial; spoken Tamil digits are unreliable.

## 11. Rollback

See `ROLLBACK_PLAN.md`. Vercel keeps every deployment, so application rollback is a promotion of
the previous deployment. Keep the pre-migration snapshot until the release has been stable
through at least one backup/restore cycle.

## 12. Execution record

| Step | Date | Operator | Result | Notes |
|---|---|---|---|---|
| Preconditions | — | — | NOT EXECUTED | |
| Vercel project + env vars | — | — | NOT EXECUTED | |
| Preview deploy | — | — | NOT EXECUTED | |
| Migrations | — | — | NOT EXECUTED | |
| Production promote | — | — | NOT EXECUTED | |
| Post-deploy verification | — | — | NOT EXECUTED | |
| Voice disabled (`VITE_VOICE_ENABLED=false`) | — | — | DESIGNED | physical mic NOT TESTED |
