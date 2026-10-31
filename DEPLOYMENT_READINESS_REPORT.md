# Deployment Readiness Report — Lalitha's Apparel

**Audit date:** 19 October 2026  
**Verdict:** **NOT READY** for a Vercel production deployment.

## Executive summary

The running application is currently a FastAPI backend with a React/Vite frontend. When `SUPABASE_DATABASE_URL` is present, every SQLAlchemy-backed API route uses Supabase PostgreSQL; this is the current authoritative database. The local SQLite database is not an independently writable production database in that configuration, but it remains a source for one-time automatic import and is used for portable backup snapshots. Drawings, invoices, and backup archives are still written to local server paths.

The audit fixed critical application-layer authorization flaws: all business routes now require a valid signed, expiring admin token; the former static token was removed; CORS is origin-restricted; login attempts are throttled in-process; legacy password hashes upgrade after a successful login; and order/payment validation is enforced on the server. These fixes are tested only with isolated test data.

Vercel remains unsafe because there is no Vercel configuration or deployed FastAPI function, and the backend depends on persistent local filesystem paths for invoices, drawings, and backups. SQLite must not be used for Vercel writes. Do not deploy until the blockers below are resolved and verified in a Preview deployment.

## Architecture and data flow

```text
Browser (React/Vite)
  └─ VITE_API_BASE_URL (or local http://127.0.0.1:8000/api)
       └─ FastAPI
            ├─ SQLAlchemy → Supabase PostgreSQL (when SUPABASE_DATABASE_URL exists)
            │                otherwise backend/data/embroidery.db
            ├─ drawings → APP_DATA_DIR/drawings (local filesystem)
            ├─ invoices → APP_INVOICE_DIR (local filesystem)
            └─ backup snapshots → APP_BACKUP_DIR (local filesystem)
                 └─ optional upload → Supabase Storage bucket
```

The current `.env` has a `SUPABASE_DATABASE_URL`, so PostgreSQL is selected by `PRIMARY_DATABASE_URL`. The backend also has an automatic `migrate_local_data_to_supabase()` import path: it copies SQLite data once only if Supabase has no customer or order data. It is not a synchronization design.

## Data inventory and protection performed

- Local SQLite file: `backend/data/embroidery.db`.
- Fresh pre-change backup: `backend/backups/audit_prechange_2026-10-19_20-49-26.db`.
- Backup verification: `PRAGMA integrity_check` returned `ok`.
- SQLite row counts: admin 1; customers 3; embroidery_rates 2; measurement_fields 53; measurement_templates 7; order_measurements 8; orders 2; products 14; transactions 3.
- Supabase PostgreSQL connectivity was verified with a read-only connection. It has the same nine tables and matching row counts.
- A deterministic, table-by-table comparison found the same logical rows in each database. The initial product digest difference was attributable to PostgreSQL numeric representation versus SQLite floats; direct field comparison found no product differences.
- Integrity checks found zero duplicate invoice numbers, zero detected orphaned order/customer/product/measurement references, and zero order-vs-income-ledger paid-amount mismatches in SQLite. PostgreSQL has five foreign-key constraints and zero detected orphan references.

No data migration, deletion, reset, or live database permission change was performed.

## Security findings and remediation

### Fixed

- All customer, product, template, rate, order, payment, invoice, finance, export, backup, restore, and cloud-backup routes now require `Authorization: Bearer <signed-token>`.
- Login now issues an HMAC-signed token with an expiry instead of `local-admin-token`.
- Invalid/missing tokens return HTTP 401. A direct test against the configured Supabase-backed application verified all sampled protected routes reject unauthenticated requests.
- Password verification now uses PBKDF2-HMAC-SHA256 with a random salt and 600,000 iterations. Existing legacy SHA-256 hashes remain login-compatible only long enough to upgrade after a successful login.
- A new empty database requires `ADMIN_INITIAL_PASSWORD`; the code no longer seeds `admin123`.
- Browser CORS is restricted to `FRONTEND_ORIGIN` (local development default only); wildcard CORS was removed.
- Login is throttled after five failed attempts per process/IP within 15 minutes.
- The frontend attaches the bearer token to every protected API call, including PDF and finance-export downloads.
- Server-side order totals now use saved product/rate records instead of trusting browser-supplied totals/rates. Negative/excess payments and oversized/non-PNG drawings are rejected.
- SQLite local-development connections now enable foreign keys, WAL, normal synchronous mode, and a busy timeout.

