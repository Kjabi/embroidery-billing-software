#!/usr/bin/env python3
"""Native PostgreSQL backup for the Supabase database, using pg_dump.

This script is the ONLY supported way to produce a complete production
database backup. It must run outside Vercel Functions (operator machine, CI
job, or scheduled runner) because Vercel Functions do not ship pg_dump and
cannot keep large artifacts on disk.

What it does:
  1. Refuses to run unless pg_dump and the required credentials exist.
  2. Runs pg_dump in -Fc (custom) format — the dump preserves schema,
     constraints, indexes, sequences, extensions metadata and relationships,
     and streams to a file on local disk (never buffered into RAM).
  3. Uploads the dump to the private backup bucket with a streaming HTTP
     upload (O(chunk) memory).
  4. Streams the stored object back and verifies size + SHA-256.
  5. Uploads a completion manifest with backup ID, timestamp, engine, actual
     backup format, schema version, size, checksums and verification status.

It never prints credentials: URLs are masked in every log line and in errors.

Required environment:
  SUPABASE_DATABASE_URL   postgres connection URL (postgresql://...)
  SUPABASE_URL            Supabase project URL (for private Storage)
  SUPABASE_SERVICE_ROLE_KEY  service key for the private Storage bucket
  PG_DUMP_BIN             optional: explicit path to pg_dump (else PATH)
  SUPABASE_BACKUP_BUCKET  optional: defaults to lalithas-backups
  APP_SCHEMA_VERSION      optional: override the schema stamp

Example cron entry (daily 02:15 local):
  15 2 * * *  /usr/bin/env python3 /srv/app/backend/scripts/pg_backup.py >> /srv/app/backups/pg_backup.log 2>&1

Manual run:
  python3 backend/scripts/pg_backup.py                # dump + upload + verify
  PG_BACKUP_ALSO_SAVE=~/dumps/local-copy.dump python3 backend/scripts/pg_backup.py
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import storage  # noqa: E402  (backend package lives next to scripts/)
from storage import StorageError  # noqa: E402  (bound at import so CLI error handling stays real)

BACKUP_BUCKET = os.getenv("SUPABASE_BACKUP_BUCKET", "lalithas-backups")
PG_DUMP_OBJECT_PREFIX = "pg-dumps/"


class BackupScriptError(RuntimeError):
    """Fatal, already-sanitized script error."""


def mask_database_url(url: str) -> str:
    """Return a log-safe version of a database URL: password and path removed."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return "postgres://<masked>"
    if not parts.scheme:
        return "postgres://<masked>"
    host = parts.hostname or "<masked-host>"
    port = f":{parts.port}" if parts.port else ""
    return f"{parts.scheme}://{parts.username or '<user>'}:***@{host}{port}/<masked-database>"


def masked_project_ref(url: str) -> str:
    """Identify a Supabase project without exposing credentials."""
    try:
        host = urlsplit(url).hostname or ""
    except ValueError:
        return "masked"
    ref = host.split(".")[0] if host else ""
    if not ref:
        return "masked"
    return f"{ref[:4]}••••{len(ref)}" if len(ref) > 4 else f"{ref}••••"


def resolve_conninfo(database_url: str) -> str:
    """Prepare the connection URL pg_dump should use.

    Supabase's transaction pooler (port 6543) cannot serve pg_dump's session;
    the direct connection (db.<ref>.supabase.co:5432) or the session pooler
    (5432) can. Rewrite a 6543 URL to 5432 and force SSL.
    """
    try:
        parts = urlsplit(database_url)
    except ValueError as exc:
        raise BackupScriptError("SUPABASE_DATABASE_URL is not a valid URL.") from exc
    if parts.scheme not in {"postgresql", "postgres"}:
        raise BackupScriptError(
            "SUPABASE_DATABASE_URL must be a postgres:// or postgresql:// URL "
            "(not the SQLAlchemy postgresql+psycopg:// form)."
        )
    rewritten = urlunsplit((
        "postgresql",
        parts.netloc.replace(":6543", ":5432") if ":6543" in parts.netloc else parts.netloc,
        parts.path,
        parts.query,
        parts.fragment,
    ))
    # pg_dump must not prompt; credentials come from the URL itself.
    if "sslmode=" not in rewritten:
        separator = "&" if "?" in rewritten else "?"
        rewritten = f"{rewritten}{separator}sslmode=require"
    return rewritten


