# Database Audit Report

**Date:** 2026-11-07
**Scope:** schema, integrity and financial invariants of the application database
**Environment audited:** isolated PostgreSQL 17.10 cluster at `127.0.0.1:55433`, database
`rehearsal_20261107` (restored from the synthetic load snapshot `.runtime/embroidery_load.dump`)
**Production access:** none — no production database was queried or modified.
**Status:** **PASS for the rehearsed copy**, with production-schema differences still unverified.

## 1. Verdict

The dataset and schema on the rehearsed copy are internally consistent:

| Check | Result |
|---|---|
| Orphan orders (missing customer) | 0 |
| Orphan orders (missing product) | 0 |
| Orphan measurements (missing order) | 0 |
| Balance mismatch (`total - paid - balance`) | 0 |
| Overpaid orders (`paid > total`) | 0 |
| Negative money values | 0 |
| Duplicate invoice numbers | 0 |
| Null invoice numbers | 0 |
| Duplicate customer phone numbers | 0 |
| Malformed order dates | 0 |
| Malformed transaction dates | 0 |
| Duplicate transaction idempotency keys | 0 |
| Invalid invoice-snapshot JSON | 0 |
| Invoice sequence vs highest invoice | `next_number=893`, highest `892` → consistent |
| Expired but unrevoked sessions | **407** (see §6) |

These results do **not** prove the production database has the same shape. They prove that the
application schema and the data rules behave correctly on a realistic copy.

## 2. Dataset used

Restored from `.runtime/embroidery_load.dump` (synthetic load data, no real customers):

| Table | Rows |
|---|---|
| `admin` | 1 |
| `admin_sessions` | 407 |
| `customers` | 122 |
| `orders` | 892 |
| `order_measurements` | 8,028 |
| `transactions` | 508 |
| `invoice_sequences` | 1 |
| `products` | 14 |
| `measurement_fields` | 53 |
| `measurement_templates` | 7 |
| `embroidery_rates` | 2 |

Largest relations: `orders` 1.5 MB, `order_measurements` 968 kB, `transactions` 432 kB. The whole
database is small; no storage-pressure issue exists at this scale.

## 3. Schema observations

### 3.1 Keys and referential integrity

- 11 primary keys, 6 foreign keys, 3 unique constraints (`admin.username`,
  `products.name`, and the PK-backed uniques).
- All six expected foreign keys exist and are enforced:
  `admin_sessions.admin_id`, `measurement_fields.template_id`,
  `order_measurements.order_id`, `orders.customer_id`, `orders.product_id`,
  `products.measurement_template_id`.
- Foreign-key columns that are **not** indexed: `measurement_fields.template_id`,
  `products.measurement_template_id`, `orders.product_id`. At current scale this is harmless;
  it may matter if those tables grow and cascade/lookup patterns change.

### 3.2 Financial columns

- Money is stored as `double precision`. The application rounds balances to 2 decimals and
  rejects non-finite/negative values on write. There are **no database-level CHECK constraints**
  on money; correctness is application-enforced.
- `orders.invoice_number` is `varchar` with a unique index and is nullable. Application code
  always assigns it. Nulls would be allowed at the database level.
- `orders.balance` is a stored derived value, not a generated column. It is recomputed on every
  payment. The audit found no drift.

### 3.3 Dates

- `orders.order_date`, `orders.delivery_date` and `transactions.date` are `varchar`, not `date`.
  They are validated by the API and compared lexicographically (safe for ISO `YYYY-MM-DD`).
  A malformed value slipped in by any other writer would not be rejected by the database.
- `admin_sessions.expires_at` is `integer` in the SQLAlchemy-created copy and `bigint` in
  migration `0003`. Both hold epoch seconds. This is a **schema-definition drift** to normalize
  deliberately, not a bug at current precision.

### 3.4 Sessions

- `admin_sessions` has a partial index on `(admin_id, expires_at) WHERE revoked = false`.
- 407 expired rows remain unrevoked. They are filtered out by `require_admin` because it checks
  `expires_at >= now`. The rows are dead weight; periodic pruning is recommended (see §6).

