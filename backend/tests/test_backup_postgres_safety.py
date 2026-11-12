"""Backup-truth regression tests.

Guards the rules introduced by the production backup audit:

* the SQLite artifact produced by /api/backup and /api/cloud-backup is a
  portable data export and must never be labelled a native PostgreSQL backup,
* the cloud backup must fail (502, no completion manifest) when a required
  Storage object is missing, a checksum mismatches, or the manifest cannot be
  stored,
* the admin status endpoint reports masked project refs, the schema version
  and whether native pg_dump artifacts exist,
* PostgreSQL databases must never be restored from a SQLite export.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import os
from pathlib import Path
from typing import Callable

import pytest
from fastapi.testclient import TestClient

from storage import StorageError


def make_client(tmp_path: Path) -> tuple[TestClient, "main"]:  # noqa: F821
    os.environ["APP_ENV"] = "test"
    os.environ["APP_SECRET_KEY"] = "backup-safety-test-key"
    os.environ["ADMIN_INITIAL_PASSWORD"] = "backup-safety-password"
    os.environ["APP_DATA_DIR"] = str(tmp_path / "data")
    os.environ["APP_INVOICE_DIR"] = str(tmp_path / "invoices")
    os.environ["APP_BACKUP_DIR"] = str(tmp_path / "backups")
    # Never point the test engine at PostgreSQL: import-time schema setup must
    # stay on the isolated SQLite database. Tests fake `primary_is_supabase`
    # instead of changing the engine.
    os.environ.pop("SUPABASE_DATABASE_URL", None)
    os.environ.pop("SUPABASE_URL", None)
    os.environ.pop("NEXT_PUBLIC_SUPABASE_URL", None)
    os.environ.pop("SUPABASE_SERVICE_ROLE_KEY", None)
    import main

    module = importlib.reload(main)
    return TestClient(module.app), module


def login(client: TestClient, password: str = "backup-safety-password") -> dict[str, str]:
    response = client.post("/api/login", json={"username": "admin", "password": password})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


class FakeStorage:
    """In-memory stand-in for the private Storage helpers used by main."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.content_types: dict[str, str] = {}
        self.files_listing: list[dict] = []
        self.pg_dump_listing: list[dict] = []
        self.fail_upload_suffix: str | None = None
        self.tamper_keys: set[str] = set()
        self.tamper_all_database_artifacts = False
        self.fail_listing = False
        self.missing_download_keys: set[str] = set()

    def install(self, module, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(module, "storage_is_configured", lambda: True)
        monkeypatch.setattr(module, "storage_verify_private_bucket", lambda bucket, mimes=None: {"public": False})

        def fake_list(bucket: str, prefix: str = "", *, max_objects: int = 5000) -> list[dict]:
            if self.fail_listing:
                raise StorageError("Storage listing exceeded the configured safety limit of 200 objects.")
            if prefix.startswith("pg-dumps"):
                return list(self.pg_dump_listing)
            return list(self.files_listing)

        def fake_upload(bucket: str, key: str, payload: bytes, content_type: str, **kwargs) -> str:
            if self.fail_upload_suffix and key.endswith(self.fail_upload_suffix):
                raise StorageError("Supabase Storage upload failed with HTTP 507.")
            self.objects[key] = bytes(payload)
            self.content_types[key] = content_type
            return key

        def fake_download(bucket: str, key: str) -> bytes:
            if key not in self.objects:
                raise StorageError("Supabase Storage download failed with HTTP 404 for a required object.")
            if key in self.tamper_keys or (self.tamper_all_database_artifacts and key.endswith(".db")):
                # Corrupt the payload without changing its length so the
                # size check passes and the SHA-256 check is what catches it.
                payload = self.objects[key]
                return bytes([payload[0] ^ 0xFF]) + payload[1:]
            return self.objects[key]

        def fake_upload_file(bucket: str, key: str, file_path: str, content_type: str, **kwargs) -> str:
            with open(file_path, "rb") as source:
                return fake_upload(bucket, key, source.read(), content_type)

        def fake_stream(bucket: str, key: str, sink: Callable[[bytes], None], **kwargs) -> int:
            payload = fake_download(bucket, key)
            sink(payload)
            return len(payload)

        def fake_download_file(bucket: str, key: str, destination: str, **kwargs) -> int:
            payload = fake_download(bucket, key)
            with open(destination, "wb") as target:
                target.write(payload)
            return len(payload)

        monkeypatch.setattr(module, "storage_list_objects", fake_list)
        monkeypatch.setattr(module, "storage_upload_bytes", fake_upload)
        monkeypatch.setattr(module, "storage_download_bytes", fake_download)
        monkeypatch.setattr(module, "storage_upload_file_streaming", fake_upload_file)
        monkeypatch.setattr(module, "storage_stream_download", fake_stream)
        monkeypatch.setattr(module, "storage_download_file_streaming", fake_download_file)

    def database_key(self, backup_id: str) -> str | None:
        matches = [key for key in self.objects if key.startswith("database/") and backup_id in key]
        return matches[0] if matches else None

    def manifest_key(self, backup_id: str) -> str | None:
        matches = [key for key in self.objects if key.startswith("manifests/") and backup_id in key]
        return matches[0] if matches else None

    def manifest(self, backup_id: str) -> dict:
        key = self.manifest_key(backup_id)
        assert key, "completion manifest was not uploaded"
        return json.loads(self.objects[key])


def add_order_with_object_key(module, key: str | None) -> None:
    """Insert one customer + order directly so backup completeness is exercised."""
    Customer, Order = module.Customer, module.Order

    with module.SessionLocal() as session:
        customer = Customer(name="Backup Object Probe", phone=f"9{os.urandom(5).hex()}")
        session.add(customer)
        session.flush()
        order = Order(customer_id=customer.id, total_amount=100.0)
        if key:
            order.drawing_object_key = key
        session.add(order)
        session.commit()


def test_cloud_backup_records_sqlite_export_truthfully(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, module = make_client(tmp_path)
    fake = FakeStorage()
    fake.install(module, monkeypatch)
    headers = login(client)

    response = client.post("/api/cloud-backup", headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok"
    assert body["backup_format"] == "sqlite-export"
    assert body["complete_backup"] is False
    assert body["database_engine"] == "sqlite"
    assert body["schema_version"] == module.SCHEMA_VERSION
    assert body["verification_status"] == "verified"

    manifest = fake.manifest(body["backup_id"])
    assert manifest["kind"] == "data-export-and-file-copy"
    assert manifest["complete_backup"] is False
    assert manifest["schema_version"] == module.SCHEMA_VERSION
    assert manifest["database"]["backup_format"] == "sqlite-export"
    assert manifest["database"]["source_engine"] == "sqlite"
    assert any("pg_backup.py" in line for line in manifest["limitations"])
    artifact_key = fake.database_key(body["backup_id"])
    assert artifact_key, "database artifact was not uploaded"
    artifact = fake.objects[artifact_key]
    assert manifest["database"]["size_bytes"] == len(artifact)
    assert manifest["database"]["sha256"] == hashlib.sha256(artifact).hexdigest()
    assert manifest["verification_status"] == "verified"


def test_cloud_backup_fails_when_a_required_object_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, module = make_client(tmp_path)
    fake = FakeStorage()
    fake.install(module, monkeypatch)
    headers = login(client)
    add_order_with_object_key(module, "orders/drawing/missing-object.png")

    response = client.post("/api/cloud-backup", headers=headers)
    assert response.status_code == 502
    assert "missing from the files bucket" in response.json()["detail"]
    # Failure must leave no completion manifest behind.
    assert not [key for key in fake.objects if key.startswith("manifests/")]


def test_cloud_backup_copies_all_required_objects(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, module = make_client(tmp_path)
    fake = FakeStorage()
    fake.install(module, monkeypatch)
    headers = login(client)
    fake.files_listing = [{
        "key": "orders/drawing/present-object.png",
        "metadata": {"mimetype": "image/png"},
    }]
    # The fake listing only describes the bucket; the object content itself
    # must exist for the copy step to download it.
    fake.objects["orders/drawing/present-object.png"] = b"png-bytes"
    add_order_with_object_key(module, "orders/drawing/present-object.png")

    response = client.post("/api/cloud-backup", headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["file_object_count"] == 1
    manifest = fake.manifest(body["backup_id"])
    assert manifest["required_object_count"] == 1
    copied = manifest["file_objects"][0]
    stored = fake.objects[copied["backup_key"]]
    assert copied["sha256"] == hashlib.sha256(stored).hexdigest()
    assert copied["content_type"] == "image/png"
    assert copied["source_key"] == "orders/drawing/present-object.png"


def test_cloud_backup_fails_on_checksum_mismatch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, module = make_client(tmp_path)
    fake = FakeStorage()
    fake.install(module, monkeypatch)
    headers = login(client)
    # The read-back of the stored database artifact will come back tampered.
    fake.tamper_all_database_artifacts = True

    response = client.post("/api/cloud-backup", headers=headers)
    assert response.status_code == 502
    assert "SHA-256" in response.json()["detail"]
    assert not [key for key in fake.objects if key.startswith("manifests/")]


def test_cloud_backup_fails_when_manifest_upload_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, module = make_client(tmp_path)
    fake = FakeStorage()
    fake.install(module, monkeypatch)
    fake.fail_upload_suffix = ".json"
    headers = login(client)

    response = client.post("/api/cloud-backup", headers=headers)
    assert response.status_code == 502, response.text
    assert "did not complete" in response.json()["detail"]
    assert not [key for key in fake.objects if key.startswith("manifests/")]


def test_cloud_backup_fails_when_object_listing_is_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, module = make_client(tmp_path)
    fake = FakeStorage()
    fake.install(module, monkeypatch)
    fake.fail_listing = True
    headers = login(client)

    response = client.post("/api/cloud-backup", headers=headers)
    assert response.status_code == 502
    assert not [key for key in fake.objects if key.startswith("manifests/")]


def test_backup_download_scope_header_for_sqlite_primary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, module = make_client(tmp_path)
    headers = login(client)

    response = client.post("/api/backup", headers=headers)
    assert response.status_code == 200
    assert response.headers["x-backup-scope"] == "full-sqlite-database"
    assert response.headers["content-type"].startswith("application/octet-stream")
    assert "attachment" in response.headers["content-disposition"]


def test_backup_download_scope_header_for_postgres_primary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, module = make_client(tmp_path)
    monkeypatch.setattr(module, "primary_is_supabase", lambda: True)
    headers = login(client)

    response = client.post("/api/backup", headers=headers)
    assert response.status_code == 200
    assert response.headers["x-backup-scope"] == "portable-data-export"
    # Still a download; the scope header carries the truth about completeness.
    assert response.headers["content-type"].startswith("application/octet-stream")
    assert "attachment" in response.headers["content-disposition"]


def test_restore_refused_when_primary_is_postgres(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, module = make_client(tmp_path)
    monkeypatch.setattr(module, "primary_is_supabase", lambda: True)
    headers = login(client)

    response = client.post(
        "/api/restore",
        headers=headers,
        files={"file": ("embroidery_backup_x.db", b"SQLite format 3\x00" + b"\x00" * 64, "application/octet-stream")},
    )
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "PostgreSQL" in detail
    assert "SQLite" in detail


def test_restore_still_works_for_local_sqlite_primary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, module = make_client(tmp_path)
    headers = login(client)

    created = client.post("/api/customers", headers=headers, json={
        "name": "Restore Marker", "phone": f"9{os.urandom(5).hex()}",
    })
    assert created.status_code == 200
    snapshot = client.post("/api/backup", headers=headers).content
    response = client.post(
        "/api/restore",
        headers=headers,
        files={"file": ("embroidery_backup_local.db", snapshot, "application/octet-stream")},
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "restored"


def test_status_reports_masked_refs_schema_version_and_native_dump(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, module = make_client(tmp_path)
    # Set after make_client: the module is reloaded there, and the status
    # endpoint reads the env at request time.
    os.environ["SUPABASE_URL"] = "https://abcdefghij.supabase.co"
    try:
        fake = FakeStorage()
        fake.install(module, monkeypatch)
        fake.pg_dump_listing = [{
            "key": "pg-dumps/2026-11-12/20261112T021500-ab12cd34.dump",
        }]
        headers = login(client)

        response = client.get("/api/cloud-backup/status", headers=headers)
        assert response.status_code == 200
        body = response.json()
        assert body["database_backup_format"] == "sqlite-export"
        assert body["native_postgres_dump_present"] is True
        assert body["complete_backup_available"] is True
        assert body["latest_pg_dump_object"].endswith(".dump")
        assert body["schema_version"] == module.SCHEMA_VERSION
        # The project ref must be masked, never the full host.
        assert body["database_project_ref"] == "abcd••••10"
        assert body["files_project_ref"] == "abcd••••10"
        assert "abcdefghij" not in (body["database_project_ref"] or "")
        assert body["production_restore_enabled"] is False
        assert body["restore_available"] is True  # local SQLite primary, local dev
        assert body["backup_guidance"]
    finally:
        os.environ.pop("SUPABASE_URL", None)


def test_status_treats_pg_listing_errors_as_unknown(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, module = make_client(tmp_path)
    monkeypatch.setattr(module, "storage_is_configured", lambda: True)

    def broken_list(bucket: str, prefix: str = "", *, max_objects: int = 5000) -> list[dict]:
        raise StorageError("Supabase Storage listing failed with HTTP 500.")

    monkeypatch.setattr(module, "storage_list_objects", broken_list)
    headers = login(client)

    response = client.get("/api/cloud-backup/status", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["native_postgres_dump_present"] is None  # unknown, never a silent "yes"
    assert body["complete_backup_available"] is False


def test_masked_project_ref_never_leaks_the_ref() -> None:
    from main import masked_project_ref

    assert masked_project_ref("https://abcdefghij.supabase.co") == "abcd••••10"
    assert masked_project_ref("https://abc.supabase.co") == "abc••••"
    assert masked_project_ref("") is None
    assert masked_project_ref(None) is None
