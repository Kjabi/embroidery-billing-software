"""Unit tests for the native PostgreSQL backup script (backend/scripts/pg_backup.py).

pg_dump itself is not exercised here: the test environment has no PostgreSQL
server. What IS covered is everything that protects correctness and secrets:
credential masking, pooler connection rewriting, the refusal to run without a
real pg_dump binary, manifest completeness, and end-to-end success/failure
behaviour with a fake storage module and a stubbed pg_dump process.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

from storage import StorageError


def load_script() -> "module":  # noqa: F821
    """Import backend/scripts/pg_backup.py as a module."""
    path = Path(__file__).resolve().parents[1] / "scripts" / "pg_backup.py"
    spec = importlib.util.spec_from_file_location("pg_backup_test_module", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["pg_backup_test_module"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def script() -> "module":  # noqa: F821
    return load_script()


SECRET_URL = "postgresql://postgres:supersecret@db.projsupabase.supabase.co:5432/postgres"


def test_mask_database_url_never_reveals_the_password(script) -> None:
    masked = script.mask_database_url(SECRET_URL)
    assert "supersecret" not in masked
    assert "projsupabase" in masked  # host stays identifiable, credential does not
    assert "postgres" not in masked.split("***@")[1]  # database name masked too


def test_masked_project_ref_masks_the_ref(script) -> None:
    masked = script.masked_project_ref("https://abcdefghij.supabase.co")
    assert masked == "abcd••••10"
    assert "abcdefghij" not in masked


def test_resolve_conninfo_rewrites_transaction_pooler_port(script) -> None:
    pooler = "postgresql://postgres.projref:pw@aws-0-eu.pooler.supabase.com:6543/postgres"
    conninfo = script.resolve_conninfo(pooler)
    assert ":5432" in conninfo
    assert ":6543" not in conninfo
    assert "sslmode=require" in conninfo
    assert "pw" in conninfo  # the URL itself must still carry credentials for pg_dump


def test_resolve_conninfo_rejects_sqlalchemy_url(script) -> None:
    with pytest.raises(script.BackupScriptError):
        script.resolve_conninfo("postgresql+psycopg://user:pw@host:5432/db")


def test_require_pg_dump_refuses_without_a_binary(script, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PG_DUMP_BIN", raising=False)
    monkeypatch.setattr(script.shutil, "which", lambda _: None)
    with pytest.raises(script.BackupScriptError) as excinfo:
        script.require_pg_dump()
    message = str(excinfo.value)
    assert "pg_dump" in message
    assert SECRET_URL not in message  # credential never appears in the refusal


def test_require_pg_dump_prefers_pg_dump_bin(script, monkeypatch: pytest.MonkeyPatch) -> None:
    stub = str(Path(__file__).with_name("fake-pg-dump"))
    monkeypatch.setenv("PG_DUMP_BIN", stub)
    monkeypatch.setattr(script.os.path, "isfile", lambda path: path == stub)
    assert script.require_pg_dump() == stub


def test_build_manifest_is_complete_and_honest(script) -> None:
    manifest = script.build_manifest(
        backup_id="20261112T021500-ab12cd34",
        created_at="2026-11-12T02:15:00",
        schema_version="0004_read_path_indexes",
        dump_bucket="lalithas-backups",
        dump_key="pg-dumps/2026-11-12/20261112T021500-ab12cd34.dump",
        size_bytes=1024,
        sha256="a" * 64,
        pg_dump_version_str="pg_dump (PostgreSQL) 16.4",
        database_url=SECRET_URL,
    )
    assert manifest["kind"] == "native-postgres-dump"
    assert manifest["complete_backup"] is True
    assert manifest["schema_version"] == "0004_read_path_indexes"
    assert manifest["database"]["backup_format"] == "pg_dump-custom"
    assert manifest["database"]["engine"] == "supabase-postgres"
    assert "supersecret" not in json.dumps(manifest)
    assert manifest["artifact"]["size_bytes"] == 1024
    assert manifest["artifact"]["sha256"] == "a" * 64
    assert manifest["verification"]["uploaded_sha256_verified"] is True
    assert manifest["restore"]["tool"] == "pg_restore"
    assert "staging" in manifest["restore"]["target"]


class FakeStorageModule:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.configured = True
        self.fail_upload = False

    def is_configured(self) -> bool:
        return self.configured

    def upload_file_streaming(self, bucket: str, key: str, file_path: str, content_type: str, **kwargs) -> str:
        if self.fail_upload:
            raise StorageError("Supabase Storage upload failed with HTTP 507.")
        with open(file_path, "rb") as source:
            self.objects[key] = source.read()
        return key

    def upload_bytes(self, bucket: str, key: str, payload: bytes, content_type: str, **kwargs) -> str:
        self.objects[key] = bytes(payload)
        return key

    def stream_download(self, bucket: str, key: str, sink, **kwargs) -> int:
        payload = self.objects[key]
        sink(payload)
        return len(payload)


def run_main(script, monkeypatch: pytest.MonkeyPatch, fake_storage: FakeStorageModule, pg_dump_stub: str) -> int:
    """Invoke the script's CLI exactly as an operator would (exit-code semantics)."""
    monkeypatch.setenv("SUPABASE_DATABASE_URL", SECRET_URL)
    monkeypatch.setenv("SUPABASE_URL", "https://abcdefghij.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-key")
    monkeypatch.delenv("PG_BACKUP_ALSO_SAVE", raising=False)
    monkeypatch.setattr(script, "storage", fake_storage)
    monkeypatch.setattr(script.shutil, "which", lambda name: pg_dump_stub)
    return script.cli()