### Remaining security gaps / manual action

- `APP_SECRET_KEY` and `FRONTEND_ORIGIN` are absent from the current local environment. The new code intentionally refuses production/Vercel startup without `APP_SECRET_KEY`. Configure a long random value and the exact HTTPS frontend origin in Vercel.
- Login throttling is in memory only and is not reliable across Vercel instances. Add a shared rate-limiting store/service before public exposure.
- Tokens are stored in browser `localStorage`; a future XSS flaw could expose them. A hardened production design should use secure, HttpOnly, SameSite cookies or equivalent session management.
- There is no password change/reset flow yet. Replace the known/default administrator password through a controlled admin workflow before deployment.
- No Supabase RLS, role grants, bucket visibility, or Storage policy was changed. These are **NOT VERIFIED** because the available environment does not contain a Storage service-role key, and no live permission changes were authorized.

## Persistence, backups, and restore

The backend can create a SQLite snapshot from either active database. It can upload that snapshot and a JSON manifest to Supabase Storage when a service role is configured. TLS verification is enabled through `certifi`; no certificate verification was disabled.

An isolated automated restore test created a snapshot, checked its SQLite integrity, added test data, restored the snapshot, and verified the record count reverted correctly.

The production backup posture is still insufficient:

- No daily scheduler, retention policy, checksum, external copy, backup listing/download, or cloud restore workflow exists.
- The backup manifest only records three counts and does not prove an upload can be read back or restored.
- Drawings and generated invoice PDFs are not included in the SQLite snapshot or cloud backup.
- The configured local environment lacks `SUPABASE_SERVICE_ROLE_KEY`; Supabase Storage upload/list/download and bucket-public/private status are **NOT VERIFIED**.
- A historical manifest says the bucket was public, but current bucket privacy is **NOT VERIFIED**. Make it private through the Supabase dashboard after confirming required service access; do not add a public policy.

## Financial and data-integrity limitations

- Money is stored as floating-point values. This risks rounding errors; a future tested migration should use integer paise or PostgreSQL `NUMERIC`.
- Payments are represented both by `orders.paid_amount` and separate transactions, but transactions lack an order foreign key and idempotency key. A network retry can still double-record a payment. Do not add a ledger migration until existing orders and transactions are reconciled.
- Invoice numbers are generated as `count + 1`; concurrent requests can collide and return a uniqueness error. Use a database-backed sequence/counter in a tested migration.
- Order creation spans database commits, local drawing writes, and PDF generation. A failure after a partial step can leave orphaned files or an order without a PDF.
- `Base.metadata.create_all()` is not a migration system. There is no Alembic history, schema version, or tested rollback plan.

## Vercel readiness

**Blocked.** The repository has no `vercel.json`, no Python serverless entry point, and no Preview deployment configuration. Vercel Functions do not provide persistent writable storage, so current paths for SQLite, PDFs, drawings, and backups are invalid for production.

Before a Preview deployment:

1. Choose a durable backend hosting strategy for FastAPI, or implement and verify a supported Vercel Python function layout.
2. Keep Supabase PostgreSQL as the sole writable production database; disable/remove automatic SQLite import after a tested one-time migration decision.
3. Move drawings and invoices to private durable object storage; store object identifiers rather than local paths.
4. Configure Vercel variables: `SUPABASE_DATABASE_URL`, `APP_ENV=production`, `APP_SECRET_KEY`, `FRONTEND_ORIGIN`, `VITE_API_BASE_URL`, and only backend-side Storage credentials if needed.
5. Configure the exact frontend build/output (`npm run build`, `frontend/dist`) and API routing, then test Preview login, CRUD, invoice download, persistence across a new instance, and private file access.

## Tests actually run

