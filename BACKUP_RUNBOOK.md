# Backup Runbook

**Audience:** operator with authorized access to the deployment
**Status:** verified locally and on an isolated PostgreSQL cluster; production steps are the
reviewed procedure, not yet executed.

> Never paste secrets (database URLs, service-role keys) into tickets, chat, logs or this file.
> Read them from the deployment secret store into the environment.

## 1. Backup schedule (recommended)

| What | How often | Retention |
|---|---|---|
| PostgreSQL logical dump | daily | 14 daily + 4 weekly + 3 monthly |
| Private Storage object manifest + copies | daily with the dump | same |
| Pre-deploy dump | before every migration/release | 30 days |
| Restore test | monthly into a throwaway database | keep the report |

Run backups from a scheduled job (GitHub Actions with `scripts/run_scheduled_backup.py` or the
host cron) and store output in a destination **independent of the database provider**.

## 2. Configure the app-backed cloud backup

Required backend-only settings (not frontend):

```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_FILES_BUCKET=lalithas-files
SUPABASE_BACKUP_BUCKET=lalithas-backups
```

Both buckets must be **private**. Then:

```bash
# status: expect configured=true and database_configured=true when using Postgres
curl -sS -H "Authorization: Bearer $TOKEN" "$API_BASE/cloud-backup/status"

# take a backup (stores database snapshot, file objects and a manifest)
curl -sS -X POST -H "Authorization: Bearer $TOKEN" "$API_BASE/cloud-backup"
```

Scheduled entrypoint:

```bash
APP_ENV=production \
APP_SECRET_KEY="$APP_SECRET_KEY" \
SUPABASE_URL="$SUPABASE_URL" \
SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
SUPABASE_DATABASE_URL="$SUPABASE_DATABASE_URL" \
python backend/scripts/run_scheduled_backup.py
```

The script prints only keys and counts. A non-zero exit means the backup failed and must alert.

## 3. PostgreSQL logical backup (provider-independent)

```bash
# dump
pg_dump -Fc "$SUPABASE_DATABASE_URL" -f "backup-$(date +%Y%m%d-%H%M%S).dump"

# checksum
shasum -a 256 "backup-YYYYMMDD-HHMMSS.dump"

# verify immediately by restoring into a throwaway database
createdb drill_verify
pg_restore --no-owner -d drill_verify "backup-YYYYMMDD-HHMMSS.dump"

psql -d drill_verify -c '
  select (select count(*) from customers) customers,
         (select count(*) from orders) orders,
         (select count(*) from transactions) transactions;'
```

Compare these counts with the source before declaring the backup valid. Never delete the previous
backup until the new one has restored successfully.

## 4. Local application backup (development / SQLite)

```bash
curl -sS -X POST -H "Authorization: Bearer $TOKEN" "$API_BASE/backup"
```

Response includes `backup_file` and `storage: "local-development-only"`. Copy it off the host if it
matters. This path is **not** a production backup strategy.

## 5. Restore procedure (full, production)

Production restore is intentionally manual. A database-only restore can leave storage objects
(drawings, legacy invoice files) inconsistent with rows.

1. **Announce and freeze writes.** Put the app in maintenance or stop the writer.
2. **Take a fresh pre-restore backup** (do not skip, even if a backup exists):
   ```bash
   pg_dump -Fc "$SUPABASE_DATABASE_URL" -f "pre-restore-$(date +%Y%m%d-%H%M%S).dump"
   ```
3. **Verify the backup you intend to restore** by restoring it into a throwaway DB and comparing
   counts (see §3). Do not proceed on a failed verify.
4. **Restore the database** through the provider's restore mechanism or `pg_restore` into the
   target database. If using `pg_restore --clean`, confirm the target first; it drops objects.
5. **Restore Storage objects** from the cloud backup manifest:
   - download each object listed in the manifest,
   - verify its SHA-256,
   - upload it back to the original key without overwriting a newer object unless approved.
6. **Reset sequences** if rows were restored without sequence state:
   ```sql
   select setval(pg_get_serial_sequence('orders','id'), coalesce(max(id),1), true) from orders;
   -- repeat for customers, transactions, order_measurements, products, measurement_templates,
   -- measurement_fields, embroidery_rates, admin
   ```
7. **Verify**:
   - login works,
   - order count and invoice sequence are sane,
   - a sample invoice PDF renders,
   - finance totals match the pre-incident snapshot,
   - `invoice_snapshot` JSON parses.
8. **Re-enable writes** and record the restore in the incident log.

## 6. Restore procedure (local SQLite / development)

```bash
curl -sS -X POST "$API_BASE/restore" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@backup_YYYY-MM-DD_HH-MM-SS.db"
```

The endpoint validates `PRAGMA integrity_check`, checks required tables, writes a
`before_restore_*.db` safety copy, then replaces all rows. It is disabled when
`IS_SERVERLESS_DEPLOYMENT` is true.

## 7. Retention and deletion

- Never delete the last known-good backup.
- Keep the existing archive at
  `/private/var/folders/.../opencode/embroidery-backups/embroidery-management-20261031-163829.tar.gz`
  until an approved replacement has been verified.
- Prune only after a newer backup has passed a restore test.
- Deleting backups or production data requires explicit owner approval.

## 8. Monitoring checklist

- [ ] Scheduled backup job exits `0` every day.
- [ ] New manifest exists and its SHA-256 matches.
- [ ] `GET /api/cloud-backup/status` returns `configured=true`.
- [ ] A monthly restore test into a throwaway database passes.
- [ ] Backup size is trending normally (not zero, not exploding).
- [ ] Alerts fire on a failed/missing backup.