def test_main_succeeds_with_stubbed_pg_dump_and_uploads_verified_manifest(
    script, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys
) -> None:
    dump_payload = b"PGDMP" + os.urandom(2048)
    dump_path = tmp_path / "pg_dump-stub"

    def stub_pg_dump(args, **kwargs):  # mimics the real pg_dump CLI contract
        assert "--format=custom" in args
        assert "--no-owner" in args and "--no-privileges" in args
        destination = args[args.index("--file") + 1]
        with open(destination, "wb") as target:
            target.write(dump_payload)
        assert "supersecret" in args[args.index("--dbname") + 1]  # pg_dump gets real creds
        return __import__("subprocess").CompletedProcess(args, 0, stdout="", stderr="")

    monkeypatch.setattr(script.subprocess, "run", stub_pg_dump)
    monkeypatch.setattr(script, "pg_dump_version", lambda _: "pg_dump (PostgreSQL) 16.4 stub")

    fake = FakeStorageModule()
    exit_code = run_main(script, monkeypatch, fake, str(dump_path))
    assert exit_code == 0

    output = capsys.readouterr().out
    assert "supersecret" not in output, "credentials must never be printed"
    dumps = [key for key in fake.objects if key.startswith("pg-dumps/")]
    manifests = [key for key in fake.objects if key.endswith("-pgdump.json")]
    assert len(dumps) == 1 and len(manifests) == 1
    stored = fake.objects[dumps[0]]
    assert stored == dump_payload
    assert hashlib.sha256(stored).hexdigest() in json.dumps(
        json.loads(fake.objects[manifests[0]])
    )


def test_main_fails_and_uploads_nothing_when_pg_dump_fails(
    script, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys
) -> None:
    def failing_pg_dump(args, **kwargs):
        import subprocess
        return subprocess.CompletedProcess(args, 1, stdout="", stderr="pg_dump: error: connection refused")

    monkeypatch.setattr(script.subprocess, "run", failing_pg_dump)
    monkeypatch.setattr(script, "pg_dump_version", lambda _: "stub")

    fake = FakeStorageModule()
    assert run_main(script, monkeypatch, fake, str(tmp_path / "pg_dump-stub")) == 1
    assert fake.objects == {}, "a failed dump must never upload anything"
    output = capsys.readouterr()
    assert "supersecret" not in output.out + output.err
    assert "connection refused" in output.err  # the sanitized stderr is still useful


def test_main_refuses_without_pg_dump(script, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SUPABASE_DATABASE_URL", SECRET_URL)
    monkeypatch.setattr(script, "storage", FakeStorageModule())
    monkeypatch.delenv("PG_DUMP_BIN", raising=False)
    monkeypatch.setattr(script.shutil, "which", lambda _: None)
    assert run_main(script, monkeypatch, FakeStorageModule(), "unused") == 1


def test_main_refuses_to_upload_a_suspiciously_small_dump(
    script, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def tiny_pg_dump(args, **kwargs):
        import subprocess
        destination = args[args.index("--file") + 1]
        with open(destination, "wb") as target:
            target.write(b"PGDMP")
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

    monkeypatch.setattr(script.subprocess, "run", tiny_pg_dump)
    monkeypatch.setattr(script, "pg_dump_version", lambda _: "stub")
    fake = FakeStorageModule()
    assert run_main(script, monkeypatch, fake, str(tmp_path / "pg_dump-stub")) == 1
    assert fake.objects == {}


def test_main_refuses_when_storage_upload_fails(
    script, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys
) -> None:
    dump_payload = b"PGDMP" + os.urandom(2048)

    def stub_pg_dump(args, **kwargs):
        import subprocess
        destination = args[args.index("--file") + 1]
        with open(destination, "wb") as target:
            target.write(dump_payload)
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

    monkeypatch.setattr(script.subprocess, "run", stub_pg_dump)
    monkeypatch.setattr(script, "pg_dump_version", lambda _: "stub")
    fake = FakeStorageModule()
    fake.fail_upload = True
    assert run_main(script, monkeypatch, fake, str(tmp_path / "pg_dump-stub")) == 1
    assert fake.objects == {}
    assert "supersecret" not in capsys.readouterr().err


def test_file_sha256_matches_reference_implementation(script, tmp_path: Path) -> None:
    payload = os.urandom(5000)
    path = tmp_path / "artifact.bin"
    path.write_bytes(payload)
    size, digest = script.file_sha256(str(path))
    assert size == len(payload)
    assert digest == hashlib.sha256(payload).hexdigest()
