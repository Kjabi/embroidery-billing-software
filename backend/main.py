import os
from contextlib import asynccontextmanager
import base64
import binascii
import csv
import hashlib
import hmac
import io
import json
import math
import re
import sqlite3
import tempfile
import threading
import time
import secrets
from collections import defaultdict, deque
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from datetime import datetime, date
from types import SimpleNamespace
from typing import List, Optional
from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Request, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel
from storage import (
    StorageError, is_configured as storage_is_configured, upload_bytes as storage_upload_bytes,
    download_bytes as storage_download_bytes, delete_object as storage_delete_object,
    list_objects as storage_list_objects, verify_private_bucket as storage_verify_private_bucket,
)
from sqlalchemy import (
    create_engine, Column, Integer, String, Float, Boolean, Text, ForeignKey, inspect, text, event
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import declarative_base, sessionmaker, Session, relationship

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from PIL import Image
from business_time import business_today, business_now
import voice_config
from voice_agent import apply_draft_patch, cancel as cancel_voice, execute_confirmation, handle_turn
from voice_providers import VoiceProviderError, audio_duration_seconds, transcribe_audio
from voice_schemas import (
    VoiceCancelRequest,
    VoiceConfirmRequest,
    VoiceDraftPatch,
    VoiceTurnRequest,
    VoiceTurnResponse,
)
from voice_state import conversation_store
from voice_tools import VoiceOperationError

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.getenv("APP_DATA_DIR", os.path.join(BASE_DIR, "data"))
BACKUP_DIR = os.getenv("APP_BACKUP_DIR", os.path.join(BASE_DIR, "backups"))
LOGO_PATH = os.path.join(BASE_DIR, "assets", "lalithas-apparel-logo.png")
SUPABASE_BACKUP_BUCKET = os.getenv("SUPABASE_BACKUP_BUCKET", "lalithas-backups")
SUPABASE_FILES_BUCKET = os.getenv("SUPABASE_FILES_BUCKET", "lalithas-files")
APP_ENV = os.getenv("APP_ENV", "development").lower()
IS_SERVERLESS_DEPLOYMENT = APP_ENV == "production" or os.getenv("VERCEL", "").lower() not in {"", "0", "false"}
APP_SECRET_KEY = os.getenv("APP_SECRET_KEY", "")
if not APP_SECRET_KEY:
    if IS_SERVERLESS_DEPLOYMENT:
        raise RuntimeError("APP_SECRET_KEY must be configured in production.")
    APP_SECRET_KEY = secrets.token_urlsafe(48)
FRONTEND_ORIGINS = [
    origin.strip() for origin in os.getenv("FRONTEND_ORIGIN", "http://localhost:5173").split(",") if origin.strip()
]
TOKEN_TTL_SECONDS = int(os.getenv("TOKEN_TTL_SECONDS", "28800"))
MAX_REFERENCE_IMAGE_BYTES = 5 * 1024 * 1024
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_FAILURES = 5
_login_attempts: dict[str, deque[float]] = defaultdict(deque)
_login_attempts_lock = threading.Lock()
VOICE_MAX_UPLOAD_BYTES = int(os.getenv("VOICE_MAX_UPLOAD_MB", "10")) * 1024 * 1024
VOICE_MAX_DURATION_SECONDS = int(os.getenv("VOICE_MAX_DURATION_SECONDS", "60"))
VOICE_RATE_WINDOW_SECONDS = int(os.getenv("VOICE_RATE_WINDOW_SECONDS", "600"))
VOICE_MAX_REQUESTS_PER_WINDOW = int(os.getenv("VOICE_MAX_REQUESTS_PER_WINDOW", "120"))
_voice_requests: dict[str, deque[float]] = defaultdict(deque)
_voice_requests_lock = threading.Lock()

DB_PATH = os.path.join(DATA_DIR, "embroidery.db")
SUPABASE_DATABASE_URL = os.getenv("SUPABASE_DATABASE_URL", "").strip()
if SUPABASE_DATABASE_URL.startswith(("postgresql://", "postgres://")):
    SUPABASE_DATABASE_URL = SUPABASE_DATABASE_URL.replace(
        "postgresql://", "postgresql+psycopg://", 1
    ).replace("postgres://", "postgresql+psycopg://", 1)
if SUPABASE_DATABASE_URL.startswith("postgresql+psycopg://"):
    parsed_database_url = urlsplit(SUPABASE_DATABASE_URL)
    database_query = [
        (key, value) for key, value in parse_qsl(parsed_database_url.query)
        if key != "pgbouncer"
    ]
    SUPABASE_DATABASE_URL = urlunsplit((
        parsed_database_url.scheme,
        parsed_database_url.netloc,
        parsed_database_url.path,
        urlencode(database_query),
        parsed_database_url.fragment,
    ))
if IS_SERVERLESS_DEPLOYMENT:
    if not SUPABASE_DATABASE_URL:
        raise RuntimeError("SUPABASE_DATABASE_URL must be configured for Vercel/production; SQLite is not persistent there.")
    if not storage_is_configured():
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for private production file storage.")
else:
    for d in [DATA_DIR, BACKUP_DIR]:
        os.makedirs(d, exist_ok=True)

PRIMARY_DATABASE_URL = SUPABASE_DATABASE_URL or f"sqlite:///{DB_PATH}"
engine_options = {"pool_pre_ping": True}
if PRIMARY_DATABASE_URL.startswith("sqlite"):
    engine_options["connect_args"] = {"check_same_thread": False, "timeout": 10}
engine = create_engine(PRIMARY_DATABASE_URL, **engine_options)

if PRIMARY_DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def configure_sqlite_connection(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=10000")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.close()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def hash_password(password: str) -> str:
    """PBKDF2 password encoding, using only the Python standard library."""
    salt = secrets.token_bytes(16)
    rounds = 600_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return "pbkdf2_sha256${}${}${}".format(
        rounds,
        base64.urlsafe_b64encode(salt).decode("ascii"),
        base64.urlsafe_b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, stored_hash: str) -> tuple[bool, bool]:
    """Return (valid, needs_rehash), accepting only existing legacy hashes."""
    if stored_hash.startswith("pbkdf2_sha256$"):
        try:
            _, rounds_text, salt_text, digest_text = stored_hash.split("$", 3)
            derived = hashlib.pbkdf2_hmac(
                "sha256", password.encode("utf-8"), base64.urlsafe_b64decode(salt_text.encode("ascii")), int(rounds_text)
            )
            return hmac.compare_digest(base64.urlsafe_b64encode(derived).decode("ascii"), digest_text), False
        except (ValueError, TypeError):
            return False, False
    legacy = hashlib.sha256(password.encode("utf-8")).hexdigest()
    return hmac.compare_digest(legacy, stored_hash), True


def _b64json(value: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).rstrip(b"=").decode()


def create_access_token(admin_id: int, session_id: str) -> str:
    header = _b64json({"alg": "HS256", "typ": "JWT"})
    payload = _b64json({"sub": admin_id, "sid": session_id, "exp": int(time.time()) + TOKEN_TTL_SECONDS})
    signature = hmac.new(APP_SECRET_KEY.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    return f"{header}.{payload}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"


def decode_access_token(token: str) -> tuple[int, str]:
    try:
        header, payload, signature = token.split(".")
        expected = hmac.new(APP_SECRET_KEY.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
        provided = base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4))
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        if not hmac.compare_digest(expected, provided) or int(claims["exp"]) < int(time.time()):
            raise ValueError("invalid token")
        return int(claims["sub"]), str(claims["sid"])
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session") from exc


def create_sqlite_snapshot(destination: str) -> None:
    """Export the active primary database into a portable local SQLite backup."""
    if os.path.exists(destination):
        os.remove(destination)

    if PRIMARY_DATABASE_URL.startswith("sqlite"):
        source = sqlite3.connect(DB_PATH)
        target = sqlite3.connect(destination)
        try:
            source.backup(target)
        finally:
            target.close()
            source.close()
        return

    backup_engine = create_engine(f"sqlite:///{destination}")
    Base.metadata.create_all(bind=backup_engine)
    with engine.connect() as source_conn, backup_engine.begin() as target_conn:
        for table in Base.metadata.sorted_tables:
            rows = source_conn.execute(table.select()).mappings().all()
            if rows:
                target_conn.execute(table.insert(), [dict(row) for row in rows])
    backup_engine.dispose()


def restore_sqlite_backup(source_path: str) -> dict:
    """Replace active records from a validated SQLite backup."""
    source = sqlite3.connect(source_path)
    source.row_factory = sqlite3.Row
    try:
        integrity = source.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError(f"Backup integrity check failed: {integrity}")

        expected_tables = {table.name for table in Base.metadata.sorted_tables}
        actual_tables = {
            row[0]
            for row in source.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }
        # These runtime coordination tables were added after the original
        # SQLite deployment. Their absence must not invalidate an untouched
        # pre-change backup.
        optional_runtime_tables = {"admin_sessions", "invoice_sequences"}
        missing_tables = expected_tables - actual_tables - optional_runtime_tables
        if missing_tables:
            raise ValueError(
                f"Backup is missing required tables: {', '.join(sorted(missing_tables))}"
            )

        table_rows = {}
        for table in Base.metadata.sorted_tables:
            if table.name not in actual_tables:
                table_rows[table.name] = []
                continue
            rows = source.execute(f'SELECT * FROM "{table.name}"').fetchall()
            table_rows[table.name] = [dict(row) for row in rows]
    finally:
        source.close()

    with engine.begin() as target:
        for table in reversed(Base.metadata.sorted_tables):
            target.execute(table.delete())
        for table in Base.metadata.sorted_tables:
            rows = table_rows[table.name]
            if rows:
                target.execute(table.insert(), rows)
        if primary_is_supabase():
            for table in Base.metadata.sorted_tables:
                primary_key = inspect(table).primary_key[0].name
                if table.name in {"admin_sessions", "invoice_sequences"}:
                    continue
                target.execute(text(
                    "SELECT setval(pg_get_serial_sequence(:table_name, :column_name), "
                    "COALESCE(MAX(" + primary_key + "), 1), true) "
                    'FROM "' + table.name + '"'
                ), {"table_name": table.name, "column_name": primary_key})

    return {name: len(rows) for name, rows in table_rows.items()}


def upload_storage_bytes(bucket: str, key: str, payload: bytes, content_type: str) -> None:
    if not storage_is_configured():
        raise HTTPException(status_code=503, detail="Private Supabase Storage is not configured.")
    try:
        storage_upload_bytes(bucket, key, payload, content_type, upsert=False)
    except StorageError as exc:
        raise HTTPException(status_code=503, detail="File storage operation failed. Check private bucket configuration and backend logs.") from exc


def remove_storage_object_best_effort(bucket: str, key: Optional[str]) -> None:
    if not key or not storage_is_configured():
        return
    try:
        storage_delete_object(bucket, key)
    except StorageError:
        # Cleanup failure is not allowed to mask the original transaction failure.
        pass


# --- MODELS ---
class Admin(Base):
    __tablename__ = "admin"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    password_hash = Column(String)


class AdminSession(Base):
    """Server-side session record. Logout revokes it immediately."""
    __tablename__ = "admin_sessions"
    id = Column(String, primary_key=True)
    admin_id = Column(Integer, ForeignKey("admin.id"), nullable=False, index=True)
    expires_at = Column(Integer, nullable=False, index=True)
    revoked = Column(Boolean, nullable=False, default=False)
    created_at = Column(String, default=lambda: datetime.utcnow().isoformat())


class InvoiceSequence(Base):
    """One locked counter per calendar year prevents duplicate invoice numbers."""
    __tablename__ = "invoice_sequences"
    year = Column(Integer, primary_key=True, autoincrement=False)
    next_number = Column(Integer, nullable=False, default=1)


class Customer(Base):
    __tablename__ = "customers"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    phone = Column(String, nullable=False, index=True)
    alternate_phone = Column(String, default="")
    address = Column(String, default="")
    city = Column(String, default="Madurai")
    notes = Column(Text, default="")
    created_at = Column(String, default=lambda: business_today().isoformat())


class MeasurementTemplate(Base):
    __tablename__ = "measurement_templates"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, nullable=False)
    fields = relationship("MeasurementField", back_populates="template", cascade="all, delete-orphan")


class MeasurementField(Base):
    __tablename__ = "measurement_fields"
    id = Column(Integer, primary_key=True, index=True)
    template_id = Column(Integer, ForeignKey("measurement_templates.id"))
    field_name = Column(String, nullable=False)
    unit = Column(String, default="inch")
    sort_order = Column(Integer, default=0)
    template = relationship("MeasurementTemplate", back_populates="fields")


class Product(Base):
    __tablename__ = "products"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, nullable=False)
    pricing_type = Column(String, nullable=False)  # MANUAL, STITCH_BASED, BASE_PLUS_EXTRA
    base_price = Column(Float, default=0.0)
    measurement_template_id = Column(Integer, ForeignKey("measurement_templates.id"), nullable=True)
    active = Column(Boolean, default=True)


