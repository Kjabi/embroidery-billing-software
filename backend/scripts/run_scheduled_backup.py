"""Scheduled private Supabase backup entrypoint (safe to run from GitHub Actions)."""
from __future__ import annotations

import json
import os
import secrets
import sys
from pathlib import Path

os.environ["APP_ENV"] = "production"
if not os.environ.get("APP_SECRET_KEY"):
    os.environ["APP_SECRET_KEY"] = secrets.token_urlsafe(48)
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main  # noqa: E402
from storage import StorageError, verify_private_bucket  # noqa: E402


def run() -> dict:
    verify_private_bucket(main.SUPABASE_FILES_BUCKET, {"image/png", "application/pdf"})
    verify_private_bucket(
        main.SUPABASE_BACKUP_BUCKET,
        {"application/octet-stream", "application/json", "image/png", "application/pdf"},
    )
    with main.SessionLocal() as db:
        return main.create_cloud_backup_artifacts(db)


if __name__ == "__main__":
    try:
        result = run()
        # Print keys/counts only; never expose environment variables or customer records.
        print(json.dumps(result, indent=2, sort_keys=True))
    except Exception as exc:
        print(f"Scheduled backup failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
