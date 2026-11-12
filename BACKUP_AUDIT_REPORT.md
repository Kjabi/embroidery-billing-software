# BACKUP AUDIT REPORT — SQLite Exports vs. Native PostgreSQL Backups

**Date:** 12 Nov 2026
**Trigger:** finding that production and Vercel preview run on Supabase PostgreSQL while
`create_sqlite_snapshot()` produces the "backup" by row-copying tables into SQLite —
which is **not** a complete native PostgreSQL backup.
**Status:** **REMEDIATED** — every backup surface now tells the truth about what it is,
a native `pg_dump` pipeline exists, and PostgreSQL restores from SQLite exports are
blocked. No production deploy, no production data writes.

---

## 1. Audit findings

| Surface | Finding | Severity |
|---|---|---|
| `POST /api/backup` | Returned a verified SQLite snapshot (from the prior fix), but when the primary is PostgreSQL the bytes are a **row export**, and nothing told the admin that. | High (mislabelling) |
| `POST /api/cloud-backup` (`create_cloud_backup_artifacts`) | Manifest claimed `"engine": "Supabase PostgreSQL"` while the artifact is a **SQLite export** — direct mislabelling. The manifest lacked schema version, actual backup format, and completion status. | High (mislabelling) |
| `create_cloud_backup_artifacts` (files) | Copied whatever objects existed but **never verified** that the objects referenced by orders (`drawing_object_key`, `invoice_object_key`, `reference_image_object_key`) were present — a missing object silently produced an incomplete backup *with* a completion manifest. | High (silent incompleteness) |
| `create_cloud_backup_artifacts` (memory) | Read the whole snapshot and every uploaded object fully into RAM. | Medium |
| `create_sqlite_snapshot` | `table.select()` fetched **every table fully into memory** before inserting. | Medium |
| `POST /api/restore` | On a non-serverless deployment with a PostgreSQL primary (e.g. local dev pointed at staging/production Supabase), a SQLite upload **could replace live Postgres rows** — losing schema objects, sequences and Storage references. | Critical (data safety) |
| `GET /api/cloud-backup/status` | No project identity, no schema version, no native-dump indicator; the UI had no way to know whether a *complete* backup existed. | Medium |
| Whole system | **No native PostgreSQL backup at all.** No pg_dump anywhere. | Critical (gap) |

---

## 2. Remediations

### `backend/main.py`

1. **Truthful cloud backup** (`create_cloud_backup_artifacts`):
   * Manifest now records `kind: "data-export-and-file-copy"`, `schema_version`,
     `complete_backup: false`, a `limitations[]` block that says the database artifact
     is a SQLite export of rows and points at `pg_backup.py` for the real backup, and
     `database.backup_format: "sqlite-export"` alongside the real `source_engine`
     (`supabase-postgres` or `sqlite`).
   * Response adds `database_engine`, `backup_format`, `schema_version`,
     `complete_backup: false`, `verification_status: "verified"` (all previous keys
     preserved).
   * **Required-object completeness:** distinct `drawing/invoice/reference_image`
     object keys from `orders` must all exist in the files bucket listing, otherwise
     the backup aborts (502) **without a completion manifest**.
   * Memory: snapshot is generated to disk and uploaded with a **streaming** upload;
     the stored object is verified by **streaming** read-back (size + SHA-256) and
     re-downloaded to a file for the isolated-restore proof — the full database no
     longer enters the heap at any point. Per-file object copies stay bounded by
     `BACKUP_MAX_OBJECT_BYTES` (25 MB default).
   * Semantics: pre-flight bucket problems → 503 (unchanged); **any failure inside the
     job → 502 "Cloud backup did not complete: …" and no manifest is written.**
2. **`POST /api/backup`** now answers with `X-Backup-Scope`:
   `full-sqlite-database` (primary really is SQLite) or `portable-data-export`
   (PostgreSQL primary → these bytes are only a portable export, no Storage files,
   no native schema/sequences). Exposed via CORS `expose_headers`.
