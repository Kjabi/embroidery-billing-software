# BACKUP DOWNLOAD FIX REPORT

**Date:** 12 Nov 2026
**Bug:** "Backup Database" showed *"Database backup is created"* but never downloaded a file.
**Status:** **FIXED** — the backend now streams a verified SQLite snapshot and the browser saves it.

---

## 1. Root cause (traced end to end)

| Step | Before | Problem |
|---|---|---|
| Mobile More → "Backup database" / Desktop sidebar → "Backup Database" | `POST /api/backup` → `response.json()` → toast/alert with metadata | The response was **JSON**, never a file. Nothing was handed to the browser's download manager. |
| Backend `POST /api/backup` | storage configured → cloud artifacts JSON; serverless w/o storage → 503; local dev → `create_sqlite_snapshot(BACKUP_DIR/backup_*.db)` → JSON `{backup_file}` | The snapshot was created (dev) but **returned only as a path string**, not as an HTTP file response. |
| Secondary bug | — | Even with a file response, `Content-Disposition` was **not in `Access-Control-Expose-Headers`**, so cross-origin JS (5173 → 8010, and any split-origin deploy) could not read the server's filename. |

The success toast was honest about what the *server* did and silent about what the *user* never got.

---

## 2. What changed

### `backend/main.py`
- **`POST /api/backup` rewritten** to return a download:
  - Generates the portable SQLite snapshot (`create_sqlite_snapshot`, unchanged) into `APP_BACKUP_DIR` locally (preserving the old server-side dev copy) or a **transient** `tempfile.TemporaryDirectory()` on serverless.
  - **Verifies before sending:** `PRAGMA integrity_check`, all required tables present, and the `SQLite format 3\0` magic bytes. Failures → HTTP 502 with the reason and **no partial file left behind**.
  - Responds with `Response(media_type="application/octet-stream", headers={"Content-Disposition": 'attachment; filename="embroidery_backup_YYYY-MM-DD_HH-MM-SS.db"', "X-Backup-SHA256": …, "Cache-Control": "no-store"})`.
  - The serverless 503 branch is **gone**: the download needs no Storage credentials and no persistent filesystem, so it works on Vercel. The filename in local dev changed from `backup_*.db` to `embroidery_backup_*.db`.
- **CORS:** `expose_headers=["Content-Disposition", "X-Backup-SHA256"]` added so the frontend can read the real filename cross-origin.
- `create_cloud_backup_artifacts` is unchanged and still reachable via the dedicated `POST /api/cloud-backup` (the separate "Cloud backup" button); `POST /api/restore` and `GET /api/cloud-backup/status` are untouched.

### `frontend/src/App.jsx`
- **`createBackup` rewritten** (shared by the mobile More screen and the desktop sidebar — the desktop inline duplicate that used `window.alert` now calls the same function):
  1. `POST /api/backup`; errors are surfaced from the JSON `detail` (or HTTP status).
  2. Rejects a response that is not `application/octet-stream` or has zero bytes — meaningful error, no fake success.
  3. Reads the filename from `Content-Disposition`; falls back to a locally generated `embroidery_backup_YYYY-MM-DD_HH-MM-SS.db`.
  4. `response.blob()` → `URL.createObjectURL` → temporary `<a download>` click → `URL.revokeObjectURL` in `finally`.
  5. Toast **"Backup downloaded: <file> (N KB)"** fires only after `link.click()`.

### `backend/tests/test_release_hardening.py`
- Replaced the obsolete `503 on serverless` test (that gate no longer exists by design) with four regression tests.
- `re` import added.

### `tests/e2e/backup-download.spec.mjs` (new)
Six browser-level tests covering the whole loop (details below).

No secrets, storage URLs or credentials are exposed: the bytes travel through the authenticated `/api/backup` endpoint; no signed URLs are involved.

---

## 3. Test results

| Suite | Command | Result |
|---|---|---|
| Backend | `cd backend && ../.venv/bin/python -m pytest tests -q` | **160 passed** (was 157: −1 obsolete, +4 new) |
| Frontend unit | `cd frontend && npm test` | **51 passed** |
| Production build | `cd frontend && npm run build` | **PASS** (3.67 s) |
| `npm audit` | | **0 vulnerabilities** |
| E2E (all specs) | `cd tests && node --test --test-concurrency=1 e2e/*.spec.mjs` | **63 passed** (57 prior + 6 new), 0 failed |

### New backend regression tests (all pass)
1. `test_backup_downloads_a_verified_sqlite_file` — 200; `application/octet-stream`; `attachment; filename="embroidery_backup_YYYY-MM-DD_HH-MM-SS.db"`; magic bytes; SHA-256 header matches the body; `integrity_check = ok`; required tables present; the just-created customer row is inside; the dev copy in `APP_BACKUP_DIR` equals the downloaded bytes.
2. `test_backup_works_on_serverless_without_storage_or_persistent_files` — with `IS_SERVERLESS_DEPLOYMENT = True`, still 200 + valid attachment and **zero files** left in the backup dir (Vercel-safe).
3. `test_backup_failure_returns_502_and_leaves_no_partial_file` — simulated snapshot failure → 502 with the reason; no file written.
4. `test_downloaded_backup_round_trips_through_restore` — download → create a marker customer → `POST /api/restore` with the downloaded bytes → marker gone, baseline intact.

### New E2E tests (`tests/e2e/backup-download.spec.mjs`, all pass)
1. Mobile More "Backup database" click produces a **real download** with the server's filename.
2. Desktop sidebar "Backup Database" click produces the same download.
3. Downloaded bytes are a valid SQLite DB (`integrity_check` via the sqlite3 CLI, required tables present).
4. Success toast appears **only after** the download event.
5. The exact downloaded file restores via `/api/restore` (round trip) and no data is lost.
6. The app still works after the restore; no unexpected console/page/request errors.

### Live smoke (local run)
```
POST /api/backup → 200
  content-disposition: attachment; filename="embroidery_backup_2026-11-12_23-13-21.db"
  x-backup-sha256: d376ad63…cbcabca
  access-control-expose-headers: Content-Disposition, X-Backup-SHA256
  188,416 bytes → file(1): "SQLite 3.x database"
```

---

## 4. Notes / limitations

- The downloaded snapshot is the database only (customers, orders, payments, products, rates, templates, transactions, admins). Reference images and drawings live in private Storage and remain covered by the separate **Cloud backup** feature, which is unchanged.
- `/api/restore` still refuses production/serverless restores (409) — unchanged, deliberate.
- Backup download on Vercel streams from Postgres through the function; very large databases should watch the function duration (measured when production data grows).
- Safari/iOS programmatic anchor downloads were not verified on a physical device.
