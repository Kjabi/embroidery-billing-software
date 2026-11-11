# Staging Deployment Report

**Date:** 2026-11-07
**Scope:** whether a realistic staging environment exists, what was verified in its place, and what is required before a real staging deploy
**Status:** **BLOCKED** — no staging environment was provisioned. All verification was local and isolated.

> This report is deliberately blunt: the project brief asks for staging deployment evidence. What
> exists is **local isolated verification**, which is valuable but is *not* staging. It does not
> exercise TLS, DNS, a CDN, a managed pooler, object storage, or a second machine.

## 1. What "staging" would require

A staging environment that could honestly gate production needs:

- a separate PostgreSQL database (not the production database),
- separate private storage buckets,
- a deployed backend on a real host with TLS,
- a deployed frontend on a real origin,
- environment variables distinct from production (including a distinct `APP_SECRET_KEY`),
- the ability to run migrations, backups and restores against it,
- network access matching production (proxy, CORS, pooler).

None of these external resources were created.

## 2. What was actually available and used

| Environment | Purpose | Where |
|---|---|---|
| SQLite `TestClient` databases | backend test suite | `pytest` temp dirs |
| Isolated PostgreSQL 17.10 cluster | migration rehearsal, load, backup drills | `127.0.0.1:55433` |
| Throwaway SQLite DB + Vite dev server | typed UI end-to-end | localhost |
| In-app browser (mic denied) | frontend/mic-denial checks | localhost |
| Perf backend, single worker | load tests | `127.0.0.1:8010` |

Isolated PostgreSQL databases created for this work: `embroidery_load`,
`embroidery_migration`, `embroidery_restore`, `rehearsal_20261107`, `perf_20261107`,
`drill_restore_20261107`. None are production. The production Supabase project was never
queried, migrated, written to, or backed up.

## 3. Verification performed in the local isolated environment

| Check | Result | Report |
|---|---|---|
| Backend test suite (150 tests) | PASS | `VOICE_ACCEPTANCE_REPORT.md` |
| Frontend unit tests (19) | PASS | `VOICE_ACCEPTANCE_REPORT.md` |
| Production build | PASS (build) | `CLOUDFLARE_DEPLOYMENT_COMPATIBILITY.md` |
| Migration `0003` + `0004` applied twice | PASS, idempotent | `DATABASE_MIGRATION_PLAN.md` |
| Schema/financial invariants on rehearsal copy | PASS (0 violations) | `DATABASE_AUDIT_REPORT.md` |
| SQLite backup/restore drill | PASS | `BACKUP_RESTORE_REPORT.md` |
| PostgreSQL `pg_dump -Fc` → empty DB `pg_restore` | PASS, counts identical | `BACKUP_RESTORE_REPORT.md` |
| Concurrency load 25/50/100 users | PASS after invoice-race fix | `CONCURRENCY_LOAD_TEST_REPORT.md` |
| Private bucket logic (source review) | PASS | `STORAGE_AUDIT_REPORT.md` |
| Live bucket privacy/MIME | NOT TESTED | `STORAGE_AUDIT_REPORT.md` |
| TLS / DNS / CORS across origins | NOT TESTED | this report |
| ARM64 image build/run | NOT TESTED / BLOCKED | `ARM64_COMPATIBILITY_REPORT.md` |
| Physical microphone | NOT TESTED | `VOICE_ACCEPTANCE_REPORT.md` |

## 4. What the local environment cannot prove

1. **Cross-origin behaviour.** The frontend and backend ran on localhost. CORS allow-listing,
   preflight caching, cookie/`Authorization` behaviour through a real proxy, and mixed-content
   rules are unverified.
2. **TLS and certificate automation.** No Let's Encrypt issuance, renewal, HSTS enforcement,
   or HTTP→HTTPS redirect was exercised.
3. **Managed PostgreSQL pooler.** The app uses synchronous SQLAlchemy with `SELECT … FOR UPDATE`.
   Session-pooler behaviour (and transaction-mode incompatibility) was not tested against a
   Supabase pooler.
4. **Private object storage.** Bucket privacy, MIME allow-lists, signed URLs, and backup
   round-trips were reviewed in code, not executed against a live project.
5. **Single-worker assumptions under a real proxy.** Proxy headers, client IPs and rate-limit
   bucketing were not observed through Caddy/Cloudflare.
6. **Restart/upgrade behaviour.** No rolling deploy, container restart, or rollback was performed.
7. **Environment-variable contract.** `APP_ENV=production` fail-closed behaviour (missing
   secret, missing storage) was not exercised on a deployed host.
8. **Browser model download.** The 150–500 MB Whisper download from Hugging Face, its cache
   behaviour, and first-use latency were not observed end-to-end.

## 5. Staging plan (to execute when resources exist)

1. Create a **separate** Supabase project (or a distinct PostgreSQL schema on the isolated
   cluster exposed only to staging) and separate private buckets.
2. Apply `0003` and `0004` with the procedure in `DATABASE_MIGRATION_PLAN.md`.
3. Deploy the backend image to a non-production host with TLS (Oracle A1 as designed, or any
   free host) using `deploy/backend.env` with staging values.
4. Deploy the frontend on the **same** Caddy origin (owner decision A), built with
   `VITE_API_BASE_URL=/api` and `VITE_VOICE_ENABLED=false`.
5. Set `FRONTEND_ORIGIN` to that single staging origin.
6. Run the acceptance matrix:
   - login/logout/session revocation,
   - create order → payment → delivery → PDF,
   - duplicate/idempotency replay,
   - confirm the voice panel is hidden (`VITE_VOICE_ENABLED=false`),
   - backup → restore into a throwaway DB → verify counts,
   - migration idempotency,
   - rate-limit behaviour through the proxy (per-client, not global),
   - CORS preflight from the staging origin and rejection from an unlisted origin,
   - security headers via `curl -I`,
   - browser speech with a **real microphone**.
7. Record every result in this report and replace the `NOT TESTED` rows.

## 6. Exit criteria for calling staging "PASS"

- Every row in §5 recorded with an actual observation.
- No `FAIL` on migration, backup/restore or auth.
- Physical microphone rows completed (or explicitly deferred by the owner).
- Frontend deployment compatible with the chosen host (see the WASM decision).
- Independent backup destination verified.

## 7. Verdict

- **Local isolated verification: PASS** (see linked reports).
- **Staging deployment: NOT PERFORMED / BLOCKED** — no credentials, no host, no domain,
  no separate Supabase project, no Docker daemon for the ARM64 image.
- **Production readiness cannot be inferred from local tests alone.** A real staging pass is
  still required.