class EmbroideryRate(Base):
    __tablename__ = "embroidery_rates"
    id = Column(Integer, primary_key=True, index=True)
    category = Column(String, unique=True, nullable=False)  # "Business" or "Business Customer"
    rate_per_stitch = Column(Float, nullable=False)


class Order(Base):
    __tablename__ = "orders"
    id = Column(Integer, primary_key=True, index=True)
    invoice_number = Column(String, unique=True, index=True)
    customer_id = Column(Integer, ForeignKey("customers.id"))
    product_id = Column(Integer, ForeignKey("products.id"))
    order_date = Column(String, default=lambda: business_today().isoformat())
    delivery_date = Column(String, default="")
    description = Column(Text, default="")
    embroidery_category = Column(String, nullable=True)
    stitch_count = Column(Integer, default=0)
    rate_per_stitch = Column(Float, default=0.0)
    base_amount = Column(Float, default=0.0)
    extra_amount = Column(Float, default=0.0)
    total_amount = Column(Float, default=0.0)
    paid_amount = Column(Float, default=0.0)
    balance = Column(Float, default=0.0)
    status = Column(String, default="Pending")
    # Legacy file keys are retained only so existing records can be deleted or
    # included in backups safely. New invoices never populate these fields.
    drawing_path = Column(String, nullable=True)
    drawing_object_key = Column(String, nullable=True)
    invoice_object_key = Column(String, nullable=True)
    reference_image_object_key = Column(String, nullable=True)
    invoice_snapshot = Column(Text, nullable=True)
    create_request_id = Column(String, unique=True, nullable=True, index=True)


class OrderMeasurement(Base):
    __tablename__ = "order_measurements"
    id = Column(Integer, primary_key=True, index=True)
    order_id = Column(Integer, ForeignKey("orders.id"))
    field_name = Column(String, nullable=False)
    value = Column(String, nullable=False)


class Transaction(Base):
    __tablename__ = "transactions"
    id = Column(Integer, primary_key=True, index=True)
    date = Column(String, default=lambda: business_today().isoformat(), index=True)
    type = Column(String, nullable=False)  # INCOME or EXPENSE
    category = Column(String, nullable=False)
    description = Column(String, default="")
    amount = Column(Float, nullable=False)
    payment_method = Column(String, default="Cash/UPI")
    reference = Column(String, default="")
    idempotency_key = Column(String, unique=True, nullable=True, index=True)


def ensure_nonproduction_schema() -> None:
    """Create local/test schema and apply additive dev migrations; never alter production on import."""
    Base.metadata.create_all(bind=engine)
    with engine.begin() as connection:
        inspector = inspect(connection)
        if "orders" not in inspector.get_table_names():
            return
        columns = {column["name"] for column in inspector.get_columns("orders")}
        for column, sql_type in {
            "drawing_object_key": "VARCHAR",
            "invoice_object_key": "VARCHAR",
            "reference_image_object_key": "VARCHAR",
            "invoice_snapshot": "TEXT",
            "create_request_id": "VARCHAR",
        }.items():
            if column not in columns:
                connection.execute(text(f"ALTER TABLE orders ADD COLUMN {column} {sql_type}"))
        transaction_columns = {column["name"] for column in inspector.get_columns("transactions")}
        if "idempotency_key" not in transaction_columns:
            connection.execute(text("ALTER TABLE transactions ADD COLUMN idempotency_key VARCHAR"))
        connection.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_create_request_id ON orders(create_request_id)"))
        connection.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_idempotency_key ON transactions(idempotency_key)"))


if not IS_SERVERLESS_DEPLOYMENT:
    ensure_nonproduction_schema()


def primary_is_supabase() -> bool:
    return bool(SUPABASE_DATABASE_URL)


def migrate_local_data_to_supabase() -> None:
    """Copy existing local records once when the Supabase database is empty."""
    if not primary_is_supabase() or not os.path.exists(DB_PATH):
        return

    local_engine = create_engine(f"sqlite:///{DB_PATH}")
    if "customers" not in inspect(local_engine).get_table_names():
        local_engine.dispose()
        return

    # Upgrade only the local source copy before reading it. Production startup never runs this path.
    with local_engine.begin() as source_conn:
        source_columns = {column["name"] for column in inspect(source_conn).get_columns("orders")}
        if "drawing_object_key" not in source_columns:
            source_conn.execute(text("ALTER TABLE orders ADD COLUMN drawing_object_key VARCHAR"))
        if "invoice_object_key" not in source_columns:
            source_conn.execute(text("ALTER TABLE orders ADD COLUMN invoice_object_key VARCHAR"))
        if "reference_image_object_key" not in source_columns:
            source_conn.execute(text("ALTER TABLE orders ADD COLUMN reference_image_object_key VARCHAR"))
        if "invoice_snapshot" not in source_columns:
            source_conn.execute(text("ALTER TABLE orders ADD COLUMN invoice_snapshot TEXT"))
        if "create_request_id" not in source_columns:
            source_conn.execute(text("ALTER TABLE orders ADD COLUMN create_request_id VARCHAR"))
        transaction_columns = {column["name"] for column in inspect(source_conn).get_columns("transactions")}
        if "idempotency_key" not in transaction_columns:
            source_conn.execute(text("ALTER TABLE transactions ADD COLUMN idempotency_key VARCHAR"))

    with SessionLocal() as target_db:
        has_data = target_db.query(Customer).first() or target_db.query(Order).first()
    if has_data:
        local_engine.dispose()
        return

    try:
        with local_engine.connect() as source_conn, engine.begin() as target_conn:
            source_tables = set(inspect(source_conn).get_table_names())
            for table in Base.metadata.sorted_tables:
                if table.name not in source_tables:
                    continue
                rows = source_conn.execute(table.select()).mappings().all()
                if rows:
                    target_conn.execute(table.insert(), [dict(row) for row in rows])
    finally:
        local_engine.dispose()


if not IS_SERVERLESS_DEPLOYMENT:
    migrate_local_data_to_supabase()


