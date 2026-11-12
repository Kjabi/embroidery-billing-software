# Production Backup & Restore Runbook

**Audience:** operators of Lalitha's Apparel management (backend owner + Supabase project owner).
**Scope:** what every backup artifact actually is, how to take a **complete** production
backup, and how to restore — into **staging first**, never directly in production.

---

## 1. What each backup artifact actually is

| Artifact | Produced by | What it really is | Complete production backup? |
|---|---|---|---|
| `embroidery_backup_YYYY-MM-DD_HH-MM-SS.db` (browser download) | `POST /api/backup` | Portable **SQLite data export** of the primary database's rows. When the primary is PostgreSQL this is an export, *not* the database itself; when the primary is local SQLite it is the full local database. | **No** (missing Storage files, native schema, sequences) |
| `database/…/*.db` + `storage-objects/…` + `manifests/…/*.json` | `POST /api/cloud-backup` | Same SQLite data export, plus a verified copy of every private Storage object, plus a completion manifest (`complete_backup: false` by design until a native dump exists). | **No** (database artifact is an export) |
| `pg-dumps/…/*.dump` + `manifests/…/*-pgdump.json` | `backend/scripts/pg_backup.py` | **Native `pg_dump -Fc`** of the PostgreSQL database: schema, constraints, indexes, sequences, functions and relationships preserved. Streamed upload + SHA-256 verification. | **Yes** — this is the only complete DB backup |
| Storage object copies | included in cloud backup / pg script runbook section below | Private-bucket files (drawings, invoices, reference images) with per-object SHA-256. | — |

The admin UI never claims a full-backup success unless both the database artifact and the
file copies are verified, and its cloud-backup response labels the database artifact
`backup_format: "sqlite-export"` with `complete_backup: false`. A *complete* production
backup therefore requires:

1. a recent `pg-dumps/**` artifact from `pg_backup.py`, **and**
2. a recent cloud-backup run whose manifest lists the file objects, **and**
3. both artifacts' manifests showing `verification_status: "verified"`.

`GET /api/cloud-backup/status` reports this honestly: `native_postgres_dump_present`,
`complete_backup_available`, `schema_version`, masked `database_project_ref`, and
`database_backup_format: "sqlite-export"`.

---

## 2. Taking the native PostgreSQL backup (`pg_backup.py`)

**Where it runs:** an operator machine, a CI job, or a scheduled runner with
PostgreSQL client tools installed. It must **not** run inside Vercel Functions
(no pg_dump, no persistent disk for large artifacts).

**Required environment** (never logged, never printed):

```bash
export SUPABASE_DATABASE_URL="postgresql://postgres:<PASSWORD>@db.<PROJECT-REF>.supabase.co:5432/postgres"
export SUPABASE_URL="https://<PROJECT-REF>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
# optional: PG_DUMP_BIN=/usr/local/bin/pg_dump  SUPABASE_BACKUP_BUCKET=lalithas-backups
```

**Run:**

```bash
python3 backend/scripts/pg_backup.py
#   [pg-backup] starting native PostgreSQL backup 20261112T021500-… (schema 0004…, pg_dump (PostgreSQL) 16.4)
#   [pg-backup] pg_dump complete: N bytes, sha256 …
#   [pg-backup] uploaded to lalithas-backups/pg-dumps/2026-11-12/….dump
#   [pg-backup] stored object verified: size and SHA-256 match
#   [pg-backup] manifest uploaded to lalithas-backups/manifests/2026-11-12/…-pgdump.json
```

What it guarantees:

* `pg_dump --format=custom --no-owner --no-privileges` → restorable with `pg_restore`,
  preserving schema, constraints, indexes, sequences and relationships.
* The dump is written to a **temporary local file** and uploaded with a **streaming**
  HTTP upload; the process never holds the whole dump in memory.
* The stored object is **streamed back and verified (size + SHA-256)** before the
  manifest is written. A failed verification aborts the run (exit 1, no manifest).
* The manifest records backup ID, timestamp, engine, actual format
  (`pg_dump-custom`), schema version, size, checksum, and restoration command.
* Credentials are never printed: URLs are masked in every log line and pg_dump's
  stderr is scrubbed before display.

**Scheduling (cron example, daily 02:15):**

```cron
15 2 * * * /usr/bin/env python3 /srv/app/backend/scripts/pg_backup.py >> /srv/app/backups/pg_backup.log 2>&1
```

**Retention (recommended, run after the cron job):** keep the newest 14 `pg-dumps/**`
objects and 14 manifests; delete older ones with the Supabase Storage API. Keep at
least one dump older than 30 days for compliance windows.

**Retry rules:** if the run exits non-zero, no manifest exists for that backup ID —
treat that ID as nonexistent and rerun. Never promote an unmanifested dump.

---

## 3. Storage (files bucket) backup

