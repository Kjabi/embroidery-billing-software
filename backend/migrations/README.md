# Storage migration

Apply `0001_order_storage_object_keys.sql` and `0002_reference_image_object_key.sql` to the Supabase PostgreSQL project **before** deploying the new backend version. Both are additive and intentionally do not modify existing records or erase legacy fields. Production startup no longer runs `create_all`, seeds records, or imports SQLite data.

## Required private buckets

Create/verify these buckets in Supabase Dashboard → Storage:

| Bucket | Public | Allowed content types | Purpose |
|---|---|---|---|
| `lalithas-files` | **Off / private** | `image/png`, `image/jpeg`, `application/pdf` | Legacy files only; new invoice images/PDFs are not stored |
| `lalithas-backups` | **Off / private** | `application/octet-stream`, `application/json`, `image/png`, `application/pdf` | Database snapshots, manifests, and file-object copies |

Keep existing objects in `lalithas-backups`; do not delete or rename them during setup. Suggested max object sizes: 5 MB for `lalithas-files` (drawings are limited by the API to 5 MB; invoice PDFs are normally small) and an appropriate larger limit for `lalithas-backups`.

The backend uses only `SUPABASE_SERVICE_ROLE_KEY` (or the equivalent server-side secret configured for the deployment). Never place this key in `VITE_*`, frontend source, or client-side environment variables. The bucket remains private and is retained only for historical migration/backup support.

Generated invoice PDFs are rendered in memory on demand and are not uploaded or permanently saved by the new invoice flow.

## Existing local files

After the SQL migration and bucket setup, run the file migration script on the original Mac/project checkout while `backend/data/drawings/` and `backend/invoices/` still contain the current files. First perform a dry run, review the counts, then run with `--apply`. The script uploads files with unique object keys, updates each order row, and clears `drawing_path` after a successful object upload. It **does not delete the original local files**. Keep the pre-change SQLite backup and local files until cloud uploads and a restore drill have been verified.

```bash
cd backend
export APP_ENV=production
export SUPABASE_DATABASE_URL='postgresql+psycopg://...'
export SUPABASE_URL='https://<project-ref>.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='<server-side secret>'
export APP_SECRET_KEY='<random session signing secret>'
python scripts/migrate_storage_objects.py       # dry run only
python scripts/migrate_storage_objects.py --apply
```

Use a trusted local shell or deployment secret store for those values; do not paste them into issue comments, source files, or chat.
## 0003 — session, snapshot, and idempotency

`0003_session_invoice_snapshots_and_idempotency.sql` is additive. It creates
server-side admin sessions, a collision-safe invoice counter, immutable invoice-data snapshots, and unique
idempotency keys for order creation and payment collection. Apply it to a
Supabase development branch or Preview database before production.

Reference images and generated PDFs are intentionally request-only and are not
stored in PostgreSQL or Supabase Storage by this version.