| Command | Result |
| --- | --- |
| `sqlite3 ... .backup ...` plus `PRAGMA integrity_check` | Passed (`ok`) |
| Read-only Supabase PostgreSQL connection/table-count comparison | Passed |
| SQLite/PostgreSQL logical row comparison | Passed after numeric normalization check |
| `python -m py_compile backend/main.py` | Passed |
| Protected-route check against configured application | Passed; sampled protected routes returned 401 without a token |
| `cd backend && ../.venv/bin/python -m pytest -q tests` | Passed: 5 tests; 373 dependency deprecation warnings |
| `cd frontend && npm run build` | Passed; bundle warning: 631.74 kB JavaScript chunk exceeds Vite's 500 kB advisory threshold |
| Supabase Storage list/download/private-bucket verification | **NOT VERIFIED** |
| Vercel Preview smoke test | **NOT VERIFIED**; no Vercel configuration/deployment exists |

## Files changed

- `backend/main.py`: authentication, CORS, login throttling, safer password handling, protected routes, validation, SQLite connection settings, and configurable runtime directories.
- `frontend/src/App.jsx`: configurable API base URL, authenticated API/download requests, and removal of default-password UI disclosure.
- `backend/requirements.txt`: adds `httpx` and `pytest` for tests.
- `.env.example` and `frontend/.env.example`: documents required production variables without secrets.
- `backend/tests/test_security_and_orders.py`: isolated integration tests for auth, calculations/payments, snapshot integrity, and restore.
- This report.

During test hardening, an initial test generated an invoice into the fixed application invoice directory. Runtime directories were immediately made test-configurable, and both local invoice PDFs were regenerated from the authoritative current order data. Subsequent tests use temporary invoice, backup, and data folders only.

## Go / no-go checklist

- [x] Recoverable local SQLite pre-change backup verified.
- [x] PostgreSQL connectivity and record-count/content comparison completed.
- [x] API authorization, signed expiry tokens, server-side amount validation, and isolated restore test implemented.
- [ ] Production `APP_SECRET_KEY` and exact CORS origin configured.
- [ ] Supabase RLS, grants, and private Storage bucket verified.
- [ ] Durable private storage for drawings/invoices implemented and tested.
- [ ] Automated, retained, independently recoverable backups (database plus assets) implemented and restore-tested.
- [ ] Alembic migration/reconciliation plan for money, ledger linkage, and invoice sequencing completed.
- [ ] Vercel-compatible backend/API routing and Preview deployment tested.
- [ ] Cross-instance rate limiting and payment idempotency implemented.

**Do not deploy to production until every unchecked item is resolved and a Preview deployment has passed the documented end-to-end checks.**

## Required production-gate status (19 October 2026)

| Requirement | Result | Evidence / limitation |
| --- | --- | --- |
| Vercel Preview starts and frontend authenticates against intended API | **NOT DEMONSTRATED** | No Vercel configuration or connected Vercel project is available. |
| Customers, orders, measurements, invoices, and payments persist after redeployment | **PARTIALLY DEMONSTRATED LOCALLY ONLY** | Isolated SQLite test persisted a customer across a backend reload. A Vercel redeploy/production PostgreSQL test was not run. |
| Customer files work without local disk | **FAILED / NOT IMPLEMENTED** | Drawings, PDFs, and backups resolve to server filesystem directories. |
| Unauthorized users cannot access sensitive endpoints | **DEMONSTRATED** | Isolated suite exercised all 21 protected business/finance/export/backup routes; each returned 401 without a bearer token. |
| Repeated payment requests cannot duplicate transactions | **NOT DEMONSTRATED** | No durable idempotency key or unique database constraint exists yet. |
| Scheduled backup integrity and isolated restore | **PARTIALLY DEMONSTRATED** | Snapshot integrity and isolated restore passed. No scheduler, retained external copy, or cloud restore is configured. |
| Pre-change SQLite backup preserved and unchanged | **DEMONSTRATED** | Backup integrity is `ok`; current SHA-256 is `4ed674b3fe97a3a97fdbb834bd803d9404c0ffce850e5017d94ecd02f3b0e126`. |