def seed_database():
    db = SessionLocal()
    if not db.query(Admin).first():
        initial_password = os.getenv("ADMIN_INITIAL_PASSWORD", "")
        if not initial_password:
            db.close()
            raise RuntimeError("ADMIN_INITIAL_PASSWORD is required when initializing an empty database.")
        db.add(Admin(
            username=os.getenv("ADMIN_INITIAL_USERNAME", "admin"),
            password_hash=hash_password(initial_password),
        ))

    if not db.query(EmbroideryRate).first():
        db.add_all([
            EmbroideryRate(category="Business", rate_per_stitch=0.04),
            EmbroideryRate(category="Business Customer", rate_per_stitch=0.06),
        ])

    if not db.query(MeasurementTemplate).first():
        blouse_tmpl = MeasurementTemplate(name="Blouse & Aari Template")
        chudi_tmpl = MeasurementTemplate(name="Chudi Template")
        lehenga_tmpl = MeasurementTemplate(name="Lehenga Template")
        db.add_all([blouse_tmpl, chudi_tmpl, lehenga_tmpl])
        db.commit()

        blouse_fields = ["Bust", "Waist", "Shoulder", "Armhole", "Sleeve Length", "Blouse Length", "Front Neck", "Back Neck", "Sleeve Opening"]
        for idx, f in enumerate(blouse_fields):
            db.add(MeasurementField(template_id=blouse_tmpl.id, field_name=f, unit="inch", sort_order=idx))

        chudi_fields = ["Shoulder", "Bust", "Waist", "Hip", "Top Length", "Sleeve Length", "Armhole", "Pant Length", "Bottom"]
        for idx, f in enumerate(chudi_fields):
            db.add(MeasurementField(template_id=chudi_tmpl.id, field_name=f, unit="inch", sort_order=idx))

        lehenga_fields = ["Waist", "Hip", "Skirt Length", "Flare", "Blouse Bust", "Blouse Length"]
        for idx, f in enumerate(lehenga_fields):
            db.add(MeasurementField(template_id=lehenga_tmpl.id, field_name=f, unit="inch", sort_order=idx))
        db.commit()

        default_products = [
            Product(name="Normal Blouse", pricing_type="MANUAL", base_price=500, measurement_template_id=blouse_tmpl.id),
            Product(name="Lining Blouse", pricing_type="MANUAL", base_price=750, measurement_template_id=blouse_tmpl.id),
            Product(name="Designer Blouse", pricing_type="BASE_PLUS_EXTRA", base_price=1200, measurement_template_id=blouse_tmpl.id),
            Product(name="Aari Blouse", pricing_type="BASE_PLUS_EXTRA", base_price=2500, measurement_template_id=blouse_tmpl.id),
            Product(name="Embroidery", pricing_type="STITCH_BASED", base_price=0, measurement_template_id=None),
            Product(name="Business to Business Embroidery", pricing_type="STITCH_BASED", base_price=0, measurement_template_id=None),
            Product(name="Chudi", pricing_type="MANUAL", base_price=900, measurement_template_id=chudi_tmpl.id),
            Product(name="Lehenga", pricing_type="BASE_PLUS_EXTRA", base_price=2200, measurement_template_id=lehenga_tmpl.id),
            Product(name="Saree Falls", pricing_type="MANUAL", base_price=150, measurement_template_id=None),
            Product(name="Kunjum", pricing_type="MANUAL", base_price=350, measurement_template_id=None),
            Product(name="Saree Prepleating", pricing_type="MANUAL", base_price=400, measurement_template_id=None),
        ]
        db.add_all(default_products)
        db.commit()

    if not db.query(Customer).first():
        c1 = Customer(name="Priya Lakshmi", phone="9876543210", address="Anna Nagar 80ft Road", city="Madurai", notes="Prefers deep back neck Aari")
        c2 = Customer(name="Meena Kumari", phone="9842112233", address="KK Nagar Lake View", city="Madurai", notes="B2B Boutique Partner")
        db.add_all([c1, c2])
        db.commit()

    # Keep product measurement requirements explicit even for databases created
    # before newer garment templates were added.
    template_specs = {
        "Salwar / Kurti Template": ["Shoulder", "Bust", "Waist", "Hip", "Armhole", "Sleeve Length", "Top Length", "Neck Depth", "Pant Length", "Bottom"],
        "Kids Pavadai Template": ["Chest", "Waist", "Shoulder", "Armhole", "Blouse Length", "Skirt Length", "Waist To Floor", "Flare"],
        "Kids Frock Template": ["Chest", "Waist", "Shoulder", "Armhole", "Sleeve Length", "Frock Length", "Neck Depth"],
        "Petticoat Template": ["Waist", "Hip", "Length", "Bottom Opening"],
    }
    templates_by_name = {template.name: template for template in db.query(MeasurementTemplate).all()}
    for template_name, fields in template_specs.items():
        template = templates_by_name.get(template_name) or db.query(MeasurementTemplate).filter(
            MeasurementTemplate.name == template_name
        ).first()
        if not template:
            template = MeasurementTemplate(name=template_name)
            db.add(template)
            db.flush()
            for index, field_name in enumerate(fields):
                db.add(MeasurementField(
                    template_id=template.id,
                    field_name=field_name,
                    unit="inch",
                    sort_order=index,
                ))
            templates_by_name[template_name] = template

    product_template_map = {
        "Chudi": "Salwar / Kurti Template",
        "Kids Pavadai": "Kids Pavadai Template",
        "Kids Frock": "Kids Frock Template",
        "Petticoat": "Petticoat Template",
    }
    for product_name, template_name in product_template_map.items():
        product = db.query(Product).filter(Product.name == product_name).first()
        if not product:
            product = Product(
                name=product_name,
                pricing_type="MANUAL",
                base_price=700,
                measurement_template_id=templates_by_name[template_name].id,
            )
            db.add(product)
        elif product.measurement_template_id is None:
            product.measurement_template_id = templates_by_name[template_name].id
    db.commit()
    db.close()


if not IS_SERVERLESS_DEPLOYMENT:
    seed_database()

@asynccontextmanager
async def app_lifespan(_app: FastAPI):
    """Fail closed in production unless the persistent session/snapshot schema is present."""
    if IS_SERVERLESS_DEPLOYMENT:
        try:
            order_columns = {column["name"] for column in inspect(engine).get_columns("orders")}
        except Exception as exc:
            raise RuntimeError(
                "Production database schema is not available. Apply the documented database migrations before deployment."
            ) from exc
        required_order_columns = {"invoice_snapshot", "create_request_id"}
        if not required_order_columns.issubset(order_columns):
            missing = ", ".join(sorted(required_order_columns - order_columns))
            raise RuntimeError(
                f"Production database migration is incomplete; missing orders column(s): {missing}. "
                "Apply backend/migrations/0003_session_invoice_snapshots_and_idempotency.sql before deployment."
            )
        table_names = set(inspect(engine).get_table_names())
        required_tables = {"admin_sessions", "invoice_sequences"}
        if not required_tables.issubset(table_names):
            missing = ", ".join(sorted(required_tables - table_names))
            raise RuntimeError(f"Production database migration is incomplete; missing table(s): {missing}.")
    yield