3. **`POST /api/restore`** returns **409** whenever `primary_is_supabase()` — a
   PostgreSQL database is never restored from a SQLite export — with a pointer to the
   runbook. Local SQLite restores keep working (tests + E2E prove the round trip).
4. **`GET /api/cloud-backup/status`** now reports: masked `database_project_ref` /
   `files_project_ref` (`abcd••••10` style — never a full ref or credential),
   `schema_version` (highest applied migration, `0004_read_path_indexes`),
   `database_backup_format: "sqlite-export"`, `native_postgres_dump_present`
   (probes `pg-dumps/**` in the backup bucket; **`null` = unknown**, never a silent
   yes), `complete_backup_available`, `restore_available`, and
   `production_restore_enabled: false` plus engine-aware `backup_guidance`.
5. **`create_sqlite_snapshot`** streams rows in 500-row batches with
   `stream_results=True` — no table is fully buffered in RAM (server-side cursors on
   PostgreSQL, no-op on SQLite).

### `backend/storage.py` (new bounded-memory helpers)

* `upload_file_streaming` — HTTP upload straight from a file on disk.
* `stream_download` — chunked download into a caller sink (hashing, disk writes).
* `download_file_streaming` — download to a `.part` file + atomic rename, so a failed
  read never leaves a partial artifact.
* All three use a longer, env-tunable HTTP timeout (`STORAGE_HTTP_TIMEOUT_SECONDS`,
  default 600 s) and never leak credentials in errors.

### `backend/scripts/pg_backup.py` (new — the actual complete backup)

Runs **outside Vercel Functions** (operator machine, CI, or cron):

1. Refuses to run without a real `pg_dump` (explicit error naming `PG_DUMP_BIN`;
   **never falls back to a SQLite export**).
2. Rewrites transaction-pooler URLs (6543 → 5432) and forces `sslmode=require`.
3. `pg_dump --format=custom --no-owner --no-privileges` → temp file on disk
   (schema, constraints, indexes, sequences, functions, relationships preserved).
4. Streaming upload to `pg-dumps/<day>/<backup_id>.dump` in the private backup
   bucket; the dump is never fully in RAM.
5. Streaming read-back verifies size **and** SHA-256; mismatch aborts with no
   manifest. A suspiciously small dump (<1 KB) is refused.
6. Uploads a completion manifest (`manifests/<day>/<backup_id>-pgdump.json`) with
   backup ID, timestamp, engine, actual format (`pg_dump-custom`), schema version,
   size, SHA-256, verification status, and the `pg_restore` command template.
7. Never prints credentials: URLs masked in every log line, pg_dump stderr scrubbed,
   no tracebacks (`cli()` maps errors to exit 1).

### `frontend/src/App.jsx`

* `createBackup` reads `X-Backup-Scope`: a PostgreSQL primary now shows
  *"Portable data export downloaded: … This is not a complete production backup."*
  A SQLite primary keeps the existing *"Backup downloaded: …"* (E2E unchanged).
* `createCloudBackup` is truthful: *"Cloud backup stored and verified (N files).
  Format: SQLite data export — not a full PostgreSQL backup."* (The desktop button
  now shares this handler instead of its own `alert()`.)
* More-screen descriptions: "Download a portable data export file" and
  "Store a data export + file copies in Supabase Storage" — the local export and the
  cloud job are visibly different things. Desktop button tooltip updated.
* No UI was removed; all existing screens, buttons and flows are preserved.

### `PRODUCTION_BACKUP_RESTORE_RUNBOOK.md` (new)

* Artifact truth table (what is complete and what is not).
* `pg_backup.py` operation guide: required env (never printed), cron example,
  verification and retention rules, retry rules.
* Storage restore procedure (re-upload under original keys, SHA-256 check against
  manifest).
* **Staging-first** `pg_restore` procedure with migration check, count verification
  against the manifest, and smoke tests; emergency production restore requires
  owner approval and a rehearsed staging run.
