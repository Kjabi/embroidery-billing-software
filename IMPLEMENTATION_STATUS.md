# Session-only invoice implementation status

Updated: 2026-10-29 (Asia/Kolkata)

## Implemented locally

- PostgreSQL-ready server-side admin sessions with signed tokens, expiry, logout revocation, and expired-session cleanup at login.
- Private, authenticated business, finance, export, backup, invoice, and payment routes.
- Persistent order, measurement, payment, invoice-number, and immutable invoice-snapshot data only.
- Optional JPEG/PNG reference image handled only inside the invoice request. The backend validates a 5 MB maximum, renders the PDF in memory, closes the upload, and does not write either the image or PDF to local disk, PostgreSQL, or Storage.
- No drawing canvas in the frontend. The upload can be previewed, replaced, or removed before invoice generation.
- Idempotency keys and unique database indexes for order creation and payment collection.
- Atomic, locked yearly invoice counter to avoid duplicate invoice numbers.
- Paginated customer and order APIs (maximum 250 records per request).
- Backward-compatible restore handling for the preserved pre-change SQLite backup: new runtime session/counter tables are optional when reading an old backup.

## Local evidence

```text
PYTHONPATH=. pytest -q                 7 passed
python scripts/benchmark_capacity.py   25,000 customers/orders local proxy
frontend: npm run build                passed
```

The capacity proxy completed in 0.148 seconds, representative indexed reads in 0.0017 seconds, and the temporary SQLite database was 6.86 MB. It is deliberately isolated and does not alter application data or backups.

## Required before production deployment

These remain intentionally unchecked until a real Supabase development/Preview environment is available:

- Apply `backend/migrations/0003_session_invoice_snapshots_and_idempotency.sql` to a development/Preview database.
- Start a Vercel Preview and authenticate the built frontend against the intended API.
- Verify PostgreSQL persistence through a Preview redeployment.
- Run the scheduled cloud-backup job, validate its manifest/checksums, and restore to a separate environment.
- Confirm the original SQLite backup file's checksum before and after the drill; do not overwrite, rename, or delete it.

No production deployment or production database migration was performed.