app = FastAPI(title="Lalitha's Apparel - Embroidery & Boutique Billing", lifespan=app_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def require_admin(request: Request, db: Session = Depends(get_db)) -> Admin:
    authorization = request.headers.get("Authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    admin_id, session_id = decode_access_token(token)
    active_session = db.query(AdminSession).filter(
        AdminSession.id == session_id,
        AdminSession.admin_id == admin_id,
        AdminSession.revoked.is_(False),
        AdminSession.expires_at >= int(time.time()),
    ).first()
    admin = db.query(Admin).filter(Admin.id == admin_id).first() if active_session else None
    if not admin:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session")
    return admin


def login_is_rate_limited(client_key: str) -> bool:
    now = time.monotonic()
    with _login_attempts_lock:
        attempts = _login_attempts[client_key]
        while attempts and attempts[0] <= now - LOGIN_WINDOW_SECONDS:
            attempts.popleft()
        return len(attempts) >= LOGIN_MAX_FAILURES


def record_login_failure(client_key: str) -> None:
    with _login_attempts_lock:
        _login_attempts[client_key].append(time.monotonic())


def clear_login_failures(client_key: str) -> None:
    with _login_attempts_lock:
        _login_attempts.pop(client_key, None)


def voice_is_rate_limited(client_key: str) -> bool:
    now = time.monotonic()
    with _voice_requests_lock:
        requests = _voice_requests[client_key]
        while requests and requests[0] <= now - VOICE_RATE_WINDOW_SECONDS:
            requests.popleft()
        if len(requests) >= VOICE_MAX_REQUESTS_PER_WINDOW:
            return True
        requests.append(now)
        return False


# --- SCHEMAS ---
class LoginReq(BaseModel):
    username: str
    password: str


class CustomerCreate(BaseModel):
    name: str
    phone: str
    alternate_phone: Optional[str] = ""
    address: Optional[str] = ""
    city: Optional[str] = "Madurai"
    notes: Optional[str] = ""


class ProductCreate(BaseModel):
    name: str
    pricing_type: str
    base_price: float = 0.0
    measurement_template_id: Optional[int] = None


class TemplateCreate(BaseModel):
    name: str
    fields: List[str]


class RateUpdate(BaseModel):
    category: str
    rate_per_stitch: float


class MeasurementItem(BaseModel):
    field_name: str
    value: str


class OrderCreate(BaseModel):
    customer_id: int
    product_id: int
    order_date: str
    delivery_date: Optional[str] = ""
    description: Optional[str] = ""
    embroidery_category: Optional[str] = None
    stitch_count: int = 0
    rate_per_stitch: float = 0.0
    base_amount: float = 0.0
    extra_amount: float = 0.0
    total_amount: float
    paid_amount: float
    measurements: List[MeasurementItem] = []
    idempotency_key: str


class PaymentUpdate(BaseModel):
    additional_paid: float
    idempotency_key: str


class TransactionCreate(BaseModel):
    date: str
    type: str
    category: str
    description: str
    amount: float
    payment_method: str = "Cash/UPI"


# --- PDF GENERATOR ---
def generate_invoice_pdf(
    order: Order,
    customer: Customer,
    product: Product,
    measurements: List[OrderMeasurement],
    reference_bytes: Optional[bytes] = None,
) -> bytes:
    """Render an invoice entirely in memory; optional image bytes live for this request only."""
    # Immutable billing data is retained even when customer/product records later change.
    if order.invoice_snapshot:
        try:
            snapshot = json.loads(order.invoice_snapshot)
            customer = SimpleNamespace(**snapshot["customer"])
            product = SimpleNamespace(**snapshot["product"])
            measurements = [SimpleNamespace(**item) for item in snapshot.get("measurements", [])]
            pricing = snapshot["pricing"]
            order = SimpleNamespace(
                invoice_number=snapshot.get("invoice_number", order.invoice_number),
                order_date=snapshot.get("issued_at", order.order_date),
                delivery_date=snapshot.get("delivery_date", ""),
                description=snapshot.get("description", ""),
                embroidery_category=snapshot.get("embroidery_category", order.embroidery_category),
                stitch_count=pricing["stitch_count"], rate_per_stitch=pricing["rate_per_stitch"],
                base_amount=pricing["base_amount"], extra_amount=pricing["extra_amount"],
                total_amount=pricing["total_amount"], paid_amount=pricing["paid_amount"],
                balance=pricing["balance"], status=pricing["status"],
            )
        except (TypeError, ValueError, KeyError):
            pass
    pdf_buffer = io.BytesIO()
    c = canvas.Canvas(pdf_buffer, pagesize=A4)
    width, height = A4

    c.setFillColor(colors.HexColor("#17324d"))
    c.rect(0, height - 90, width, 90, fill=1, stroke=0)
    if os.path.exists(LOGO_PATH):
        logo = ImageReader(LOGO_PATH)
        c.drawImage(logo, 40, height - 82, width=62, height=62, preserveAspectRatio=True, mask="auto")
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 19)
    c.drawString(115, height - 45, "LALITHA'S APPAREL")
    c.setFont("Helvetica", 10)
    c.drawString(115, height - 65, "Embroidery, Bridal Blouses, Tailoring & Boutique Services | Madurai")
    c.setFont("Helvetica-Bold", 12)
    c.drawRightString(width - 40, height - 45, f"INVOICE: {order.invoice_number}")
    c.setFont("Helvetica", 10)
    c.drawRightString(width - 40, height - 65, f"Date: {order.order_date} | Delivery: {order.delivery_date or 'TBD'}")

    y = height - 120
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(40, y, f"Customer: {customer.name} (CUST-{customer.id:03d})")
    c.drawRightString(width - 40, y, f"Phone: {customer.phone}")
    y -= 16
    c.setFont("Helvetica", 10)
    c.drawString(40, y, f"Address: {customer.address}, {customer.city}")

    y -= 20
    c.line(40, y, width - 40, y)
    y -= 22

    c.setFont("Helvetica-Bold", 12)
    c.drawString(40, y, f"Product / Work: {product.name}")
    y -= 20

    if product.pricing_type == "STITCH_BASED":
        c.setFont("Helvetica", 10)
        c.drawString(40, y, f"Embroidery Category: {order.embroidery_category}")
        y -= 15
        c.drawString(40, y, f"Stitch Calculation: {order.stitch_count:,} stitches x Rs. {order.rate_per_stitch:.4f}/stitch")
        y -= 20

    if measurements:
        c.setFont("Helvetica-Bold", 11)
        c.drawString(40, y, "Measurements (in inches):")
        y -= 18
        c.setFont("Helvetica", 10)
        col = 0
        for m in measurements:
            x_pos = 40 + (col * 170)
            c.drawString(x_pos, y, f"• {m.field_name}: {m.value}\"")
            col += 1
            if col == 3:
                col = 0
                y -= 15
        if col != 0:
            y -= 15
        y -= 10

    if order.description:
        c.setFont("Helvetica-Bold", 11)
        c.drawString(40, y, "Cloth & Design Description:")
        y -= 15
        c.setFont("Helvetica", 10)
        for line in order.description.split("\n")[:5]:
            c.drawString(50, y, line[:95])
            y -= 14
        y -= 10

    if reference_bytes:
        c.setFont("Helvetica-Bold", 11)
        c.drawString(40, y, "Reference Image:")
        y -= 130
        try:
            c.drawImage(ImageReader(io.BytesIO(reference_bytes)), 40, y, width=220, height=120, preserveAspectRatio=True, mask='auto')
            c.rect(40, y, 220, 120, fill=0, stroke=1)
        except Exception:
            # An invalid request image must not corrupt the rest of the PDF.
            pass
        y -= 20

    y -= 10
    c.line(40, y, width - 40, y)
    y -= 22
    c.setFont("Helvetica", 11)
    if order.extra_amount > 0:
        c.drawString(340, y, "Base Price:")
        c.drawRightString(width - 40, y, f"Rs. {order.base_amount:,.2f}")
        y -= 18
        c.drawString(340, y, "Extra Work / Material:")
        c.drawRightString(width - 40, y, f"Rs. {order.extra_amount:,.2f}")
        y -= 18

    c.setFont("Helvetica-Bold", 13)
    c.drawString(340, y, "TOTAL AMOUNT:")
    c.drawRightString(width - 40, y, f"Rs. {order.total_amount:,.2f}")
    y -= 20

    c.setFont("Helvetica-Bold", 11)
    c.setFillColor(colors.HexColor("#15803d"))
    c.drawString(340, y, "Advance / Paid:")
    c.drawRightString(width - 40, y, f"Rs. {order.paid_amount:,.2f}")
    y -= 20

    c.setFillColor(colors.HexColor("#b91c1c"))
    c.drawString(340, y, f"BALANCE DUE ({order.status.upper()}):")
    c.drawRightString(width - 40, y, f"Rs. {order.balance:,.2f}")

    c.setFillColor(colors.HexColor("#475569"))
    c.setFont("Helvetica-Oblique", 9)
    c.drawString(40, 45, "Please verify design & measurements above. No alterations to Aari/Embroidery designs after 24 hours.")
    c.save()
    return pdf_buffer.getvalue()


# --- API ENDPOINTS ---
@app.post("/api/login")
def login(req: LoginReq, request: Request, db: Session = Depends(get_db)):
    client_key = request.client.host if request.client else "unknown"
    if login_is_rate_limited(client_key):
        raise HTTPException(status_code=429, detail="Too many login attempts. Try again later.")
    admin = db.query(Admin).filter(Admin.username == req.username).first()
    valid, needs_rehash = verify_password(req.password, admin.password_hash) if admin else (False, False)
    if not admin or not valid:
        record_login_failure(client_key)
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if needs_rehash:
        admin.password_hash = hash_password(req.password)
    now = int(time.time())
    db.query(AdminSession).filter(AdminSession.expires_at < now).delete(synchronize_session=False)
    session_id = secrets.token_urlsafe(32)
    db.add(AdminSession(id=session_id, admin_id=admin.id, expires_at=now + TOKEN_TTL_SECONDS))
    db.commit()
    clear_login_failures(client_key)
    return {"token": create_access_token(admin.id, session_id), "username": admin.username}


@app.post("/api/logout")
def logout(request: Request, db: Session = Depends(get_db), _: Admin = Depends(require_admin)):
    """Immediately revoke the server-side session represented by the presented token."""
    _, session_id = decode_access_token(request.headers["Authorization"].split(" ", 1)[1])
    db.query(AdminSession).filter(AdminSession.id == session_id).update({AdminSession.revoked: True})
    db.commit()
    return {"logged_out": True}


def voice_auth_session_id(request: Request) -> str:
    """Use the already-validated admin JWT only to scope temporary conversation state."""
    return decode_access_token(request.headers["Authorization"].split(" ", 1)[1])[1]


@app.get("/api/voice/session", response_model=VoiceTurnResponse)
def get_voice_session(request: Request, admin: Admin = Depends(require_admin)):
    conversation = conversation_store.get(admin.id, voice_auth_session_id(request))
    public = conversation.public()
    return {
        **public,
        "reply": "",
        "messages": public["messages"],
        "provider": voice_config.provider_label(),
        "warnings": [],
    }


@app.delete("/api/voice/session")
def delete_voice_session(request: Request, admin: Admin = Depends(require_admin)):
    conversation_store.delete(admin.id, voice_auth_session_id(request))
    return {"cleared": True}


@app.post("/api/voice/turn", response_model=VoiceTurnResponse)
def voice_turn(
    payload: VoiceTurnRequest,
    request: Request,
    db: Session = Depends(get_db),
    admin: Admin = Depends(require_admin),
):
    client_key = request.client.host if request.client else "unknown"
    if voice_is_rate_limited(f"{admin.id}:{client_key}"):
        raise HTTPException(status_code=429, detail="Too many voice requests. Please wait before trying again.")
    conversation = conversation_store.get(admin.id, voice_auth_session_id(request))
    conversation.say("user", payload.text)
    try:
        result = handle_turn(db, conversation, payload.text, admin)
    except VoiceOperationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    conversation.say("assistant", result.reply)
    public = conversation.public()
    return {
        **public,
        "reply": result.reply,
        "messages": public["messages"],
        "ui_action": result.ui_action,
        "provider": result.provider,
        "warnings": result.warnings,
        "data": result.data,
    }


@app.post("/api/voice/confirm", response_model=VoiceTurnResponse)
def voice_confirm(
    payload: VoiceConfirmRequest,
    request: Request,
    db: Session = Depends(get_db),
    admin: Admin = Depends(require_admin),
):
    client_key = request.client.host if request.client else "unknown"
    if voice_is_rate_limited(f"{admin.id}:{client_key}"):
        raise HTTPException(status_code=429, detail="Too many voice requests. Please wait before trying again.")
    conversation = conversation_store.get(admin.id, voice_auth_session_id(request))
    try:
        result = execute_confirmation(
            db,
            conversation,
            payload.confirmation_id,
            payload.confirmation_phrase,
            admin,
        )
    except VoiceOperationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    public = conversation.public()
    return {
        **public,
        "reply": result.reply,
        "messages": public["messages"],
        "ui_action": result.ui_action,
        "provider": result.provider,
        "warnings": result.warnings,
        "data": result.data,
    }


@app.post("/api/voice/cancel", response_model=VoiceTurnResponse)
def voice_cancel(
    payload: VoiceCancelRequest,
    request: Request,
    admin: Admin = Depends(require_admin),
):
    conversation = conversation_store.get(admin.id, voice_auth_session_id(request))
    result = cancel_voice(None, conversation, payload.scope)
    conversation.say("assistant", result.reply)
    public = conversation.public()
    return {
        **public,
        "reply": result.reply,
        "messages": public["messages"],
        "provider": result.provider,
        "warnings": result.warnings,
    }


@app.patch("/api/voice/draft", response_model=VoiceTurnResponse)
def voice_draft_patch(
    payload: VoiceDraftPatch,
    request: Request,
    db: Session = Depends(get_db),
    admin: Admin = Depends(require_admin),
):
    conversation = conversation_store.get(admin.id, voice_auth_session_id(request))
    try:
        result = apply_draft_patch(
            db, conversation, payload.model_dump(exclude_none=True)
        )
    except VoiceOperationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    conversation.say("assistant", result.reply)
    public = conversation.public()
    return {
        **public,
        "reply": result.reply,
        "messages": public["messages"],
        "ui_action": result.ui_action,
        "provider": result.provider,
        "warnings": result.warnings,
        "data": result.data,
    }


@app.post("/api/voice/transcribe")
async def voice_transcribe(
    request: Request,
    audio: UploadFile = File(...),
    language: Optional[str] = Query(None, max_length=12),
    admin: Admin = Depends(require_admin),
):
    client_key = request.client.host if request.client else "unknown"
    if voice_is_rate_limited(f"{admin.id}:{client_key}"):
        raise HTTPException(status_code=429, detail="Too many voice requests. Please wait before trying again.")
    # MediaRecorder commonly sends values such as "audio/webm;codecs=opus".
    # Validate the media type itself while allowing harmless MIME parameters.
    audio_media_type = (audio.content_type or "").split(";", 1)[0].strip().lower()
    if audio_media_type not in {"audio/webm", "audio/ogg", "audio/wav", "audio/mpeg", "audio/mp4", "audio/x-m4a"}:
        raise HTTPException(status_code=415, detail="Unsupported audio type. Use WebM, OGG, WAV, MP3, MP4, or M4A.")
    payload = await audio.read(VOICE_MAX_UPLOAD_BYTES + 1)
    try:
        if not payload:
            raise HTTPException(status_code=422, detail="The recording is empty.")
        if len(payload) > VOICE_MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="The recording exceeds the configured upload limit.")
        duration = audio_duration_seconds(payload)
        if duration is not None and (duration <= 0 or duration > VOICE_MAX_DURATION_SECONDS):
            raise HTTPException(status_code=422, detail="The recording exceeds the configured duration limit.")
        result = {"transcript": transcribe_audio(payload, audio.filename or "recording.webm", language)}
        if duration is not None:
            result["duration_seconds"] = round(duration, 2)
        return result
    except VoiceProviderError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    finally:
        await audio.close()