* Preview/production isolation requirements (separate staging Supabase project,
  separate buckets and credentials).
* An honest record: **the staging restore test has not yet been executed** (no
  staging project exists) — it is a listed owner action with a results table.

---

## 3. Test results (exact)

| Suite | Command | Result |
|---|---|---|
| Backend (all) | `cd backend && ../.venv/bin/python -m pytest tests -q` | **186 passed** (160 prior + 26 new), 0 failed |
| Frontend unit | `cd frontend && npm test` | **51 passed**, 0 failed |
| Production build | `cd frontend && npm run build` | **PASS** (3.63 s) |
| `npm audit` | | **0 vulnerabilities** |
| E2E (all 9 specs) | `cd tests && node --test --test-concurrency=1 e2e/*.spec.mjs` | **63 passed**, 0 failed |

### New regression tests — `backend/tests/test_backup_postgres_safety.py` (13)

1. Cloud backup labels the SQLite export truthfully (response + manifest fields,
   checksum/size recorded, limitations point at `pg_backup.py`).
2. Missing required object → 502, **no completion manifest**.
3. All required objects present → copied with SHA-256 + content type, `required_object_count` recorded.
4. Checksum mismatch on read-back → 502 (size equal, SHA catches it), no manifest.
5. Manifest upload failure → 502 "did not complete", no manifest.
6. Object listing exceeding the safety bound → 502, no manifest.
7. `X-Backup-Scope: full-sqlite-database` for a SQLite primary.
8. `X-Backup-Scope: portable-data-export` when the primary is PostgreSQL (monkeypatched; the engine stays isolated SQLite in tests).
9. `POST /api/restore` → **409** when the primary is PostgreSQL.
10. Local SQLite restore still works end-to-end (create → backup → restore → marker rollback proven).
11. Status: masked refs (`abcd••••10`, full ref never leaked), schema version, native-dump presence, `production_restore_enabled: false`.
12. Status: pg-dumps listing failure → `native_postgres_dump_present: null` (unknown, not a false yes).
13. `masked_project_ref` never leaks the ref (unit).

### New regression tests — `backend/tests/test_pg_backup_script.py` (13)

Password/host masking; pooler-port rewrite + `sslmode`; SQLAlchemy-URL rejection;
refusal without pg_dump (message contains no credentials); `PG_DUMP_BIN` preference;
manifest completeness + `complete_backup: true` + staging restore target; full success
run with a stubbed pg_dump (dump uploaded, manifest verified, **credentials never
printed**); pg_dump failure → exit 1, nothing uploaded, sanitized stderr still useful;
refusals without pg_dump / for a suspiciously small dump / on storage upload failure
(exit 1, zero objects uploaded, no secret in stderr); `file_sha256` correctness.

*Real `pg_dump`/`pg_restore` behaviour is **not** exercised (no PostgreSQL server or
client tools in this environment) — the script logic is covered by stubbed-process
tests, and the limitation is recorded in the runbook as a pending staging task.*

---

## 4. Live smoke (local run)

```
GET /api/cloud-backup/status →
  database_backup_format: "sqlite-export", schema_version: "0004_read_path_indexes",
  native_postgres_dump_present: null, complete_backup_available: false,
  restore_available: true, production_restore_enabled: false

POST /api/backup → 200
  content-disposition: attachment; filename="embroidery_backup_2026-11-12_23-49-57.db"
  x-backup-scope: full-sqlite-database
  access-control-expose-headers: Content-Disposition, X-Backup-SHA256, X-Backup-Scope
```

---

## 5. Not changed (deliberately)

* Every existing feature and UI workflow: customers, orders, payments, invoices,
  measurements, voice assistant, reports — all E2E specs pass unchanged.
* The `/api/backup` download flow from the previous fix (still verified + streamed).
* No production deploy, no production data writes, no environment changes. The
  staging Supabase project and runner installation are owner/infra actions listed in
  the runbook.
