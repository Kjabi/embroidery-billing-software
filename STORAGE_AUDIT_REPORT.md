# Storage Audit Report

**Date:** 2026-11-07
**Scope:** every place the application stores data — PostgreSQL rows, local SQLite, invoice/backup files, legacy drawing files, private Supabase Storage buckets, and the browser cache
**Production storage accessed:** none
**Status:** local storage **PASS with caveats**; cloud Storage **NOT TESTED**; one maintenance script **FAIL (broken)**.

> No production bucket, object or database was read, written or deleted for this audit. Cloud
> findings are from source review, not live inspection.

## 1. Storage surfaces

| Surface | What is stored | Where | Backed up |
|---|---|---|---|
| PostgreSQL | customers, orders, measurements, transactions, sessions, invoice sequences | Supabase / isolated PG | yes (logical dump drill) |
| Local SQLite | same schema for development/self-host | `backend/data/embroidery.db` | via `POST /api/backup` |
| Local backups | portable `.db` snapshots | `backend/backups/` | no off-host copy verified |
| Invoice PDFs | rendered on demand | **memory only** (no file write) | not applicable |
| Reference image on invoice | request-scoped bytes | **memory only**, discarded in `finally` | not applicable |
| Legacy drawings | old PNG files | `backend/data/drawings/` | not included in a verified backup |
| Private files bucket | legacy drawings/invoices (object keys) | Supabase `lalithas-files` (private) | via `lalithas-backups` |
| Private backup bucket | DB snapshot, copied objects, manifest | Supabase `lalithas-backups` (private) | not off-provider |
| Browser cache | Whisper ONNX model weights | browser Cache Storage | re-downloadable |
| Browser localStorage | JWT, in-progress order draft, voice language | browser origin | no |

## 2. Local storage inventory (file counts/sizes only; no contents inspected)

| Path | Size | Files | Notes |
|---|---|---|---|
| `backend/data/embroidery.db` | ~140 KiB | 1 | development database; gitignored |
| `backend/data/drawings/` | ~5 KiB | 2 PNG | legacy local drawings; gitignored |
| `backend/invoices/` | ~424 KiB | 2 PDF | legacy generated invoices; gitignored |
| `backend/backups/` | 8 KiB | 1 (`.DS_Store`) | no real backup present in the worktree |
| `.runtime/` | ~775 MB | — | local PostgreSQL cluster, benchmark models, test artifacts; gitignored |

`.gitignore` excludes `backend/data/`, `backend/backups/`, `backend/invoices/`, `.runtime/` and
all `.env` variants (examples are allowed). Verified with `git check-ignore`:

```
.gitignore:5:**/.env              .env
.gitignore:10:backend/data/       backend/data/embroidery.db
.gitignore:19:.runtime/           .runtime
```

No `.env` file appears anywhere in Git history (`git log --all -- .env …` returned nothing), and
`git grep` found no service-role key or Groq key in tracked non-example files.

**Previously recorded backup archive not found.** Earlier work recorded a known-good archive at
`/private/var/folders/.../opencode/embroidery-backups/embroidery-management-20261031-163829.tar.gz`.
That file is **not present at that path now**. This audit did not delete it. The owner must locate
or regenerate it before relying on it as the last known-good backup. Do not delete any other copy
until a verified replacement exists.

## 3. Private Supabase Storage (source review)

`backend/storage.py` is backend-only and never exposes the service-role key to the frontend.

| Control | Implementation | Status |
|---|---|---|
| Buckets must be private | `verify_private_bucket()` rejects `public != false` | PASS (code) |
| MIME allow-list | files bucket must allow `image/png`, `image/jpeg`, `application/pdf`; backup bucket `application/octet-stream`, `application/json`, `image/png`, `application/pdf` | PASS (code) |
| No silent overwrite | uploads default `x-upsert: false`; a `409` raises a sanitised error | PASS (code) |
| Path traversal | `_object_path()` rejects empty keys, leading `/`, and `..` path segments | PASS (code) |
| Signed URL TTL | `create_signed_url()` clamps to 1–3600 s | PASS (code) |
| Bounded listing | `list_objects()` caps at `max_objects` (default 5000) and paginates | PASS (code) |
| Upload verification | backup re-downloads each object and compares SHA-256 | PASS (code) |
| Failure behaviour | backup fails closed (no manifest) if a bucket is public, a MIME type is missing, or an object exceeds the size cap | PASS (code) |
| Service-role key scope | read only from backend env (`SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SECRET_KEY`) | PASS (source review) |