@app.get("/api/customers")
def list_customers(
    q: Optional[str] = None,
    limit: int = Query(100, ge=1, le=250),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _: Admin = Depends(require_admin),
):
    query = db.query(Customer)
    if q:
        query = query.filter((Customer.name.ilike(f"%{q}%")) | (Customer.phone.ilike(f"%{q}%")))
    total = query.count()
    customers = query.order_by(Customer.id.desc()).offset(offset).limit(limit).all()
    out = []
    for c in customers:
        orders = db.query(Order).filter(Order.customer_id == c.id).all()
        total_spent = sum(o.total_amount for o in orders)
        last_measurements = {}
        if orders:
            latest_order = orders[-1]
            ms = db.query(OrderMeasurement).filter(OrderMeasurement.order_id == latest_order.id).all()
            last_measurements = {m.field_name: m.value for m in ms}
        out.append({
            "id": c.id,
            "cust_code": f"CUST-{c.id:03d}",
            "name": c.name,
            "phone": c.phone,
            "alternate_phone": c.alternate_phone,
            "address": c.address,
            "city": c.city,
            "notes": c.notes,
            "total_spent": total_spent,
            "order_count": len(orders),
            "last_measurements": last_measurements
        })
    return {"items": out, "total": total, "limit": limit, "offset": offset}


@app.post("/api/customers")
def create_customer(c: CustomerCreate, db: Session = Depends(get_db), _: Admin = Depends(require_admin)):
    cust = Customer(**c.model_dump())
    db.add(cust)
    db.commit()
    db.refresh(cust)
    return cust


def remove_order_assets(order: Order) -> None:
    for object_key in (order.drawing_object_key, order.invoice_object_key, order.reference_image_object_key):
        if object_key and storage_is_configured():
            storage_delete_object(SUPABASE_FILES_BUCKET, object_key)
    for local_path in (order.drawing_path,):
        if local_path and os.path.isfile(local_path):
            os.remove(local_path)


@app.delete("/api/orders/{order_id}")
def delete_order(order_id: int, db: Session = Depends(get_db), _: Admin = Depends(require_admin)):
    order = db.query(Order).filter(Order.id == order_id).with_for_update().first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    try:
        remove_order_assets(order)
        db.query(OrderMeasurement).filter(OrderMeasurement.order_id == order.id).delete(
            synchronize_session=False
        )
        db.delete(order)
        db.commit()
    except StorageError as exc:
        db.rollback()
        raise HTTPException(status_code=502, detail="Order files could not be removed from storage") from exc
    except OSError as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail="Order drawing could not be removed") from exc
    return {"deleted": True, "order_id": order_id}


@app.delete("/api/customers/{customer_id}")
def delete_customer(
    customer_id: int,
    cascade_orders: bool = Query(False),
    db: Session = Depends(get_db),
    _: Admin = Depends(require_admin),
):
    customer = db.query(Customer).filter(Customer.id == customer_id).first()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    orders = db.query(Order).filter(Order.customer_id == customer.id).all()
    if orders and not cascade_orders:
        raise HTTPException(
            status_code=409,
            detail=f"Customer has {len(orders)} order(s). Delete the orders first or confirm deleting the customer and all linked orders.",
        )
    try:
        for order in orders:
            remove_order_assets(order)
            db.query(OrderMeasurement).filter(OrderMeasurement.order_id == order.id).delete(
                synchronize_session=False
            )
            db.delete(order)
        db.delete(customer)
        db.commit()
    except StorageError as exc:
        db.rollback()
        raise HTTPException(status_code=502, detail="Customer files could not be removed from storage") from exc
    except OSError as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail="Customer drawing could not be removed") from exc
    return {"deleted": True, "customer_id": customer_id, "orders_deleted": len(orders)}


@app.get("/api/templates")
def get_templates(db: Session = Depends(get_db), _: Admin = Depends(require_admin)):
    tmpls = db.query(MeasurementTemplate).all()
    return [
        {
            "id": t.id,
            "name": t.name,
            "fields": [f.field_name for f in sorted(t.fields, key=lambda x: x.sort_order)]
        }
        for t in tmpls
    ]


@app.post("/api/templates")
def create_template(req: TemplateCreate, db: Session = Depends(get_db), _: Admin = Depends(require_admin)):
    tmpl = MeasurementTemplate(name=req.name)
    db.add(tmpl)
    db.commit()
    db.refresh(tmpl)
    for idx, f_name in enumerate(req.fields):
        if f_name.strip():
            db.add(MeasurementField(template_id=tmpl.id, field_name=f_name.strip(), unit="inch", sort_order=idx))
    db.commit()
    return {"status": "ok", "id": tmpl.id}


@app.get("/api/products")
def get_products(db: Session = Depends(get_db), _: Admin = Depends(require_admin)):
    return db.query(Product).all()


@app.post("/api/products")
def add_product(req: ProductCreate, db: Session = Depends(get_db), _: Admin = Depends(require_admin)):
    p = Product(**req.model_dump(), active=True)
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@app.patch("/api/products/{product_id}/toggle")
def toggle_product(product_id: int, db: Session = Depends(get_db), _: Admin = Depends(require_admin)):
    p = db.query(Product).filter(Product.id == product_id).first()
    if not p:
        raise HTTPException(404, "Product not found")
    p.active = not p.active
    db.commit()
    return p


@app.get("/api/embroidery-rates")
def get_rates(db: Session = Depends(get_db), _: Admin = Depends(require_admin)):
    return db.query(EmbroideryRate).all()


@app.put("/api/embroidery-rates")
def update_rate(req: RateUpdate, db: Session = Depends(get_db), _: Admin = Depends(require_admin)):
    if not math.isfinite(req.rate_per_stitch) or req.rate_per_stitch < 0:
        raise HTTPException(status_code=422, detail="Rate must be a finite non-negative number")
    rate = db.query(EmbroideryRate).filter(EmbroideryRate.category == req.category).first()
    if not rate:
        rate = EmbroideryRate(category=req.category, rate_per_stitch=req.rate_per_stitch)
        db.add(rate)
    else:
        rate.rate_per_stitch = req.rate_per_stitch
    db.commit()
    return rate