`POST /api/cloud-backup` copies **every object** in the files bucket to
`storage-objects/<day>/<backup_id>/<original-key>` in the private backup bucket,
preserving keys and content types, verifying each copy's SHA-256 by read-back.
It **fails (502, no completion manifest)** when:

* any object referenced by an order (`drawing_object_key`, `invoice_object_key`,
  `reference_image_object_key`) is missing from the files bucket,
* any object exceeds `BACKUP_MAX_OBJECT_BYTES` (default 25 MB),
* the object listing exceeds `BACKUP_MAX_STORAGE_OBJECTS` (default 200),
* any read-back checksum mismatches, or the manifest cannot be stored.

**Restoring files** (staging project): list `storage-objects/<day>/<backup_id>/` in the
backup bucket, download each object, re-upload it to the staging files bucket **under
its original key** (the suffix after the backup-id prefix), then compare SHA-256 with
the manifest's `file_objects[].sha256`. Only then point the staging app at that bucket.

---

## 4. Restoring PostgreSQL — staging first

### 4.1 Environment isolation (required)

* **Production** keeps its own Supabase project (database + both buckets).
* **Preview** must point at a **separate staging Supabase project** — never at the
  production project. Verify with `GET /api/cloud-backup/status`: the masked
  `database_project_ref` must differ between the preview deployment and production.
* Staging gets its own `SUPABASE_URL`, `SUPABASE_DATABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, and its own `lalithas-backups` / `lalithas-files` buckets.
* Secrets live only in platform env configuration; they are never echoed to logs or
  committed to the repository.

### 4.2 Staging restore procedure

1. **Download** the newest verified dump:
   `pg-dumps/<day>/<backup_id>.dump` (check its manifest's `uploaded_sha256_verified: true`
   and confirm the local file's SHA-256 matches `artifact.sha256`).
2. **Prepare the staging database** — use a fresh database (or accept destructive
   replacement after confirming the target is staging, not production).
3. **Restore:**
   ```bash
   pg_restore --no-owner --no-privileges --clean --if-exists \
     --dbname "postgresql://postgres:<PASSWORD>@db.<STAGING-REF>.supabase.co:5432/postgres" \
     ./20261112T021500-ab12cd34.dump
   ```
4. **Apply migrations check:** start the backend against staging; startup validates the
   schema. The manifest's `schema_version` must be ≤ the deployed backend's
   `SCHEMA_VERSION`. If the dump is older than the deployed migrations, apply the
   missing `backend/migrations/0*.sql` files to staging before the app starts.
5. **Verify counts against the manifest:** compare `customers`, `orders`,
   `transactions` row counts with the app's reports, and spot-check that
   `orders.drawing_object_key` values resolve to objects in the staging files bucket
   (restore them per §3 first).
6. **Smoke-test the staging app:** login, open customers/orders, open one drawing
   (signed URL from staging bucket), create + delete one test order.
7. **Record** the restore (date, backup ID, target project ref, verifier) in the
   staging run log.

### 4.3 Why `/api/restore` refuses PostgreSQL restores

`POST /api/restore` accepts **SQLite** backup files only and restores only a
**SQLite** primary database. When the primary is PostgreSQL it returns **409** and
points here: replacing production Postgres rows from a SQLite export would lose the
native schema, sequences and Storage references. This refusal is deliberate and must
not be removed until a tested, documented restore pipeline exists — this runbook is
that pipeline.

### 4.4 Production restore (emergency, owner approval required)

Follow §4.2 against the **production** project only after: (a) the incident is
confirmed, (b) a second operator approves in writing, (c) the current production
state has first been secured with a fresh `pg_backup.py` run, and (d) the restore was
rehearsed in staging on the same dump. Re-enable production access only after the §4.2
step-6 smoke tests pass.

---

## 5. Staging restore test — current status

* **Not yet executed end-to-end**: no staging Supabase project existed at the time of
  this audit, and no PostgreSQL server is available in the local test environment.
* The code paths are covered by automated tests (`backend/tests/test_pg_backup_script.py`,
  `backend/tests/test_backup_postgres_safety.py`) using a stubbed pg_dump and fake
  Storage; real pg_dump/restore behaviour is **untested until §4.2 is executed**.
* **Owner actions required before Go:** provision the staging Supabase project,
  separate preview env vars, install PostgreSQL client tools on a runner, run
  `pg_backup.py` once, and execute §4.2 against staging. Record the result below.

| Date | Backup ID | Staging ref | Operator | Result |
|---|---|---|---|---|
| — | — | — | — | pending |

---

## 6. Never print secrets

* Backend logs must contain masked project refs only (`abcd••••10` style).
* `pg_backup.py` masks URLs in every log line, scrubs pg_dump stderr, and prints no
  environment values.
* Do not paste `SUPABASE_*` values into tickets, chat, or this document.