def require_pg_dump() -> str:
    """Locate pg_dump or refuse to run — never substitute a row-copy export."""
    candidate = os.getenv("PG_DUMP_BIN", "").strip() or shutil.which("pg_dump")
    if not candidate:
        raise BackupScriptError(
            "pg_dump was not found. A native PostgreSQL backup requires the real pg_dump binary "
            "(install PostgreSQL client tools or set PG_DUMP_BIN). This script will not fall back "
            "to a SQLite data export, which cannot represent the full database."
        )
    if not os.path.isfile(candidate) and not shutil.which(candidate):
        raise BackupScriptError(f"PG_DUMP_BIN={candidate!r} does not point to an executable pg_dump.")
    return candidate


def pg_dump_version(pg_dump_bin: str) -> str:
    try:
        completed = subprocess.run([pg_dump_bin, "--version"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BackupScriptError(f"Could not execute pg_dump: {exc}") from exc
    if completed.returncode != 0:
        raise BackupScriptError("pg_dump --version failed.")
    return completed.stdout.strip().splitlines()[0]


def run_pg_dump(pg_dump_bin: str, conninfo: str, destination: str) -> None:
    """Run pg_dump into destination file; never log or leak the conninfo."""
    command = [
        pg_dump_bin,
        "--format=custom",           # -Fc: compressed, restorable with pg_restore
        "--no-owner",                # dump must restore cleanly under another role
        "--no-privileges",           # do not attempt to reproduce GRANT owners
        "--file", destination,
        "--dbname", conninfo,
    ]
    environment = dict(os.environ, PGSSLMODE=os.environ.get("PGSSLMODE", "require"))
    try:
        completed = subprocess.run(
            command, capture_output=True, text=True, timeout=int(os.getenv("PG_DUMP_TIMEOUT_SECONDS", "7200")),
            env=environment,
        )
    except subprocess.TimeoutExpired as exc:
        raise BackupScriptError("pg_dump timed out; no backup was uploaded.") from exc
    except OSError as exc:
        raise BackupScriptError(f"Could not execute pg_dump: {exc}") from exc
    if completed.returncode != 0:
        stderr = completed.stderr or ""
        for line in stderr.splitlines():
            # The connection URL must never reach a log file.
            if conninfo in line:
                line = line.replace(conninfo, mask_database_url(conninfo))
            print(f"pg_dump: {line}", file=sys.stderr)
        raise BackupScriptError("pg_dump failed; no backup was uploaded.")


def file_sha256(path: str, chunk_size: int = 1024 * 1024) -> tuple[int, str]:
    """Hash a file in bounded memory; returns (size, sha256)."""
    hasher = hashlib.sha256()
    size = 0
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(chunk_size), b""):
            hasher.update(chunk)
            size += len(chunk)
    return size, hasher.hexdigest()


def build_manifest(
    *,
    backup_id: str,
    created_at: str,
    schema_version: str,
    dump_bucket: str,
    dump_key: str,
    size_bytes: int,
    sha256: str,
    pg_dump_version_str: str,
    database_url: str,
) -> dict:
    """Completion manifest for a native pg_dump backup."""
    return {
        "brand": "Lalitha's Apparel",
        "backup_id": backup_id,
        "created_at": created_at,
        "kind": "native-postgres-dump",
        "complete_backup": True,
        "schema_version": schema_version,
        "database": {
            "engine": "supabase-postgres",
            "backup_format": "pg_dump-custom",
            "preserves": ["schema", "constraints", "indexes", "sequences", "functions", "relationships"],
            "project_ref": masked_project_ref(database_url),
            "connection": mask_database_url(database_url),
        },
        "artifact": {
            "bucket": dump_bucket,
            "object_key": dump_key,
            "size_bytes": size_bytes,
            "sha256": sha256,
        },
        "verification": {
            "uploaded_sha256_verified": True,
            "uploaded_size_verified": True,
            "method": "streamed read-back of the stored object",
        },
        "restore": {
            "tool": "pg_restore",
            "command_template": (
                "pg_restore --no-owner --no-privileges --clean --if-exists "
                "--dbname <TARGET_DATABASE_URL> <downloaded-dump-file>"
            ),
            "target": "staging project only; see PRODUCTION_BACKUP_RESTORE_RUNBOOK.md",
        },
        "produced_by": f"backend/scripts/pg_backup.py ({pg_dump_version_str})",
    }


def main() -> int:
    database_url = os.getenv("SUPABASE_DATABASE_URL", "").strip()
    if not database_url:
        raise BackupScriptError("SUPABASE_DATABASE_URL is required and was not set.")
    if not storage.is_configured():
        raise BackupScriptError(
            "Supabase Storage is not configured; set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY "
            "so the dump can be stored in the private backup bucket."
        )
    if not os.getenv("SUPABASE_DATABASE_URL", "").startswith(("postgresql://", "postgres://")):
        raise BackupScriptError(
            "SUPABASE_DATABASE_URL must be the plain postgres URL for this script "
            "(strip the SQLAlchemy postgresql+psycopg:// prefix)."
        )

    pg_dump_bin = require_pg_dump()
    version_line = pg_dump_version(pg_dump_bin)
    conninfo = resolve_conninfo(database_url)
    schema_version = os.getenv("APP_SCHEMA_VERSION", "").strip() or _schema_version()

    created_at = datetime.now()
    day = created_at.date().isoformat()
    backup_id = f"{created_at.strftime('%Y%m%dT%H%M%S')}-{os.urandom(4).hex()}"
    dump_key = f"{PG_DUMP_OBJECT_PREFIX}{day}/{backup_id}.dump"
    manifest_key = f"manifests/{day}/{backup_id}-pgdump.json"
    print(f"[pg-backup] starting native PostgreSQL backup {backup_id} (schema {schema_version}, {version_line})")

    with tempfile.TemporaryDirectory(prefix="lalithas-pg-backup-") as temp_dir:
        dump_path = os.path.join(temp_dir, f"{backup_id}.dump")
        run_pg_dump(pg_dump_bin, conninfo, dump_path)
        dump_size, dump_sha256 = file_sha256(dump_path)
        print(f"[pg-backup] pg_dump complete: {dump_size} bytes, sha256 {dump_sha256}")
        if dump_size <= 1_024:
            raise BackupScriptError("pg_dump produced a suspiciously small dump; refusing to upload it.")

        also_save = os.getenv("PG_BACKUP_ALSO_SAVE", "").strip()
        if also_save:
            os.makedirs(os.path.dirname(os.path.abspath(also_save)), exist_ok=True)
            shutil.copyfile(dump_path, also_save)
            print(f"[pg-backup] kept a local copy at {also_save}")

        storage.upload_file_streaming(BACKUP_BUCKET, dump_key, dump_path, "application/octet-stream")
        print(f"[pg-backup] uploaded to {BACKUP_BUCKET}/{dump_key}")

        readback_size, readback_sha = stream_readback_sha256(BACKUP_BUCKET, dump_key)
        if (readback_size, readback_sha) != (dump_size, dump_sha256):
            raise BackupScriptError(
                "Stored dump failed size/SHA-256 verification after upload; treating the backup as failed."
            )
        print("[pg-backup] stored object verified: size and SHA-256 match")

        manifest = build_manifest(
            backup_id=backup_id,
            created_at=created_at.isoformat(timespec="seconds"),
            schema_version=schema_version,
            dump_bucket=BACKUP_BUCKET,
            dump_key=dump_key,
            size_bytes=dump_size,
            sha256=dump_sha256,
            pg_dump_version_str=version_line,
            database_url=database_url,
        )
        manifest_bytes = json.dumps(manifest, indent=2, sort_keys=True).encode("utf-8")
        storage.upload_bytes(BACKUP_BUCKET, manifest_key, manifest_bytes, "application/json")
        manifest_size, manifest_sha = stream_readback_sha256(BACKUP_BUCKET, manifest_key)
        if manifest_sha != hashlib.sha256(manifest_bytes).hexdigest():
            raise BackupScriptError("Uploaded manifest failed SHA-256 verification.")
        print(f"[pg-backup] manifest uploaded to {BACKUP_BUCKET}/{manifest_key}")
        print(f"[pg-backup] done: complete native PostgreSQL backup verified ({manifest_size} byte manifest)")

    return 0


def stream_readback_sha256(bucket: str, key: str) -> tuple[int, str]:
    hasher = hashlib.sha256()
    total = storage.stream_download(bucket, key, hasher.update)
    return total, hasher.hexdigest()


def _schema_version() -> str:
    override = os.getenv("APP_SCHEMA_VERSION", "").strip()
    if override:
        return override
    try:
        migration_files = sorted((BACKEND_DIR / "migrations").glob("0*.sql"))
        if migration_files:
            return migration_files[-1].stem
    except OSError:
        pass
    return "unknown"


def cli() -> int:
    """Entry point that maps sanitized errors to exit code 1 (no tracebacks)."""
    try:
        return main()
    except BackupScriptError as error:
        # The message is sanitized at raise time; never print a traceback that
        # could contain connection details.
        print(f"[pg-backup] error: {error}", file=sys.stderr)
        return 1
    except StorageError as error:
        print(f"[pg-backup] error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(cli())