@app.get("/api/orders")
def list_orders(
    limit: int = Query(100, ge=1, le=250),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _: Admin = Depends(require_admin),
):
    query = db.query(Order)
    total = query.count()
    orders = query.order_by(Order.id.desc()).offset(offset).limit(limit).all()
    out = []
    for o in orders:
        cust = db.query(Customer).filter(Customer.id == o.customer_id).first()
        prod = db.query(Product).filter(Product.id == o.product_id).first()
        ms = db.query(OrderMeasurement).filter(OrderMeasurement.order_id == o.id).all()
        out.append({
            "id": o.id,
            "invoice_number": o.invoice_number,
            "order_date": o.order_date,
            "delivery_date": o.delivery_date,
            "customer_name": cust.name if cust else "Unknown",
            "customer_phone": cust.phone if cust else "",
            "product_name": prod.name if prod else "Unknown",
            "pricing_type": prod.pricing_type if prod else "",
            "embroidery_category": o.embroidery_category,
            "stitch_count": o.stitch_count,
            "description": o.description,
            "total_amount": o.total_amount,
            "paid_amount": o.paid_amount,
            "balance": o.balance,
            "status": o.status,
            "measurements": [{"field_name": m.field_name, "value": m.value} for m in ms]
        })
    return {"items": out, "total": total, "limit": limit, "offset": offset}


def next_invoice_number(db: Session) -> str:
    """Reserve a unique sequential invoice number inside the current transaction."""
    year = business_today().year
    if engine.dialect.name == "postgresql":
        sequence_number = db.execute(text("""
            INSERT INTO invoice_sequences (year, next_number) VALUES (:year, 2)
            ON CONFLICT (year) DO UPDATE SET next_number = invoice_sequences.next_number + 1
            RETURNING next_number - 1
        """), {"year": year}).scalar_one()
    else:
        counter = db.query(InvoiceSequence).filter(InvoiceSequence.year == year).with_for_update().first()
        if counter is None:
            last_number = db.query(Order).count()
            counter = InvoiceSequence(year=year, next_number=last_number + 2)
            db.add(counter)
            sequence_number = last_number + 1
        else:
            sequence_number = counter.next_number
            counter.next_number += 1
        db.flush()
    return f"INV-{year}-{int(sequence_number):03d}"


@app.post("/api/orders")
def create_order(req: OrderCreate, db: Session = Depends(get_db), _: Admin = Depends(require_admin)):
    if not req.idempotency_key or len(req.idempotency_key) > 128:
        raise HTTPException(status_code=422, detail="A valid idempotency key is required")
    existing_order = db.query(Order).filter(Order.create_request_id == req.idempotency_key).first()
    if existing_order:
        return {"id": existing_order.id, "invoice_number": existing_order.invoice_number, "idempotent_replay": True}
    money_values = (
        req.rate_per_stitch,
        req.base_amount,
        req.extra_amount,
        req.total_amount,
        req.paid_amount,
    )
    if any(not math.isfinite(value) or value < 0 for value in money_values):
        raise HTTPException(status_code=422, detail="Order amounts must be finite non-negative numbers")
    customer = db.query(Customer).filter(Customer.id == req.customer_id).first()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    product = db.query(Product).filter(Product.id == req.product_id).first()
    if not product or not product.active:
        raise HTTPException(status_code=404, detail="Product not found")
    if product.measurement_template_id:
        template = db.query(MeasurementTemplate).filter(
            MeasurementTemplate.id == product.measurement_template_id
        ).first()
        required_fields = {field.field_name for field in (template.fields if template else [])}
        submitted_fields = {
            item.field_name for item in req.measurements if str(item.value).strip()
        }
        missing_fields = sorted(required_fields - submitted_fields)
        if missing_fields:
            raise HTTPException(
                status_code=422,
                detail=f"Missing measurements: {', '.join(missing_fields)}",
            )

    if product.pricing_type == "STITCH_BASED":
        if req.stitch_count <= 0:
            raise HTTPException(status_code=422, detail="Stitch count must be greater than zero")
        rate = db.query(EmbroideryRate).filter(
            EmbroideryRate.category == req.embroidery_category
        ).first()
        if not rate:
            raise HTTPException(status_code=422, detail="Select a valid embroidery rate category")
        rate_per_stitch = rate.rate_per_stitch
        total_amount = round(req.stitch_count * rate_per_stitch, 2)
    else:
        rate_per_stitch = 0.0
        total_amount = round(req.base_amount + req.extra_amount, 2)
    if req.paid_amount > total_amount:
        raise HTTPException(status_code=422, detail="Payment cannot exceed the order total")

    balance = round(total_amount - req.paid_amount, 2)
    if balance == 0 and total_amount > 0:
        order_status = "Paid"
    elif req.paid_amount > 0:
        order_status = "Partially Paid"
    else:
        order_status = "Pending"

    order = Order(
        invoice_number=None,
        customer_id=req.customer_id,
        product_id=req.product_id,
        order_date=req.order_date,
        delivery_date=req.delivery_date or "",
        description=req.description or "",
        embroidery_category=req.embroidery_category,
        stitch_count=req.stitch_count,
        rate_per_stitch=rate_per_stitch,
        base_amount=req.base_amount,
        extra_amount=req.extra_amount,
        total_amount=total_amount,
        paid_amount=req.paid_amount,
        balance=balance,
        status=order_status,
        create_request_id=req.idempotency_key,
    )
    try:
        inv_no = next_invoice_number(db)
        order.invoice_number = inv_no
        db.add(order)
        db.flush()
        saved_ms = []
        for m in req.measurements:
            if str(m.value).strip():
                om = OrderMeasurement(order_id=order.id, field_name=m.field_name, value=str(m.value).strip())
                db.add(om)
                saved_ms.append(om)

        order.invoice_snapshot = json.dumps({
            "invoice_number": inv_no,
            "issued_at": order.order_date,
            "customer": {"id": customer.id, "name": customer.name, "phone": customer.phone, "address": customer.address, "city": customer.city},
            "product": {"id": product.id, "name": product.name, "pricing_type": product.pricing_type},
            "measurements": [{"field_name": m.field_name, "value": m.value} for m in saved_ms],
            "pricing": {"stitch_count": order.stitch_count, "rate_per_stitch": order.rate_per_stitch, "base_amount": order.base_amount, "extra_amount": order.extra_amount, "total_amount": order.total_amount, "paid_amount": order.paid_amount, "balance": order.balance, "status": order.status},
            "delivery_date": order.delivery_date,
            "description": order.description,
            "embroidery_category": order.embroidery_category,
        }, separators=(",", ":"))

        if req.paid_amount > 0:
            db.add(Transaction(
                date=req.order_date,
                type="INCOME",
                category="Order Payment",
                description=f"{inv_no} - {customer.name} ({product.name})",
                amount=req.paid_amount,
                payment_method="Cash/UPI",
                reference=inv_no,
                idempotency_key=f"order:{req.idempotency_key}",
            ))

        db.flush()
        db.commit()
        return {"id": order.id, "invoice_number": inv_no}
    except IntegrityError:
        db.rollback()
        existing_order = db.query(Order).filter(Order.create_request_id == req.idempotency_key).first()
        if existing_order:
            return {"id": existing_order.id, "invoice_number": existing_order.invoice_number, "idempotent_replay": True}
        raise HTTPException(status_code=409, detail="Invoice or order request conflicts with an existing record")
    except Exception:
        db.rollback()
        raise


@app.post("/api/orders/{order_id}/pay")
def collect_balance(order_id: int, req: PaymentUpdate, db: Session = Depends(get_db), _: Admin = Depends(require_admin)):
    if not req.idempotency_key or len(req.idempotency_key) > 128:
        raise HTTPException(status_code=422, detail="A valid idempotency key is required")
    replay = db.query(Transaction).filter(Transaction.idempotency_key == req.idempotency_key).first()
    if replay:
        order = db.query(Order).filter(Order.id == order_id).first()
        if not order or replay.reference != order.invoice_number:
            raise HTTPException(status_code=409, detail="Idempotency key was already used for a different request")
        return {"status": "idempotent_replay", "balance": order.balance}
    order = db.query(Order).filter(Order.id == order_id).with_for_update().first()
    if not order:
        raise HTTPException(404, "Order not found")
    if not math.isfinite(req.additional_paid) or req.additional_paid <= 0:
        raise HTTPException(status_code=422, detail="Payment must be a finite positive number")
    if req.additional_paid > order.balance:
        raise HTTPException(status_code=422, detail="Payment cannot exceed the outstanding balance")

    order.paid_amount += req.additional_paid
    order.balance = round(order.total_amount - order.paid_amount, 2)
    order.status = "Paid" if order.balance == 0 else "Partially Paid"
    cust = db.query(Customer).filter(Customer.id == order.customer_id).first()
    prod = db.query(Product).filter(Product.id == order.product_id).first()
    ms = db.query(OrderMeasurement).filter(OrderMeasurement.order_id == order.id).all()
    try:
        db.add(Transaction(
            date=business_today().isoformat(),
            type="INCOME",
            category="Balance Collection",
            description=f"Balance received for {order.invoice_number} ({cust.name if cust else ''})",
            amount=req.additional_paid,
            payment_method="Cash/UPI",
            reference=order.invoice_number,
            idempotency_key=req.idempotency_key,
        ))
        db.flush()
        db.commit()
    except IntegrityError:
        db.rollback()
        replay = db.query(Transaction).filter(Transaction.idempotency_key == req.idempotency_key).first()
        if replay:
            refreshed = db.query(Order).filter(Order.id == order_id).first()
            return {"status": "idempotent_replay", "balance": refreshed.balance}
        raise HTTPException(status_code=409, detail="Payment request conflicts with an existing transaction")
    except Exception:
        db.rollback()
        raise
    return {"status": "updated", "balance": order.balance}