The runtime no longer persists new invoice PDFs or reference images. `POST /api/orders/{id}/invoice`
renders a PDF from database rows and discards the optional image in a `finally` block.
`invoice_object_key` / `reference_image_object_key` are legacy fields; deletion cleans them if
present.

## 4. Verifications that could not be performed

- No bucket was inspected live: privacy flag, MIME allow-list, RLS policies, object count, total
  size, or orphaned objects.
- No cloud backup was created or restored (no staging project/bucket credentials used).
- `scripts/run_scheduled_backup.py` was not run against a real bucket.
- Object-level encryption and provider retention were not verified.
- No Storage RLS policies were reviewed. The backend uses the service-role key, which bypasses RLS;
  any direct client access would bypass tenant isolation. The app architecture keeps all access
  server-side, so this is acceptable **only while** the service-role key stays backend-only.

## 5. Findings

### 5.1 FAIL — storage migration script is broken

`backend/scripts/migrate_storage_objects.py` calls:

- `main.new_object_key(...)`, and
- `main.DRAWING_DIR`

Neither symbol exists anywhere in the repository (`git grep` and full-history search found no
definition). Running the script would fail with `AttributeError` before uploading anything.
This is a maintenance tool, not a runtime path, so the API and UI are unaffected. It is referenced
by `backend/migrations/README.md`, so an operator could hit this during a real migration.

**Recommendation:** either implement the two helpers with a reviewed, collision-resistant key
format and a defined legacy drawing directory, or remove the script and the README step. Do not
run it in production until fixed and rehearsed. Not fixed in this pass because the intended key
format and local path need owner confirmation.

### 5.2 Local backup is co-located with the app

`APP_BACKUP_DIR` defaults next to the code. A host loss destroys both the database and its
backups. There is no verified independent ₹0 destination. Mitigation: follow
`BACKUP_RUNBOOK.md` and upload a verified dump somewhere independent of the host.

### 5.3 Legacy local files remain

Two invoice PDFs and two drawing PNGs are still on disk. They are gitignored and not served by the
current code path, but they may contain customer designs. Delete only with owner approval; include
them in a backup first if they are needed.

### 5.4 Orphaned objects are not swept

`remove_order_assets()` deletes known object keys when an order is deleted (best effort), but an
upload that succeeded before a DB rollback, or a manual bucket change, can leave an unreferenced
object. There is no periodic reconciler. At current volume this is a cost/hygiene risk, not a
correctness risk.

### 5.5 Browser cache/localStorage

- Whisper weights are cached by the browser; the UI documents a cache-clear action. This is
  expected and re-downloadable.
- The JWT is in `localStorage` (see `SECURITY_AUDIT_REPORT.md`), which is XSS-readable.
- The draft order is stored in `localStorage` and removed on logout/save.

## 6. Recommendations (not applied)

1. Fix or remove the broken storage migration script.
2. Establish an independent backup destination and verify one restore from it.
3. Inventory and, with approval, retire the legacy local PDFs/drawings.
4. Add an orphaned-object reconciliation job (list bucket → compare with `*_object_key` columns).
5. Keep both buckets private and MIME-restricted; never expose the service-role key to the
   frontend.
6. Add retention rules for backups (14 daily / 4 weekly / 3 monthly) with monitored failures.
7. Verify Storage RLS/tenant isolation live if a Supabase project is created.

## 7. Verdict

- **Application storage logic (private buckets, no-overwrite, traversal guard, MIME/size limits,
  in-memory PDFs): PASS by source review.**
- **Local storage hygiene: PASS with caveats** (co-located backups, legacy files).
- **Cloud Storage live configuration: NOT TESTED / BLOCKED** (no staging project or credentials).
- **Storage migration script: FAIL (broken references).**