### 3.5 Duplicate unique indexes

The model/startup bootstrap and migration `0003` both create unique indexes on the same columns:

```
ix_orders_create_request_id        + ux_orders_create_request_id
ix_transactions_idempotency_key    + ux_transactions_idempotency_key
```

The pairs are redundant. Keep one after confirming which name exists in production; do not drop
blindly. The duplicates cost a small amount of write time and disk.

### 3.6 Invoice allocation

`next_invoice_number()` uses an `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` on
`invoice_sequences`, which serializes on the row. A concurrent load test found that the
working-tree version (using `GREATEST(current, EXCLUDED)`) could hand the same number to two
concurrent first-time callers because `EXCLUDED.next_number` is computed from the statement
snapshot. It was corrected to `GREATEST(current + 1, EXCLUDED)` and re-tested under load. See
`CONCURRENCY_LOAD_TEST_REPORT.md`.

## 4. Index coverage relevant to read paths

Present after `0004`:

| Index | Purpose |
|---|---|
| `idx_orders_customer_id_id_desc` | customer order history |
| `idx_orders_order_date_id` | date-range order lists |
| `idx_orders_balance_positive` (partial) | pending/outstanding scans |
| `idx_order_measurements_order_id` | measurements per order |
| `idx_transactions_date_id` | finance lists |
| `idx_transactions_income_date` (partial) | collected-revenue aggregates |
| `idx_admin_sessions_active_expiry` (partial) | session lookup |

All `0004` indexes are created with `CONCURRENTLY`, so they must run **outside** a transaction
block. A migration runner that wraps files in a transaction will fail on `0004`.

## 5. Data-integrity queries used

The audit ran read-only SQL equivalent to:

```sql
select count(*) from orders o left join customers c on c.id=o.customer_id where c.id is null;
select count(*) from orders o left join products p on p.id=o.product_id where p.id is null;
select count(*) from order_measurements m left join orders o on o.id=m.order_id where o.id is null;
select count(*) from orders where abs(coalesce(total_amount,0)-coalesce(paid_amount,0)-coalesce(balance,0)) > 0.005;
select count(*) from orders where coalesce(paid_amount,0) > coalesce(total_amount,0)+0.005;
select count(*) from orders where total_amount<0 or paid_amount<0 or balance<0;
select count(*) from (select invoice_number from orders where invoice_number is not null group by 1 having count(*)>1) x;
select count(*) from (select phone from customers group by 1 having count(*)>1) x;
select count(*) from orders where invoice_snapshot is not null and invoice_snapshot::json is null;
```

All returned `0`.

## 6. Recommendations (not yet applied)

1. **Prune expired sessions** on a schedule:
   `DELETE FROM admin_sessions WHERE revoked = true OR expires_at < extract(epoch from now());`
   Add a maintenance job or run it during low traffic. Do not run it against production without
   approval.
2. **Resolve duplicate unique indexes** after checking production index names.
3. **Add CHECK constraints** for non-negative money and valid date format only after backfilling
   and validating production data; this is a schema change and needs approval.
4. **Consider `date` columns** for `order_date`, `delivery_date` and `transactions.date` in a
   future migration; changing types is not part of the current additive plan.
5. **Add missing FK indexes** (`products.measurement_template_id`,
   `measurement_fields.template_id`, `orders.product_id`) only if query plans show a need.
6. **Normalize `admin_sessions.expires_at`** to `bigint` in the model so a fresh SQLAlchemy
   database matches `0003`.

## 7. What remains unverified

- The **production** schema was not inspected. Supabase may differ (default schema, RLS,
  extensions, `auth` schema, pooler settings).
- No `EXPLAIN (ANALYZE, BUFFERS)` was captured against production-scale data.
- No write-path audit was performed on production.
- RLS policies, if any, were not inspected.

**Production database label: NOT TESTED.**
