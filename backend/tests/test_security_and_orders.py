"""Integration tests use an isolated SQLite database and never touch business data."""

import importlib
import io
import os
import sqlite3
from uuid import uuid4
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image


def make_client(tmp_path: Path) -> TestClient:
    os.environ["APP_ENV"] = "test"
    os.environ["APP_SECRET_KEY"] = "test-only-session-signing-key"
    os.environ["ADMIN_INITIAL_PASSWORD"] = "test-admin-password"
    os.environ["APP_DATA_DIR"] = str(tmp_path / "data")
    os.environ["APP_INVOICE_DIR"] = str(tmp_path / "invoices")
    os.environ["APP_BACKUP_DIR"] = str(tmp_path / "backups")
    os.environ.pop("SUPABASE_DATABASE_URL", None)
    import main

    return TestClient(importlib.reload(main).app)


def login(client: TestClient) -> dict[str, str]:
    response = client.post("/api/login", json={"username": "admin", "password": "test-admin-password"})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['token']}"}


def page_items(response) -> list[dict]:
    payload = response.json()
    return payload if isinstance(payload, list) else payload["items"]


def test_protected_endpoints_and_signed_login(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        assert client.get("/api/customers").status_code == 401
        assert client.post("/api/login", json={"username": "admin", "password": "wrong-password"}).status_code == 401
        headers = login(client)
        assert client.get("/api/customers", headers=headers).status_code == 200
        assert client.get("/api/finance", headers=headers).status_code == 200
        assert client.post("/api/logout", headers=headers).status_code == 200
        assert client.get("/api/finance", headers=headers).status_code == 401


def test_paginated_responses_do_not_return_unbounded_lists(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        response = client.get("/api/customers?limit=1&offset=0", headers=headers)
        assert response.status_code == 200
        page = response.json()
        assert page["limit"] == 1
        assert len(page["items"]) <= 1
        assert page["total"] >= len(page["items"])


def test_every_sensitive_route_rejects_unauthenticated_requests(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        cases = [
            ("get", "/api/customers", {}),
            ("post", "/api/customers", {"json": {"name": "Blocked", "phone": "9000000000"}}),
            ("get", "/api/templates", {}),
            ("post", "/api/templates", {"json": {"name": "Blocked", "fields": ["Bust"]}}),
            ("get", "/api/products", {}),
            ("post", "/api/products", {"json": {"name": "Blocked", "pricing_type": "MANUAL"}}),
            ("patch", "/api/products/1/toggle", {}),
            ("get", "/api/embroidery-rates", {}),
            ("put", "/api/embroidery-rates", {"json": {"category": "Blocked", "rate_per_stitch": 1}}),
            ("get", "/api/orders", {}),
            ("post", "/api/orders", {"json": {"customer_id": 1, "product_id": 1, "order_date": "2026-10-19", "total_amount": 1, "paid_amount": 0}}),
            ("post", "/api/orders/1/pay", {"json": {"additional_paid": 1}}),
            ("get", "/api/orders/1/pdf", {}),
            ("get", "/api/finance", {}),
            ("get", "/api/finance/export.csv", {}),
            ("get", "/api/finance/export.pdf", {}),
            ("post", "/api/transactions", {"json": {"date": "2026-10-19", "type": "EXPENSE", "category": "Blocked", "description": "Blocked", "amount": 1}}),
            ("post", "/api/backup", {}),
            ("post", "/api/restore", {"files": {"file": ("blocked.db", b"not-a-database", "application/octet-stream")}}),
            ("get", "/api/cloud-backup/status", {}),
            ("post", "/api/cloud-backup", {}),
            ("get", "/api/voice/session", {}),
            ("delete", "/api/voice/session", {}),
            ("post", "/api/voice/turn", {"json": {"text": "How many pending orders today?"}}),
            ("post", "/api/voice/confirm", {"json": {"confirmation_id": "x" * 16, "confirmation_phrase": "confirm x"}}),
            ("post", "/api/voice/cancel", {"json": {"scope": "draft"}}),
            ("patch", "/api/voice/draft", {"json": {"total_amount": 1}}),
            ("post", "/api/voice/transcribe", {"files": {"audio": ("voice.txt", b"no", "text/plain")}}),
        ]
        for method, path, kwargs in cases:
            assert getattr(client, method)(path, **kwargs).status_code == 401, f"{method.upper()} {path}"


def test_server_calculates_embroidery_and_rejects_invalid_payments(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        customers = page_items(client.get("/api/customers", headers=headers))
        products = client.get("/api/products", headers=headers).json()
        embroidery = next(product for product in products if product["name"] == "Embroidery")
        created = client.post("/api/orders", headers=headers, json={
            "customer_id": customers[0]["id"],
            "product_id": embroidery["id"],
            "order_date": "2026-10-19",
            "embroidery_category": "Business",
            "stitch_count": 1000,
            "rate_per_stitch": 9999,
            "base_amount": 0,
            "extra_amount": 0,
            "total_amount": 1,
            "paid_amount": 10,
            "measurements": [],
            "idempotency_key": str(uuid4()),
        })
        assert created.status_code == 200
        order_id = created.json()["id"]
        order = next(item for item in page_items(client.get("/api/orders", headers=headers)) if item["id"] == order_id)
        assert order["total_amount"] == 40.0
        assert order["balance"] == 30.0
        assert client.post(f"/api/orders/{order_id}/pay", headers=headers, json={"additional_paid": 31, "idempotency_key": str(uuid4())}).status_code == 422
        payment_key = str(uuid4())
        assert client.post(f"/api/orders/{order_id}/pay", headers=headers, json={"additional_paid": 30, "idempotency_key": payment_key}).status_code == 200
        assert client.post(f"/api/orders/{order_id}/pay", headers=headers, json={"additional_paid": 30, "idempotency_key": payment_key}).json()["status"] == "idempotent_replay"


def test_invoice_image_is_request_only_and_pdf_is_never_saved(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        customer = page_items(client.get("/api/customers", headers=headers))[0]
        product = next(item for item in client.get("/api/products", headers=headers).json() if item["name"] == "Embroidery")
        created = client.post("/api/orders", headers=headers, json={
            "customer_id": customer["id"], "product_id": product["id"], "order_date": "2026-10-29",
            "embroidery_category": "Business", "stitch_count": 10, "rate_per_stitch": 0,
            "base_amount": 0, "extra_amount": 0, "total_amount": 0, "paid_amount": 0,
            "measurements": [], "idempotency_key": str(uuid4()),
        }).json()
        image_buffer = io.BytesIO()
        Image.new("RGB", (8, 8), "red").save(image_buffer, format="PNG")
        response = client.post(
            f"/api/orders/{created['id']}/invoice", headers=headers,
            files={"image": ("reference.png", image_buffer.getvalue(), "image/png")},
        )
        assert response.status_code == 200
        assert response.content.startswith(b"%PDF")
        import main
        with main.SessionLocal() as db:
            order = db.get(main.Order, created["id"])
            assert order.reference_image_object_key is None
            assert order.invoice_object_key is None
        assert not list((tmp_path / "invoices").glob("*.pdf"))


def test_voice_conversation_preserves_draft_and_requires_confirmed_save(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        customer = client.post("/api/customers", headers=headers, json={"name": "Voice Priya", "phone": "9222222222"}).json()
        product = client.post("/api/products", headers=headers, json={
            "name": "Voice Blouse", "pricing_type": "MANUAL", "base_price": 0,
        })
        assert product.status_code == 200
        start = client.post("/api/voice/turn", headers=headers, json={"text": "Create an order for Voice Priya for Voice Blouse"})
        assert start.status_code == 200
        assert start.json()["task"]["intent"] == "create_order"
        report = client.post("/api/voice/turn", headers=headers, json={"text": "How many pending orders today?"})
        assert "orders" in report.json()["reply"]
        assert client.post("/api/voice/turn", headers=headers, json={"text": "total 500"}).status_code == 200
        ready = client.post("/api/voice/turn", headers=headers, json={"text": "delivery 2026-11-01"})
        assert ready.status_code == 200
        pending = ready.json()["pending_operation"]
        assert pending
        bad_confirmation = client.post("/api/voice/confirm", headers=headers, json={
            "confirmation_id": pending["confirmation_id"], "confirmation_phrase": "yes",
        })
        assert bad_confirmation.status_code == 422
        confirmed = client.post("/api/voice/confirm", headers=headers, json={
            "confirmation_id": pending["confirmation_id"],
            "confirmation_phrase": f"confirm {pending['confirmation_id']}",
        })
        assert confirmed.status_code == 200
        assert "created successfully" in confirmed.json()["reply"]
        orders = page_items(client.get("/api/orders", headers=headers))
        saved_order = next(order for order in orders if order["customer_name"] == customer["name"])
        payment = client.post("/api/voice/turn", headers=headers, json={"text": f"Record payment 100 for order {saved_order['id']}"})
        assert payment.status_code == 200
        payment_pending = payment.json()["pending_operation"]
        paid = client.post("/api/voice/confirm", headers=headers, json={
            "confirmation_id": payment_pending["confirmation_id"],
            "confirmation_phrase": f"confirm {payment_pending['confirmation_id']}",
        })
        assert paid.status_code == 200
        assert "Payment recorded successfully" in paid.json()["reply"]
        delivery = client.post("/api/voice/turn", headers=headers, json={"text": f"Move order {saved_order['id']} to 2026-11-02"})
        delivery_pending = delivery.json()["pending_operation"]
        delivered = client.post("/api/voice/confirm", headers=headers, json={
            "confirmation_id": delivery_pending["confirmation_id"],
            "confirmation_phrase": f"confirm {delivery_pending['confirmation_id']}",
        })
        assert delivered.status_code == 200
        assert "2026-11-02" in delivered.json()["reply"]


def test_voice_audio_rejects_unsupported_and_empty_recordings(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        unsupported = client.post("/api/voice/transcribe", headers=headers, files={"audio": ("voice.txt", b"test", "text/plain")})
        assert unsupported.status_code == 415
        empty = client.post("/api/voice/transcribe", headers=headers, files={"audio": ("voice.webm", b"", "audio/webm")})
        assert empty.status_code == 422
        webm_with_codec_parameter = client.post("/api/voice/transcribe", headers=headers, files={
            "audio": ("voice.webm", b"", "audio/webm;codecs=opus")
        })
        assert webm_with_codec_parameter.status_code == 422


def test_isolated_sqlite_snapshot_and_restore(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        import main

        headers = login(client)
        before = len(page_items(client.get("/api/customers", headers=headers)))
        snapshot = tmp_path / "verified-backup.db"
        main.create_sqlite_snapshot(str(snapshot))
        with sqlite3.connect(snapshot) as backup:
            assert backup.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        created = client.post("/api/customers", headers=headers, json={
            "name": "Isolated Restore Test", "phone": "9000000000"
        })
        assert created.status_code == 200
        assert len(page_items(client.get("/api/customers", headers=headers))) == before + 1
        restored = main.restore_sqlite_backup(str(snapshot))
        assert restored["customers"] == before
        assert len(page_items(client.get("/api/customers", headers=headers))) == before


def test_isolated_database_persists_after_backend_reload(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        created = client.post("/api/customers", headers=headers, json={
            "name": "Restart Persistence Test", "phone": "9111111111"
        })
        assert created.status_code == 200
        customer_id = created.json()["id"]

    import main
    reloaded = importlib.reload(main)
    with TestClient(reloaded.app) as restarted_client:
        headers = login(restarted_client)
        customer_ids = {customer["id"] for customer in page_items(restarted_client.get("/api/customers", headers=headers))}
        assert customer_id in customer_ids


def test_voice_reports_use_live_values_and_separate_order_value_from_collections(tmp_path: Path) -> None:
    from business_time import business_today

    with make_client(tmp_path) as client:
        headers = login(client)
        customer = client.post("/api/customers", headers=headers, json={
            "name": "Ravi Kumar", "phone": "9333333333"
        }).json()
        product = client.post("/api/products", headers=headers, json={
            "name": "Report Blouse", "pricing_type": "MANUAL", "base_price": 0
        })
        assert product.status_code == 200
        created = client.post("/api/orders", headers=headers, json={
            "customer_id": customer["id"],
            "product_id": product.json()["id"],
            "order_date": business_today().isoformat(),
            "base_amount": 1000,
            "extra_amount": 0,
            "total_amount": 1000,
            "paid_amount": 300,
            "measurements": [],
            "idempotency_key": str(uuid4()),
        })
        assert created.status_code == 200

        sales = client.post("/api/voice/turn", headers=headers, json={"text": "What is today's sales?"})
        assert sales.status_code == 200
        sales_reply = sales.json()["reply"]
        assert "Rs. 1,000.00" in sales_reply
        assert "Rs. 300.00" in sales_reply
        assert "not the same as money collected" in sales_reply

        collected = client.post("/api/voice/turn", headers=headers, json={
            "text": "How much money was collected today?"
        })
        assert collected.status_code == 200
        assert "Rs. 300.00" in collected.json()["reply"]

        collected_spoken = client.post("/api/voice/turn", headers=headers, json={
            "text": "How much money did we collect today?"
        })
        assert collected_spoken.status_code == 200
        assert "Rs. 300.00" in collected_spoken.json()["reply"]

        customer_lookup = client.post("/api/voice/turn", headers=headers, json={
            "text": "Show me Ravi Kumar"
        })
        assert customer_lookup.status_code == 200
        assert "Ravi Kumar" in customer_lookup.json()["reply"]

        outstanding = client.post("/api/voice/turn", headers=headers, json={
            "text": "What is the total outstanding?"
        })
        assert outstanding.status_code == 200
        assert "Rs. 700.00" in outstanding.json()["reply"]

        tamil_sales = client.post("/api/voice/turn", headers=headers, json={
            "text": "இன்று விற்பனை என்ன?"
        })
        assert tamil_sales.status_code == 200
        assert "Rs. 1,000.00" in tamil_sales.json()["reply"]

        tamil_count = client.post("/api/voice/turn", headers=headers, json={
            "text": "இன்று எத்தனை ஆர்டர்?"
        })
        assert tamil_count.status_code == 200
        assert "1 orders" in tamil_count.json()["reply"]

        destructive = client.post("/api/voice/turn", headers=headers, json={
            "text": "delete all orders"
        })
        assert destructive.status_code == 200
        assert "cannot delete" in destructive.json()["reply"]
        assert len(page_items(client.get("/api/orders", headers=headers))) == 1


def test_voice_confirmation_rejects_mismatch_and_deduplicates_completion(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        customer = client.post("/api/customers", headers=headers, json={
            "name": "Confirm Priya", "phone": "9444444444"
        }).json()
        product = client.post("/api/products", headers=headers, json={
            "name": "Confirm Blouse", "pricing_type": "MANUAL", "base_price": 0
        }).json()

        assert client.post("/api/voice/turn", headers=headers, json={
            "text": "Create an order for Confirm Priya for Confirm Blouse"
        }).status_code == 200
        assert client.post("/api/voice/turn", headers=headers, json={"text": "total 500"}).status_code == 200
        ready = client.post("/api/voice/turn", headers=headers, json={"text": "delivery 2026-11-09"})
        pending = ready.json()["pending_operation"]
        assert pending and pending["preview"]["total_amount"] == 500

        mismatch = client.post("/api/voice/confirm", headers=headers, json={
            "confirmation_id": pending["confirmation_id"],
            "confirmation_phrase": "confirm order for Confirm Priya total 999",
        })
        assert mismatch.status_code == 422
        assert len(page_items(client.get("/api/orders", headers=headers))) == 0

        id_only = client.post("/api/voice/confirm", headers=headers, json={
            "confirmation_id": pending["confirmation_id"],
            "confirmation_phrase": pending["confirmation_id"],
        })
        assert id_only.status_code == 422
        assert len(page_items(client.get("/api/orders", headers=headers))) == 0

        phrase = f"confirm order for {pending['preview']['customer']} total 500"
        confirmed = client.post("/api/voice/confirm", headers=headers, json={
            "confirmation_id": pending["confirmation_id"],
            "confirmation_phrase": phrase,
        })
        assert confirmed.status_code == 200
        assert "created successfully" in confirmed.json()["reply"]
        orders = page_items(client.get("/api/orders", headers=headers))
        assert len(orders) == 1

        replay = client.post("/api/voice/confirm", headers=headers, json={
            "confirmation_id": pending["confirmation_id"],
            "confirmation_phrase": phrase,
        })
        assert replay.status_code == 200
        assert "not submitted again" in replay.json()["reply"]
        assert len(page_items(client.get("/api/orders", headers=headers))) == 1


def test_voice_draft_patch_validates_fields_and_cancel_clears_temporary_state(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        customer = client.post("/api/customers", headers=headers, json={
            "name": "Draft Priya", "phone": "9555555555"
        }).json()
        product = client.post("/api/products", headers=headers, json={
            "name": "Draft Blouse", "pricing_type": "MANUAL", "base_price": 0
        }).json()

        started = client.post("/api/voice/turn", headers=headers, json={
            "text": "Create an order for Draft Priya for Draft Blouse"
        })
        assert started.status_code == 200
        invalid = client.patch("/api/voice/draft", headers=headers, json={
            "measurements": {"Waist": "30 in"}
        })
        assert invalid.status_code == 200
        assert "could not match" in invalid.json()["reply"]
        assert invalid.json()["pending_operation"] is None

        patched = client.patch("/api/voice/draft", headers=headers, json={
            "total_amount": 800,
            "delivery_date": "2026-11-07",
        })
        assert patched.status_code == 200
        pending = patched.json()["pending_operation"]
        assert pending and pending["preview"]["total_amount"] == 800
        assert pending["preview"]["delivery_date"] == "2026-11-07"

        discarded = client.post("/api/voice/cancel", headers=headers, json={"scope": "pending"})
        assert discarded.status_code == 200
        assert discarded.json()["pending_operation"] is None
        assert discarded.json()["task"] is not None

        cancelled = client.post("/api/voice/cancel", headers=headers, json={"scope": "draft"})
        assert cancelled.status_code == 200
        assert cancelled.json()["task"] is None

        cleared = client.delete("/api/voice/session", headers=headers)
        assert cleared.status_code == 200
        session = client.get("/api/voice/session", headers=headers)
        assert session.status_code == 200
        assert session.json()["messages"] == []
        assert session.json()["task"] is None


def test_voice_refuses_stitch_based_products_instead_of_guessing_price(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        customer = client.post("/api/customers", headers=headers, json={
            "name": "Stitch Priya", "phone": "9666666666"
        }).json()
        product = client.post("/api/products", headers=headers, json={
            "name": "Stitch Work", "pricing_type": "STITCH_BASED", "base_price": 0
        }).json()

        response = client.post("/api/voice/turn", headers=headers, json={
            "text": "Create an order for Stitch Priya for Stitch Work"
        })
        assert response.status_code == 200
        payload = response.json()
        assert payload["pending_operation"] is None
        assert "priced per stitch" in payload["reply"]
        assert len(page_items(client.get("/api/orders", headers=headers))) == 0


def test_voice_handles_tamil_order_draft_amount_and_date(tmp_path: Path) -> None:
    from business_time import business_today
    from datetime import timedelta

    with make_client(tmp_path) as client:
        headers = login(client)
        customer = client.post("/api/customers", headers=headers, json={
            "name": "பிரியா", "phone": "9777777777"
        }).json()
        product = client.post("/api/products", headers=headers, json={
            "name": "பிளவுஸ்", "pricing_type": "MANUAL", "base_price": 0
        }).json()

        started = client.post("/api/voice/turn", headers=headers, json={
            "text": "பிரியா க்கு பிளவுஸ் ஆர்டர் போடு"
        })
        assert started.status_code == 200
        draft = started.json()["task"]["draft"]
        assert draft["customer_id"] == customer["id"]
        assert draft["product_id"] == product["id"]

        amount = client.post("/api/voice/turn", headers=headers, json={"text": "மொத்தம் 750"})
        assert amount.status_code == 200
        assert amount.json()["task"]["draft"]["total_amount"] == 750

        ready = client.post("/api/voice/turn", headers=headers, json={"text": "டெலிவரி நாளை"})
        pending = ready.json()["pending_operation"]
        expected_date = (business_today() + timedelta(days=1)).isoformat()
        assert pending["preview"]["delivery_date"] == expected_date

        phrase = f"confirm order for {pending['preview']['customer']} total 750"
        confirmed = client.post("/api/voice/confirm", headers=headers, json={
            "confirmation_id": pending["confirmation_id"],
            "confirmation_phrase": phrase,
        })
        assert confirmed.status_code == 200
        orders = page_items(client.get("/api/orders", headers=headers))
        assert len(orders) == 1
        assert orders[0]["total_amount"] == 750
        assert orders[0]["customer_name"] == customer["name"]


def test_voice_draft_accepts_delivery_answer_and_switches_to_payment(tmp_path: Path) -> None:
    from business_time import business_today
    from datetime import timedelta

    with make_client(tmp_path) as client:
        headers = login(client)
        customer = client.post("/api/customers", headers=headers, json={
            "name": "Draft Priya", "phone": "9888888888"
        }).json()
        product = client.post("/api/products", headers=headers, json={
            "name": "Draft Saree Falls", "pricing_type": "MANUAL", "base_price": 0
        }).json()
        existing_order = client.post("/api/orders", headers=headers, json={
            "customer_id": customer["id"],
            "product_id": product["id"],
            "order_date": business_today().isoformat(),
            "base_amount": 1200,
            "extra_amount": 0,
            "total_amount": 1200,
            "paid_amount": 200,
            "measurements": [],
            "idempotency_key": str(uuid4()),
        })
        assert existing_order.status_code == 200
        invoice = existing_order.json()["invoice_number"]

        assert client.post("/api/voice/turn", headers=headers, json={
            "text": "Create an order for Draft Priya for Draft Saree Falls"
        }).status_code == 200
        assert client.post("/api/voice/turn", headers=headers, json={
            "text": "total 600"
        }).json()["task"]["draft"]["total_amount"] == 600

        delivery = client.post("/api/voice/turn", headers=headers, json={
            "text": "delivery tomorrow"
        }).json()
        expected_date = (business_today() + timedelta(days=1)).isoformat()
        assert delivery["pending_operation"]["preview"]["delivery_date"] == expected_date
        assert delivery["pending_operation"]["action"] == "create_order"

        payment = client.post("/api/voice/turn", headers=headers, json={
            "text": f"Record a payment of 100 for {invoice}"
        }).json()
        assert payment["pending_operation"]["action"] == "record_payment"
        assert payment["task"] is None
        assert payment["pending_operation"]["preview"]["payment_amount"] == 100

        confirmed = client.post("/api/voice/confirm", headers=headers, json={
            "confirmation_id": payment["pending_operation"]["confirmation_id"],
            "confirmation_phrase": f"confirm payment of 100 for {invoice}",
        })
        assert confirmed.status_code == 200
        orders = page_items(client.get("/api/orders", headers=headers))
        assert len(orders) == 1
        assert orders[0]["paid_amount"] == 300
