# Database Migration Plan

**Date:** 2026-11-07
**Target:** production PostgreSQL (Supabase) — **not executed**
**Rehearsal target:** isolated PostgreSQL 17.10, database `rehearsal_20261107`
**Status:** rehearsal **PASS**; production **BLOCKED / NOT TESTED**.

> No production migration was applied. This document is the reviewed plan, not evidence of
> execution.

## 1. Migrations in the repository

| File | Purpose | Transactional | Applied in rehearsal |
|---|---|---|---|
| `0001_order_storage_object_keys.sql` | adds `orders.drawing_object_key`, `orders.invoice_object_key` | yes | pre-existing in snapshot |
| `0002_reference_image_object_key.sql` | adds `orders.reference_image_object_key` | single statement | pre-existing in snapshot |
| `0003_session_invoice_snapshots_and_idempotency.sql` | `admin_sessions`, `invoice_sequences`, `orders.invoice_snapshot`, `orders.create_request_id`, `transactions.idempotency_key`, unique indexes | yes (`BEGIN; … COMMIT;`) | **PASS, applied twice** |
| `0004_read_path_indexes.sql` | six read-path indexes created `CONCURRENTLY` | **no** — must not run in a transaction | **PASS, applied twice** |

`0004` is currently untracked in Git. Do not deploy it until it is reviewed and committed with
approval.

## 2. Rehearsal procedure and result

1. Created a fresh database from the synthetic load snapshot:
   `pg_restore --no-owner .runtime/embroidery_load.dump` into `rehearsal_20261107`.
2. Recorded baseline: `orders=892`, `invoice_sequences=(2026,893)`.
3. Applied `0003` twice with `psql -v ON_ERROR_STOP=1`. Both runs exited `0`; the second run
   emitted `NOTICE … already exists, skipping` for the idempotent objects.
4. Applied `0004` twice with `psql -v ON_ERROR_STOP=1`. Both runs exited `0`; indexes were already
   present on the second run.
5. Re-checked baseline: `orders=892` (unchanged), `invoice_sequences=(2026,893)` (unchanged).
6. Ran the invariant queries in `DATABASE_AUDIT_REPORT.md`; all violations = 0.

The rehearsal proves the files are **additive and idempotent** on this schema. It does not prove
they behave identically on the production schema.

## 3. Pre-flight checks (production, before any change)

Run these read-only checks and save the output with the change record:

```sql
-- existing objects
select to_regclass('public.admin_sessions');
select to_regclass('public.invoice_sequences');
select column_name, data_type
from information_schema.columns
where table_schema='public' and table_name in ('orders','transactions','admin_sessions')
order by table_name, ordinal_position;

-- duplicate index names / columns
select indexname, indexdef from pg_indexes
where schemaname='public' and tablename in ('orders','transactions');

-- current invoice baseline
select count(*), count(distinct invoice_number), max(invoice_number) from public.orders;
select * from public.invoice_sequences;

-- data hygiene
select count(*) from public.orders
where invoice_number is not null
group by invoice_number having count(*) > 1;
```

Abort if:

- `orders.invoice_number` already contains duplicates (the unique index would fail).
- `orders.create_request_id` already contains duplicates (backfill/review first).
- `transactions.idempotency_key` already contains duplicates.
- The `invoice_sequences` row for the current year exists with a value lower than
  `max(invoice suffix)+1` and the application's resync SQL is not shipped at the same time.

## 4. Production execution order

### 4.1 Snapshot

Take a verified backup before touching schema (see `BACKUP_RUNBOOK.md`):

- Supabase database backup or `pg_dump -Fc`.
- Confirm the dump restores into a throwaway database and row counts match.
- Record the backup identifier, timestamp and checksum.

### 4.2 Apply `0003` (transactional)

```bash
psql "$SUPABASE_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f backend/migrations/0003_session_invoice_snapshots_and_idempotency.sql
```

- This runs in an explicit transaction and is safe to re-run.
- It creates `admin_sessions` and `invoice_sequences`, adds nullable columns, and builds unique
  indexes. On a large `orders` table the unique index build takes a share lock and can block
  writes. Schedule a maintenance window or build the indexes `CONCURRENTLY` manually first,
  then let the `CREATE UNIQUE INDEX IF NOT EXISTS` become a no-op.

### 4.3 Deploy the backend version that:

- reads `admin_sessions` for every authenticated request,
- reads/writes `invoice_sequences`,
- writes `invoice_snapshot` and `create_request_id`,
- uses the corrected `next_invoice_number()` (`GREATEST(current + 1, EXCLUDED)`).

Order matters: deploy `0003` **before** the backend if the backend expects the new tables. If the
old backend is still running while `0003` applies, it keeps working because the change is
additive.

### 4.4 Apply `0004` (non-transactional, concurrent)

```bash
# must NOT be wrapped in BEGIN/COMMIT
psql "$SUPABASE_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f backend/migrations/0004_read_path_indexes.sql
```

- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block.
- If a statement fails it can leave an `INVALID` index behind. Check:
  ```sql
  select indexrelid::regclass, indisvalid from pg_index
  where indexrelid::regclass::text like 'idx_%';
  ```
  Drop and recreate any `indisvalid = false` index.
- These indexes are performance-only; they can be deferred if the window is risky.

### 4.5 Post-migration verification

```sql
select count(*) from public.orders;                     -- unchanged vs baseline
select * from public.invoice_sequences;                 -- sane next_number
select count(*) from public.admin_sessions;             -- table exists
select indexname from pg_indexes
where schemaname='public' and indexname like 'idx_%';   -- 0004 indexes present, valid
```

Then run an authenticated smoke test: login, create one order, generate its invoice, collect a
payment, reload the order. Confirm exactly one invoice number was consumed.

## 5. Known risks

| Risk | Mitigation |
|---|---|
| Unique index build blocks writes on large `orders` | build indexes `CONCURRENTLY` first, or use a maintenance window |
| `0004` wrapped in a transaction by a runner | run with plain `psql`, not a transactional migration tool |
| Duplicate index pairs (`ix_*` + `ux_*`) | decide which to keep; do not drop blindly |
| Production `expires_at` type differs (`integer` vs `bigint`) | additive read is compatible; normalize later |
| Backend deployed before `0003` | deploy migration first |
| Invoice-number race under concurrency | fixed in working tree; verify the deployed image contains the fix |

## 6. Rollback

`0003` and `0004` are additive and were designed not to erase data, so rollback is normally
"deploy the previous backend, keep the columns/indexes". If a full rollback is required:

```sql
-- Only after confirming the old backend does not use these objects.
DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_income_date;
DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_date_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_order_measurements_order_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_orders_balance_positive;
DROP INDEX CONCURRENTLY IF EXISTS idx_orders_order_date_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_orders_customer_id_id_desc;
```

Do **not** drop `admin_sessions`, `invoice_sequences`, or the new columns as part of a routine
rollback: doing so discards session/audit history and snapshot data. A destructive rollback needs
a separate approved plan and a fresh backup.

## 7. Approval requirements

Before production execution, obtain explicit owner approval covering:

1. the maintenance window,
2. the backup identifier and restore test,
3. the exact backend image/commit to deploy,
4. permission to run `0003` and `0004`,
5. a named person to verify and a rollback decision-maker.
