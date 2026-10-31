"""One-time migration of existing local drawings/invoices to private Supabase Storage.

Dry run by default. Pass --apply to upload objects and update PostgreSQL.
Run on the machine containing the existing local drawing/PDF files after applying
backend/migrations/0001_order_storage_object_keys.sql and creating the private bucket.
"""
from __future__ import annotations

import argparse
import os
import secrets
import sys
from pathlib import Path

# Import the application models without allowing production startup seeding/migrations.
os.environ["APP_ENV"] = "production"
if not os.environ.get("APP_SECRET_KEY"):
    os.environ["APP_SECRET_KEY"] = secrets.token_urlsafe(48)

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main  # noqa: E402
from storage import StorageError, upload_bytes, verify_private_bucket  # noqa: E402


def existing_drawing_path(raw_path: str | None) -> Path | None:
    if not raw_path:
        return None
    supplied = Path(raw_path).expanduser()
    candidates = [supplied, Path(main.DRAWING_DIR) / supplied.name]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def upload_object(bucket: str, key: str, content: bytes, content_type: str) -> None:
    try:
        upload_bytes(bucket, key, content, content_type, upsert=False)
    except StorageError as exc:
        raise RuntimeError(str(exc)) from exc


def run(apply: bool) -> int:
    if not main.primary_is_supabase():
        raise RuntimeError("SUPABASE_DATABASE_URL must point to the target PostgreSQL database.")
    if not main.storage_is_configured():
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")
    verify_private_bucket(main.SUPABASE_FILES_BUCKET, {"image/png", "application/pdf"})
    columns = {column["name"] for column in main.inspect(main.engine).get_columns("orders")}
    needed = {"drawing_object_key", "invoice_object_key"}
    if not needed.issubset(columns):
        raise RuntimeError("Apply migrations/0001_order_storage_object_keys.sql before running this script.")

    db = main.SessionLocal()
    uploads_done: list[tuple[str, str]] = []
    drawing_updates = 0
    invoice_updates = 0
    try:
        orders = db.query(main.Order).order_by(main.Order.id.asc()).all()
        for order in orders:
            if not order.drawing_object_key and order.drawing_path:
                source_path = existing_drawing_path(order.drawing_path)
                if source_path is None:
                    raise RuntimeError(
                        f"Order {order.id} has a legacy drawing path that cannot be found on this machine. "
                        "No database changes were committed; restore the source file and rerun."
                    )
                drawing_key = main.new_object_key("drawings", order.invoice_number, "png")
                print(f"Drawing found for order {order.id}: {source_path.name} -> {drawing_key}")
                if apply:
                    upload_object(main.SUPABASE_FILES_BUCKET, drawing_key, source_path.read_bytes(), "image/png")
                    uploads_done.append((main.SUPABASE_FILES_BUCKET, drawing_key))
                    order.drawing_object_key = drawing_key
                    # Keep original file on disk but stop storing a machine-specific path in PostgreSQL.
                    order.drawing_path = None
                    drawing_updates += 1

            if not order.invoice_object_key:
                local_pdf = Path(main.INVOICE_DIR) / f"{order.invoice_number}.pdf"
                if local_pdf.is_file():
                    pdf_bytes = local_pdf.read_bytes()
                    source_desc = local_pdf.name
                else:
                    customer = db.query(main.Customer).filter(main.Customer.id == order.customer_id).first()
                    product = db.query(main.Product).filter(main.Product.id == order.product_id).first()
                    measurements = db.query(main.OrderMeasurement).filter(main.OrderMeasurement.order_id == order.id).all()
                    pdf_bytes = main.generate_invoice_pdf(order, customer, product, measurements)
                    source_desc = "freshly rendered invoice"
                invoice_key = main.new_object_key("invoices", order.invoice_number, "pdf")
                print(f"Invoice found for order {order.id}: {source_desc} -> {invoice_key}")
                if apply:
                    upload_object(main.SUPABASE_FILES_BUCKET, invoice_key, pdf_bytes, "application/pdf")
                    uploads_done.append((main.SUPABASE_FILES_BUCKET, invoice_key))
                    order.invoice_object_key = invoice_key
                    invoice_updates += 1

        if apply:
            db.commit()
            print(f"COMMITTED: migrated {drawing_updates} drawings and {invoice_updates} invoices.")
            print("Original local files were retained. Verify signed downloads and a full restore before deleting anything locally.")
        else:
            db.rollback()
            would_migrate_drawings = sum(bool(o.drawing_path and not o.drawing_object_key) for o in orders)
            would_migrate_invoices = sum(not o.invoice_object_key for o in orders)
            print(f"DRY RUN: would migrate {would_migrate_drawings} drawings and {would_migrate_invoices} invoices. No files uploaded; no records changed.")
        return 0
    except Exception:
        db.rollback()
        # Uploaded immutable objects may remain orphaned if a later upload failed.
        # Deliberately do not delete them automatically; preserving customer files is safer.
        raise
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Upload files and update object keys (default is dry-run).")
    args = parser.parse_args()
    try:
        raise SystemExit(run(args.apply))
    except Exception as error:
        print(f"Migration failed: {error}", file=sys.stderr)
        raise SystemExit(1)