def validate_reference_image(payload: bytes, content_type: str | None) -> tuple[str, str]:
    if len(payload) > MAX_REFERENCE_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Reference image must be 5 MB or smaller")
    try:
        with Image.open(io.BytesIO(payload)) as image:
            image.verify()
            image_format = image.format
    except Exception as exc:
        raise HTTPException(status_code=422, detail="Reference image is not a valid image") from exc
    extensions = {"JPEG": ("jpg", "image/jpeg"), "PNG": ("png", "image/png")}
    if image_format not in extensions:
        raise HTTPException(status_code=422, detail="Reference image must be JPEG or PNG")
    extension, expected_type = extensions[image_format]
    if content_type and content_type.lower() not in {"image/jpeg", "image/png"}:
        raise HTTPException(status_code=415, detail="Only JPEG and PNG images are supported")
    return extension, expected_type


def invoice_response(order_id: int, db: Session, reference_bytes: Optional[bytes] = None) -> Response:
    order = db.query(Order).filter(Order.id == order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    cust = db.query(Customer).filter(Customer.id == order.customer_id).first()
    prod = db.query(Product).filter(Product.id == order.product_id).first()
    ms = db.query(OrderMeasurement).filter(OrderMeasurement.order_id == order.id).all()
    pdf_bytes = generate_invoice_pdf(order, cust, prod, ms, reference_bytes=reference_bytes)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{order.invoice_number}.pdf"'},
    )


@app.get("/api/orders/{order_id}/pdf")
def download_invoice(
    order_id: int,
    db: Session = Depends(get_db),
    _: Admin = Depends(require_admin),
):
    """Regenerate a PDF from permanent billing data without any past reference image."""
    return invoice_response(order_id, db)


@app.post("/api/orders/{order_id}/invoice")
async def generate_session_invoice(
    order_id: int,
    image: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
    _: Admin = Depends(require_admin),
):
    """Generate once with an optional image that is discarded as soon as this response is made."""
    reference_bytes = None
    if image is not None:
        reference_bytes = await image.read(MAX_REFERENCE_IMAGE_BYTES + 1)
        validate_reference_image(reference_bytes, image.content_type)
    try:
        return invoice_response(order_id, db, reference_bytes=reference_bytes)
    finally:
        if image is not None:
            await image.close()
        # Explicitly drop the request-only image bytes before the worker is reused.
        reference_bytes = None


# --- FINANCE & ANALYTICS ---
@app.get("/api/finance")
def get_finance(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: Session = Depends(get_db),
    _: Admin = Depends(require_admin),
):
    tx_query = db.query(Transaction)
    ord_query = db.query(Order)
    if start_date:
        tx_query = tx_query.filter(Transaction.date >= start_date)
        ord_query = ord_query.filter(Order.order_date >= start_date)
    if end_date:
        tx_query = tx_query.filter(Transaction.date <= end_date)
        ord_query = ord_query.filter(Order.order_date <= end_date)

    txs = tx_query.order_by(Transaction.date.desc(), Transaction.id.desc()).all()
    orders = ord_query.all()

    total_income = sum(t.amount for t in txs if t.type == "INCOME")
    total_expense = sum(t.amount for t in txs if t.type == "EXPENSE")
    net_profit = total_income - total_expense
    pending_payments = sum(o.balance for o in orders)
    income_by_category = {}
    expense_by_category = {}
    for transaction in txs:
        target = income_by_category if transaction.type == "INCOME" else expense_by_category
        target[transaction.category] = target.get(transaction.category, 0) + transaction.amount

    # Group by date and by month for charts
    by_date = {}
    by_month = {}
    for t in reversed(txs):
        d_key = t.date
        m_key = t.date[:7]
        by_date.setdefault(d_key, {"date": d_key, "Income": 0.0, "Expense": 0.0, "Profit": 0.0})
        by_month.setdefault(m_key, {"month": m_key, "Income": 0.0, "Expense": 0.0, "Profit": 0.0})
        if t.type == "INCOME":
            by_date[d_key]["Income"] += t.amount
            by_month[m_key]["Income"] += t.amount
        else:
            by_date[d_key]["Expense"] += t.amount
            by_month[m_key]["Expense"] += t.amount
        by_date[d_key]["Profit"] = by_date[d_key]["Income"] - by_date[d_key]["Expense"]
        by_month[m_key]["Profit"] = by_month[m_key]["Income"] - by_month[m_key]["Expense"]

    return {
        "summary": {
            "total_income": total_income,
            "total_expense": total_expense,
            "net_profit": net_profit,
            "total_orders": len(orders),
            "pending_orders": sum(1 for o in orders if o.balance > 0),
            "completed_orders": sum(1 for o in orders if o.balance == 0),
            "paid_orders": sum(1 for o in orders if o.balance == 0 and o.total_amount > 0),
            "partially_paid_orders": sum(1 for o in orders if 0 < o.paid_amount < o.total_amount),
            "unpaid_orders": sum(1 for o in orders if o.paid_amount <= 0 and o.total_amount > 0),
            "pending_payments": pending_payments
        },
        "income_by_category": [
            {"category": category, "amount": amount}
            for category, amount in sorted(income_by_category.items(), key=lambda item: item[1], reverse=True)
        ],
        "expense_by_category": [
            {"category": category, "amount": amount}
            for category, amount in sorted(expense_by_category.items(), key=lambda item: item[1], reverse=True)
        ],
        "daily_chart": list(by_date.values()),
        "monthly_chart": list(by_month.values()),
        "transactions": txs
    }


def finance_transactions(
    start_date: Optional[str],
    end_date: Optional[str],
    db: Session,
):
    query = db.query(Transaction)
    if start_date:
        query = query.filter(Transaction.date >= start_date)
    if end_date:
        query = query.filter(Transaction.date <= end_date)
    return query.order_by(Transaction.date.asc(), Transaction.id.asc()).all()


@app.get("/api/finance/export.csv")
def export_finance_csv(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: Session = Depends(get_db),
    _: Admin = Depends(require_admin),
):
    transactions = finance_transactions(start_date, end_date, db)
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Date", "Type", "Category", "Description", "Amount", "Payment Method", "Reference"])
    for transaction in transactions:
        writer.writerow([
            transaction.date,
            transaction.type,
            transaction.category,
            transaction.description,
            transaction.amount,
            transaction.payment_method,
            transaction.reference,
        ])
    filename = f"lalithas-finance-{start_date or 'all-time'}-to-{end_date or 'today'}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/finance/export.pdf")
