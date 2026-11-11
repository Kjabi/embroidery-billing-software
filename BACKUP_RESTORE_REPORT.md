# Backup & Restore Report

**Date:** 2026-11-07
**Status:** isolated drills **PASS**; production/Supabase restore **NOT TESTED**.
**Production data touched:** none.

## 1. What exists in the application

| Mechanism | Implementation | Scope |
|---|---|---|
| Local SQLite snapshot | `POST /api/backup` → `create_sqlite_snapshot()` | copies every table into a portable `.db` file in `APP_BACKUP_DIR` |
| Local SQLite restore | `POST /api/restore` (multipart `.db`) | validates `PRAGMA integrity_check`, required tables, then replaces all rows |
| Cloud backup | `POST /api/cloud-backup`, `scripts/run_scheduled_backup.py` | uploads a database snapshot + private Storage objects + a manifest to `lalithas-backups` |
| Cloud backup status | `GET /api/cloud-backup/status` | reports whether DB/storage are configured |
| Production restore | **disabled** in `POST /api/restore` when `IS_SERVERLESS_DEPLOYMENT` | forces the documented isolated full-restore procedure |

Important behaviour:

- `create_sqlite_snapshot()` works even when the primary database is PostgreSQL: it creates a
  fresh SQLite schema and copies rows table by table. That gives a portable logical backup.
- `restore_sqlite_backup()` replaces **all** active rows (delete + insert) and, on PostgreSQL,
  resets integer sequences with `setval`. It skips sequence reset for `admin_sessions` and
  `invoice_sequences` (string/manual keys).
- The restore endpoint first creates `before_restore_<timestamp>.db`, so a bad restore can be
  reversed.
- Cloud backup fails closed if private buckets are not configured; it verifies each uploaded
  object by downloading it and comparing SHA-256 for the manifest.
- The scheduled script prints only keys/counts, never rows or environment values.

## 2. Local SQLite drill (executed)

Environment: throwaway `APP_DATA_DIR`, `APP_INVOICE_DIR`, `APP_BACKUP_DIR`; SQLite primary;
no Supabase variables; in-process FastAPI `TestClient`. No real data.

Steps and results:

| Step | Result |
|---|---|
| Seed 4 customers, 2 orders, 2 transactions, 18 measurements | created |
| POST `/api/backup` | `200`, file written |
| Backup `PRAGMA integrity_check` | `ok` |
| Backup contains all 11 tables | PASS |
| Backup counts | customers 4, orders 2, transactions 2, measurements 18, sequences 1 |
| Mutate live DB (+1 customer, +1 order) | 5 customers, 3 orders |
| POST `/api/restore` with the backup | `200`, `status=restored` |
| Post-restore customers/orders | 4 / 2 |
| Mutated customer present after restore | **no** (correctly rolled back) |
| `before_restore` snapshot created | yes |
| Second backup after restore | `200 ok` |

**Result: PASS.** The local backup captured a consistent snapshot and restored it exactly,
including rollback of post-backup writes and creation of a safety snapshot.

## 3. PostgreSQL logical drill (executed)

Environment: isolated cluster `127.0.0.1:55433`; source `rehearsal_20261107`;
destination `drill_restore_20261107` (created empty). No production access.

| Step | Result |
|---|---|
| `pg_dump -Fc` of rehearsal DB | 160,069-byte custom dump |
| `pg_restore` into empty database | exit `0` |
| Row counts source vs restore | identical for all sampled tables |
| Duplicate invoices | 0 |
| Balance mismatches | 0 |
| Orphan orders | 0 |

| Table | Source | Restored |
|---|---|---|
| customers | 122 | 122 |
| orders | 892 | 892 |
| transactions | 508 | 508 |
| order_measurements | 8028 | 8028 |
| admin_sessions | 407 | 407 |
| invoice_sequences | 1 | 1 |
| products | 14 | 14 |
| measurement_fields | 53 | 53 |

**Result: PASS.** A custom-format dump restored into an empty database with identical counts and
no integrity violations.

## 4. What was **not** tested

- Supabase Storage cloud backup (no staging/production bucket credentials were used).
- `scripts/run_scheduled_backup.py` against a real private bucket.
- Restore of Storage objects (drawings/invoice files) — the current app renders PDFs in memory
  and does not persist them, but legacy objects exist in `lalithas-files`.
- Restore into production or a Supabase Preview project.
- A scheduled/automated backup running for 24h+ (only a single drill was run).
- Restore time at production scale (drill used 892 orders; production volume unknown).
- Encryption-at-rest claims for the backup destination (depends on the provider).

## 5. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Local `.db` backups stored on the same host as the app | host loss loses both | upload to an independent ₹0 destination; verify |
| No automated retention/rotation | disk growth or accidental deletion | add retention policy with owner approval |
| Cloud backup requires private buckets | silently unavailable if unset | monitor `GET /api/cloud-backup/status` |
| Restore replaces all rows | a bad upload destroys data | `before_restore` snapshot exists; verify checksum before restore |
| `restore` disabled in serverless | production restore is manual | follow `BACKUP_RUNBOOK.md` full procedure |
| No encryption key management documented | confidentiality depends on provider | use private buckets + provider encryption |

## 6. Verdict

**Local and PostgreSQL backup/restore mechanics: PASS (isolated).**
**Production backup destination and full-stack restore: NOT TESTED / BLOCKED** on credentials,
bucket creation and an independent ₹0 destination.