def export_finance_pdf(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: Session = Depends(get_db),
    _: Admin = Depends(require_admin),
):
    transactions = finance_transactions(start_date, end_date, db)
    income = sum(t.amount for t in transactions if t.type == "INCOME")
    expense = sum(t.amount for t in transactions if t.type == "EXPENSE")
    pdf_buffer = io.BytesIO()
    report = canvas.Canvas(pdf_buffer, pagesize=A4)
    width, height = A4
    y = height - 48
    report.setTitle("Lalitha's Apparel Financial Report")
    report.setFont("Helvetica-Bold", 16)
    report.drawString(40, y, "Lalitha's Apparel - Financial Report")
    y -= 22
    report.setFont("Helvetica", 9)
    report.drawString(40, y, f"Period: {start_date or 'All time'} to {end_date or 'Today'}")
    y -= 24
    report.setFont("Helvetica-Bold", 10)
    report.drawString(40, y, f"Income: Rs.{income:,.2f}")
    report.drawString(190, y, f"Expenses: Rs.{expense:,.2f}")
    report.drawString(350, y, f"Net: Rs.{income - expense:,.2f}")
    y -= 24
    report.setFont("Helvetica-Bold", 9)
    headers = ["Date", "Type", "Category", "Description", "Amount", "Method"]
    positions = [40, 95, 145, 230, 440, 500]
    for position, header in zip(positions, headers):
        report.drawString(position, y, header)
    y -= 14
    report.setFont("Helvetica", 8)
    for transaction in transactions:
        if y < 45:
            report.showPage()
            y = height - 45
            report.setFont("Helvetica", 8)
        values = [
            transaction.date,
            transaction.type,
            transaction.category[:14],
            transaction.description[:30],
            f"Rs.{transaction.amount:,.2f}",
            transaction.payment_method[:12],
        ]
        for position, value in zip(positions, values):
            report.drawString(position, y, str(value))
        y -= 13
    report.save()
    pdf_buffer.seek(0)
    filename = f"lalithas-finance-{start_date or 'all-time'}-to-{end_date or 'today'}.pdf"
    return StreamingResponse(
        pdf_buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/transactions")
def add_transaction(req: TransactionCreate, db: Session = Depends(get_db), _: Admin = Depends(require_admin)):
    if req.type not in {"INCOME", "EXPENSE"}:
        raise HTTPException(status_code=422, detail="Transaction type must be INCOME or EXPENSE")
    if not math.isfinite(req.amount) or req.amount <= 0:
        raise HTTPException(status_code=422, detail="Transaction amount must be a finite positive number")
    t = Transaction(**req.model_dump())
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


def create_cloud_backup_artifacts(db: Session) -> dict:
    """Create a unique DB snapshot and copy all private file-bucket objects into the private backup bucket."""
    if not storage_is_configured():
        raise HTTPException(status_code=503, detail="Private Supabase Storage is not configured on the backend.")
    try:
        storage_verify_private_bucket(SUPABASE_FILES_BUCKET, {"image/png", "image/jpeg", "application/pdf"})
        storage_verify_private_bucket(
            SUPABASE_BACKUP_BUCKET,
            {"application/octet-stream", "application/json", "image/png", "application/pdf"},
        )
    except StorageError as exc:
        raise HTTPException(status_code=503, detail="Backup requires two private, MIME-restricted Storage buckets.") from exc

    created_at = datetime.now()
    day = created_at.date().isoformat()
    backup_id = f"{created_at.strftime('%H%M%S')}-{secrets.token_hex(8)}"
    database_key = f"database/{day}/{backup_id}.db"
    manifest_key = f"manifests/{day}/{backup_id}.json"
    max_objects = int(os.getenv("BACKUP_MAX_STORAGE_OBJECTS", "200"))
    max_object_bytes = int(os.getenv("BACKUP_MAX_OBJECT_BYTES", str(25 * 1024 * 1024)))
    copied_files = []

    try:
        # The temporary directory is used only for a transient export; no backup is retained on Vercel disk.
        with tempfile.TemporaryDirectory(prefix="lalithas-backup-") as temp_dir:
            database_path = os.path.join(temp_dir, f"{backup_id}.db")
            create_sqlite_snapshot(database_path)
            with open(database_path, "rb") as source_file:
                database_bytes = source_file.read()
            with sqlite3.connect(database_path) as verification_db:
                integrity = verification_db.execute("PRAGMA integrity_check").fetchone()[0]
                if integrity != "ok":
                    raise RuntimeError("Generated database snapshot failed SQLite integrity_check.")
                foreign_key_issues = verification_db.execute("PRAGMA foreign_key_check").fetchall()
                if foreign_key_issues:
                    raise RuntimeError("Generated database snapshot failed SQLite foreign_key_check.")
                table_names = {row[0] for row in verification_db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                ).fetchall()}
                required_tables = {table.name for table in Base.metadata.sorted_tables}
                if not required_tables.issubset(table_names):
                    raise RuntimeError("Generated database snapshot is missing required tables.")
                table_counts = {
                    table.name: verification_db.execute(f'SELECT COUNT(*) FROM "{table.name}"').fetchone()[0]
                    for table in Base.metadata.sorted_tables
                }
            database_sha256 = hashlib.sha256(database_bytes).hexdigest()
            upload_storage_bytes(SUPABASE_BACKUP_BUCKET, database_key, database_bytes, "application/octet-stream")
            remote_database_bytes = storage_download_bytes(SUPABASE_BACKUP_BUCKET, database_key)
            if hashlib.sha256(remote_database_bytes).hexdigest() != database_sha256:
                raise RuntimeError("Uploaded database backup failed SHA-256 read-back verification.")
            restored_copy_path = os.path.join(temp_dir, f"{backup_id}-isolated-restore.db")
            with open(restored_copy_path, "wb") as restored_copy:
                restored_copy.write(remote_database_bytes)
            with sqlite3.connect(restored_copy_path) as isolated_restore_db:
                isolated_integrity = isolated_restore_db.execute("PRAGMA integrity_check").fetchone()[0]
                isolated_counts = {
                    table.name: isolated_restore_db.execute(f'SELECT COUNT(*) FROM "{table.name}"').fetchone()[0]
                    for table in Base.metadata.sorted_tables
                }
                if isolated_integrity != "ok" or isolated_counts != table_counts:
                    raise RuntimeError("Downloaded database backup failed isolated restore verification.")

        files = storage_list_objects(SUPABASE_FILES_BUCKET, max_objects=max_objects)
        for item in files:
            source_key = item["key"]
            payload = storage_download_bytes(SUPABASE_FILES_BUCKET, source_key)
            if len(payload) > max_object_bytes:
                raise RuntimeError(
                    f"A file in private Storage exceeds BACKUP_MAX_OBJECT_BYTES ({max_object_bytes} bytes); backup stopped without a completion manifest."
                )
            sha256 = hashlib.sha256(payload).hexdigest()
            backup_object_key = f"storage-objects/{day}/{backup_id}/{source_key}"
            metadata = item.get("metadata") or {}
            content_type = metadata.get("mimetype") or metadata.get("contentType") or "application/octet-stream"
            upload_storage_bytes(SUPABASE_BACKUP_BUCKET, backup_object_key, payload, content_type)
            stored_payload = storage_download_bytes(SUPABASE_BACKUP_BUCKET, backup_object_key)
            if hashlib.sha256(stored_payload).hexdigest() != sha256:
                raise RuntimeError(f"Storage backup failed SHA-256 read-back verification for object {source_key!r}.")
            copied_files.append({
                "source_bucket": SUPABASE_FILES_BUCKET,
                "source_key": source_key,
                "backup_bucket": SUPABASE_BACKUP_BUCKET,
                "backup_key": backup_object_key,
                "size_bytes": len(payload),
                "sha256": sha256,
                "content_type": content_type,
            })

        manifest = {
            "brand": "Lalitha's Apparel",
            "backup_id": backup_id,
            "created_at": created_at.isoformat(timespec="seconds"),
            "database": {
                "engine": "Supabase PostgreSQL" if primary_is_supabase() else "SQLite development database",
                "backup_bucket": SUPABASE_BACKUP_BUCKET,
                "object_key": database_key,
                "size_bytes": len(database_bytes),
                "sha256": database_sha256,
                "sqlite_integrity_check": integrity,
                "foreign_key_check": "passed",
                "isolated_restore_integrity_check": isolated_integrity,
                "table_counts": table_counts,
            },
            "record_counts": {
                "customers": db.query(Customer).count(),
                "orders": db.query(Order).count(),
                "transactions": db.query(Transaction).count(),
            },
            "files_bucket": SUPABASE_FILES_BUCKET,
            "file_objects": copied_files,
            "file_object_count": len(copied_files),
            "verification": "Database and copied file objects read back and SHA-256 verified.",
        }
        manifest_bytes = json.dumps(manifest, indent=2, sort_keys=True).encode("utf-8")
        upload_storage_bytes(SUPABASE_BACKUP_BUCKET, manifest_key, manifest_bytes, "application/json")
        if hashlib.sha256(storage_download_bytes(SUPABASE_BACKUP_BUCKET, manifest_key)).hexdigest() != hashlib.sha256(manifest_bytes).hexdigest():
            raise RuntimeError("Uploaded backup manifest failed SHA-256 read-back verification.")
        return {
            "status": "ok",
            "backup_id": backup_id,
            "bucket": SUPABASE_BACKUP_BUCKET,
            "database_object": database_key,
            "manifest_object": manifest_key,
            "file_object_count": len(copied_files),
            "integrity_verified": True,
        }
    except HTTPException:
        raise
    except (OSError, RuntimeError, StorageError, sqlite3.Error, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"Cloud backup did not complete: {exc}") from exc


@app.post("/api/backup")
def backup_database(db: Session = Depends(get_db), _: Admin = Depends(require_admin)):
    if storage_is_configured():
        return create_cloud_backup_artifacts(db)
    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    dest = os.path.join(BACKUP_DIR, f"backup_{stamp}.db")
    create_sqlite_snapshot(dest)
    return {"status": "ok", "backup_file": dest, "storage": "local-development-only"}


@app.post("/api/restore")
async def restore_database(file: UploadFile = File(...), _: Admin = Depends(require_admin)):
    if IS_SERVERLESS_DEPLOYMENT:
        raise HTTPException(
            status_code=409,
            detail=(
                "Production restore is intentionally disabled in this endpoint because a database-only restore "
                "could leave drawings and invoice objects inconsistent. Follow the documented isolated full restore procedure."
            ),
        )
    if not file.filename or not file.filename.lower().endswith((".db", ".sqlite", ".sqlite3")):
        raise HTTPException(status_code=400, detail="Upload a SQLite backup file (.db, .sqlite, or .sqlite3).")

    os.makedirs(BACKUP_DIR, exist_ok=True)
    current_backup = os.path.join(
        BACKUP_DIR,
        f"before_restore_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.db",
    )
    uploaded_path = None
    try:
        create_sqlite_snapshot(current_backup)
        with tempfile.NamedTemporaryFile(mode="wb", suffix=".db", dir=BACKUP_DIR, delete=False) as uploaded_file:
            uploaded_path = uploaded_file.name
            while chunk := await file.read(1024 * 1024):
                uploaded_file.write(chunk)

        restored_counts = restore_sqlite_backup(uploaded_path)
        return {
            "status": "restored",
            "backup_before_restore": current_backup,
            "restored_counts": restored_counts,
        }
    except (OSError, sqlite3.Error, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        await file.close()
        if uploaded_path and os.path.exists(uploaded_path):
            os.remove(uploaded_path)


@app.get("/api/cloud-backup/status")
def cloud_backup_status(_: Admin = Depends(require_admin)):
    return {
        "primary_database": "supabase-postgres" if primary_is_supabase() else "local-sqlite",
        "database_configured": primary_is_supabase(),
        "local_sqlite_backup": not IS_SERVERLESS_DEPLOYMENT,
        "configured": storage_is_configured(),
        "files_bucket": SUPABASE_FILES_BUCKET if storage_is_configured() else None,
        "backup_bucket": SUPABASE_BACKUP_BUCKET if storage_is_configured() else None,
        "cloud_backup_includes_file_objects": True,
    }


@app.post("/api/cloud-backup")
def cloud_backup(db: Session = Depends(get_db), _: Admin = Depends(require_admin)):
    if not storage_is_configured():
        raise HTTPException(
            status_code=503,
            detail="Cloud backup requires the backend-only Supabase Storage credentials to be configured.",
        )
    return create_cloud_backup_artifacts(db)
