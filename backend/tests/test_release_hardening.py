"""Release-hardening tests: edge cases, abuse cases, and data-integrity rules.

These tests run against an isolated SQLite database and never touch business data.
They complement the workflow and voice regression suites.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import importlib
import io
import json
import os
import sqlite3
import time
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient


def make_client(tmp_path: Path) -> TestClient:
    os.environ["APP_ENV"] = "test"
    os.environ["APP_SECRET_KEY"] = "release-hardening-test-key"
    os.environ["ADMIN_INITIAL_PASSWORD"] = "release-test-password"
    os.environ["APP_DATA_DIR"] = str(tmp_path / "data")
    os.environ["APP_INVOICE_DIR"] = str(tmp_path / "invoices")
    os.environ["APP_BACKUP_DIR"] = str(tmp_path / "backups")
    os.environ.pop("SUPABASE_DATABASE_URL", None)
    os.environ.pop("FRONTEND_ORIGIN", None)
    import main

    return TestClient(importlib.reload(main).app)


def login(client: TestClient, password: str = "release-test-password") -> dict[str, str]:
    response = client.post("/api/login", json={"username": "admin", "password": password})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


def page_items(response) -> list[dict]:
    payload = response.json()
    return payload if isinstance(payload, list) else payload["items"]


def measurements_for(client: TestClient, headers: dict[str, str], product_id: int) -> list[dict]:
    templates = client.get("/api/templates", headers=headers).json()
    products = client.get("/api/products", headers=headers).json()
    product = next(item for item in products if item["id"] == product_id)
    if not product.get("measurement_template_id"):
        return []
    template = next(t for t in templates if t["id"] == product["measurement_template_id"])
    return [{"field_name": field, "value": "10 in"} for field in template["fields"]]


def order_payload(client: TestClient, headers: dict[str, str], **overrides) -> dict:
    customer = page_items(client.get("/api/customers", headers=headers))[0]
    product = next(p for p in client.get("/api/products", headers=headers).json() if p["name"] == "Normal Blouse")
    payload = {
        "customer_id": customer["id"],
        "product_id": product["id"],
        "order_date": "2026-11-03",
        "delivery_date": "2026-11-10",
        "base_amount": 800,
        "total_amount": 800,
        "paid_amount": 0,
        "measurements": measurements_for(client, headers, product["id"]),
        "idempotency_key": str(uuid4()),
    }
    payload.update(overrides)
    return payload


def test_tampered_expired_and_revoked_tokens_are_rejected(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        import main

        headers = login(client)
        token = headers["Authorization"].split(" ", 1)[1]
        header, payload, signature = token.split(".")

        tampered = f"{header}.{payload}.{'A' * len(signature)}"
        assert client.get("/api/customers", headers={"Authorization": f"Bearer {tampered}"}).status_code == 401
        assert client.get("/api/customers", headers={"Authorization": "Bearer not-a-jwt"}).status_code == 401

        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        claims["exp"] = int(time.time()) - 60
        expired_payload = base64.urlsafe_b64encode(
            json.dumps(claims, separators=(",", ":")).encode()
        ).rstrip(b"=").decode()
        expired_signature = hmac.new(
            main.APP_SECRET_KEY.encode(), f"{header}.{expired_payload}".encode(), hashlib.sha256
        ).digest()
        expired_signature = base64.urlsafe_b64encode(expired_signature).rstrip(b"=").decode()
        expired = f"{header}.{expired_payload}.{expired_signature}"
        assert client.get("/api/customers", headers={"Authorization": f"Bearer {expired}"}).status_code == 401

        assert client.post("/api/logout", headers=headers).status_code == 200
        assert client.get("/api/customers", headers=headers).status_code == 401


def test_login_rate_limit_blocks_brute_force(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        for _ in range(5):
            assert client.post("/api/login", json={"username": "admin", "password": "wrong"}).status_code == 401
        blocked = client.post("/api/login", json={"username": "admin", "password": "release-test-password"})
        assert blocked.status_code == 429


def test_security_headers_are_present(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        response = client.post("/api/login", json={"username": "admin", "password": "release-test-password"})
        assert response.status_code == 200
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["x-frame-options"] == "DENY"
        assert response.headers["referrer-policy"] == "no-referrer"


def test_health_endpoint_reports_database_ready(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        response = client.get("/api/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


def test_cors_allows_only_configured_origin(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        allowed = client.options(
            "/api/login",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert allowed.headers.get("access-control-allow-origin") == "http://localhost:5173"
        denied = client.options(
            "/api/login",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert "access-control-allow-origin" not in denied.headers


def test_order_dates_and_transaction_dates_must_be_iso(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        bad_order_date = client.post("/api/orders", headers=headers, json=order_payload(
            client, headers, order_date="03/11/2026"
        ))
        assert bad_order_date.status_code == 422
        bad_delivery = client.post("/api/orders", headers=headers, json=order_payload(
            client, headers, delivery_date="next Tuesday"
        ))
        assert bad_delivery.status_code == 422
        bad_transaction = client.post("/api/transactions", headers=headers, json={
            "date": "03-11-2026", "type": "EXPENSE", "category": "Test", "amount": 10
        })
        assert bad_transaction.status_code == 422
        assert client.post("/api/orders", headers=headers, json=order_payload(client, headers)).status_code == 200


def test_order_rejects_invalid_money_and_measurements(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        assert client.post("/api/orders", headers=headers, json=order_payload(
            client, headers, total_amount=-1
        )).status_code == 422
        infinite_payload = json.dumps(order_payload(client, headers, total_amount=0))
        infinite_payload = infinite_payload.replace('"total_amount": 0', '"total_amount": Infinity')
        assert client.post(
            "/api/orders",
            headers={**headers, "Content-Type": "application/json"},
            content=infinite_payload,
        ).status_code == 422
        assert client.post("/api/orders", headers=headers, json=order_payload(
            client, headers, paid_amount=900, total_amount=800
        )).status_code == 422
        assert client.post("/api/orders", headers=headers, json=order_payload(
            client, headers, measurements=[]
        )).status_code == 422
        assert client.post("/api/orders", headers=headers, json=order_payload(
            client, headers, customer_id=999999
        )).status_code == 404
        assert client.post("/api/orders", headers=headers, json=order_payload(
            client, headers, product_id=999999
        )).status_code == 404
        assert client.post("/api/orders", headers=headers, json=order_payload(
            client, headers, idempotency_key=""
        )).status_code == 422


def test_order_idempotency_and_payment_idempotency(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        payload = order_payload(client, headers)
        first = client.post("/api/orders", headers=headers, json=payload)
        second = client.post("/api/orders", headers=headers, json=payload)
        assert first.status_code == second.status_code == 200
        assert first.json()["id"] == second.json()["id"]
        assert second.json().get("idempotent_replay") is True

        order_id = first.json()["id"]
        payment_key = str(uuid4())
        paid = client.post(f"/api/orders/{order_id}/pay", headers=headers, json={
            "additional_paid": 300, "idempotency_key": payment_key
        })
        assert paid.status_code == 200 and paid.json()["balance"] == 500
        replay = client.post(f"/api/orders/{order_id}/pay", headers=headers, json={
            "additional_paid": 300, "idempotency_key": payment_key
        })
        assert replay.status_code == 200 and replay.json()["status"] == "idempotent_replay"
        other = order_payload(client, headers)
        other_order = client.post("/api/orders", headers=headers, json=other).json()
        conflict = client.post(f"/api/orders/{other_order['id']}/pay", headers=headers, json={
            "additional_paid": 100, "idempotency_key": payment_key
        })
        assert conflict.status_code == 409
        assert client.post(f"/api/orders/{order_id}/pay", headers=headers, json={
            "additional_paid": 9999, "idempotency_key": str(uuid4())
        }).status_code == 422


def test_missing_invoice_payment_and_order_return_404(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        assert client.get("/api/orders/999999/pdf", headers=headers).status_code == 404
        assert client.post("/api/orders/999999/invoice", headers=headers).status_code == 404
        assert client.post("/api/orders/999999/pay", headers=headers, json={
            "additional_paid": 10, "idempotency_key": str(uuid4())
        }).status_code == 404
        assert client.delete("/api/orders/999999", headers=headers).status_code == 404


def test_duplicate_product_and_template_names_return_conflict(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        assert client.post("/api/products", headers=headers, json={
            "name": "Release Duplicate", "pricing_type": "MANUAL", "base_price": 1
        }).status_code == 200
        duplicate_product = client.post("/api/products", headers=headers, json={
            "name": "Release Duplicate", "pricing_type": "MANUAL", "base_price": 1
        })
        assert duplicate_product.status_code == 409
        assert "duplicate_product" not in duplicate_product.text.lower()

        assert client.post("/api/templates", headers=headers, json={
            "name": "Release Template", "fields": ["Bust"]
        }).status_code == 200
        duplicate_template = client.post("/api/templates", headers=headers, json={
            "name": "Release Template", "fields": ["Bust"]
        })
        assert duplicate_template.status_code == 409


def test_blank_names_are_rejected(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        assert client.post("/api/customers", headers=headers, json={"name": "  ", "phone": "9000000000"}).status_code == 422
        assert client.post("/api/customers", headers=headers, json={"name": "Valid", "phone": ""}).status_code == 422
        assert client.post("/api/products", headers=headers, json={"name": "", "pricing_type": "MANUAL"}).status_code == 422
        assert client.post("/api/templates", headers=headers, json={"name": " ", "fields": []}).status_code == 422


def test_pagination_bounds_and_sql_injection_search(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        assert client.get("/api/customers?limit=0", headers=headers).status_code == 422
        assert client.get("/api/customers?limit=251", headers=headers).status_code == 422
        assert client.get("/api/customers?offset=-1", headers=headers).status_code == 422
        assert client.get("/api/orders?limit=251", headers=headers).status_code == 422
        injection = client.get("/api/customers", headers=headers, params={"q": "' OR 1=1 --"})
        assert injection.status_code == 200
        assert injection.json()["items"] == []


def test_customer_delete_requires_cascade(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        customer = client.post("/api/customers", headers=headers, json={
            "name": "Cascade Test", "phone": "9111111111"
        }).json()
        product = next(p for p in client.get("/api/products", headers=headers).json() if p["name"] == "Normal Blouse")
        created = client.post("/api/orders", headers=headers, json={
            "customer_id": customer["id"],
            "product_id": product["id"],
            "order_date": "2026-11-03",
            "delivery_date": "2026-11-10",
            "base_amount": 500,
            "total_amount": 500,
            "paid_amount": 0,
            "measurements": measurements_for(client, headers, product["id"]),
            "idempotency_key": str(uuid4()),
        })
        assert created.status_code == 200
        assert client.delete(f"/api/customers/{customer['id']}", headers=headers).status_code == 409
        cascaded = client.delete(f"/api/customers/{customer['id']}?cascade_orders=true", headers=headers)
        assert cascaded.status_code == 200
        assert cascaded.json()["orders_deleted"] == 1
        remaining = page_items(client.get("/api/orders?limit=250", headers=headers))
        assert all(item["id"] != created.json()["id"] for item in remaining)


def test_finance_exports_are_valid_and_csv_formula_safe(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        dangerous = "=HYPERLINK(\"http://evil.example\",\"click\")"
        assert client.post("/api/transactions", headers=headers, json={
            "date": "2026-11-03", "type": "EXPENSE", "category": "Test",
            "description": dangerous, "amount": 12.5,
        }).status_code == 200
        csv_response = client.get("/api/finance/export.csv", headers=headers)
        assert csv_response.status_code == 200
        assert csv_response.headers["content-type"].startswith("text/csv")
        rows = list(csv.reader(io.StringIO(csv_response.text)))
        description_column = rows[0].index("Description")
        assert rows[1][description_column] == f"'{dangerous}"
        pdf_response = client.get("/api/finance/export.pdf", headers=headers)
        assert pdf_response.status_code == 200
        assert pdf_response.content.startswith(b"%PDF")


def test_restore_rejects_invalid_and_incomplete_backups(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        bad = client.post("/api/restore", headers=headers, files={
            "file": ("bad.db", b"not a sqlite database", "application/octet-stream")
        })
        assert bad.status_code == 422
        blank_path = tmp_path / "blank.db"
        with sqlite3.connect(blank_path):
            pass
        incomplete = client.post("/api/restore", headers=headers, files={
            "file": ("blank.db", blank_path.read_bytes(), "application/octet-stream")
        })
        assert incomplete.status_code == 422
        assert "missing required tables" in incomplete.text


def test_voice_confirmation_is_session_bound_and_replay_safe(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers_a = login(client)
        customer = client.post("/api/customers", headers=headers_a, json={
            "name": "Voice Session Customer", "phone": "9333333333"
        }).json()
        product = client.post("/api/products", headers=headers_a, json={
            "name": "Voice Session Blouse", "pricing_type": "MANUAL", "base_price": 0
        }).json()
        started = client.post("/api/voice/turn", headers=headers_a, json={
            "text": f"Create an order for {customer['name']} for {product['name']}"
        })
        assert started.status_code == 200
        client.post("/api/voice/turn", headers=headers_a, json={"text": "total 400"})
        ready = client.post("/api/voice/turn", headers=headers_a, json={
            "text": "delivery 2026-11-12"
        }).json()
        pending = ready["pending_operation"]
        assert pending

        headers_b = login(client)
        assert headers_b["Authorization"] != headers_a["Authorization"]
        foreign = client.post("/api/voice/confirm", headers=headers_b, json={
            "confirmation_id": pending["confirmation_id"],
            "confirmation_phrase": f"confirm {pending['confirmation_id']}",
        })
        assert foreign.status_code == 409

        confirmed = client.post("/api/voice/confirm", headers=headers_a, json={
            "confirmation_id": pending["confirmation_id"],
            "confirmation_phrase": f"confirm {pending['confirmation_id']}",
        })
        assert confirmed.status_code == 200
        orders = page_items(client.get("/api/orders?limit=250", headers=headers_a))
        assert sum(1 for order in orders if order["customer_name"] == customer["name"]) == 1

        replay = client.post("/api/voice/confirm", headers=headers_a, json={
            "confirmation_id": pending["confirmation_id"],
            "confirmation_phrase": f"confirm {pending['confirmation_id']}",
        })
        assert replay.status_code == 200
        assert "not submitted again" in replay.json()["reply"]
        orders_after = page_items(client.get("/api/orders?limit=250", headers=headers_a))
        assert sum(1 for order in orders_after if order["customer_name"] == customer["name"]) == 1


def test_voice_expired_confirmation_does_not_write(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        import main

        headers = login(client)
        customer = client.post("/api/customers", headers=headers, json={
            "name": "Expiry Customer", "phone": "9444444444"
        }).json()
        product = client.post("/api/products", headers=headers, json={
            "name": "Expiry Blouse", "pricing_type": "MANUAL", "base_price": 0
        }).json()
        client.post("/api/voice/turn", headers=headers, json={
            "text": f"Create an order for {customer['name']} for {product['name']}"
        })
        client.post("/api/voice/turn", headers=headers, json={"text": "total 300"})
        pending = client.post("/api/voice/turn", headers=headers, json={
            "text": "delivery 2026-11-15"
        }).json()["pending_operation"]
        token = headers["Authorization"].split(" ", 1)[1]
        _, sid = main.decode_access_token(token)
        conversation = main.conversation_store.get(1, sid)
        conversation.pending.expires_at = int(time.time()) - 1
        expired = client.post("/api/voice/confirm", headers=headers, json={
            "confirmation_id": pending["confirmation_id"],
            "confirmation_phrase": f"confirm {pending['confirmation_id']}",
        })
        assert expired.status_code == 409
        orders = page_items(client.get("/api/orders?limit=250", headers=headers))
        assert all(order["customer_name"] != customer["name"] for order in orders)


def test_voice_rate_limit_blocks_flood(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        for _ in range(120):
            response = client.post("/api/voice/turn", headers=headers, json={"text": "How many pending orders today?"})
            assert response.status_code == 200
        blocked = client.post("/api/voice/turn", headers=headers, json={"text": "How many pending orders today?"})
        assert blocked.status_code == 429


def test_malformed_and_oversized_json_are_rejected_cleanly(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        headers = login(client)
        malformed = client.post(
            "/api/customers", headers=headers, content=b"{not-json", 
            files=None,
        )
        assert malformed.status_code == 422
        huge = client.post("/api/customers", headers=headers, json={
            "name": "x" * 5000, "phone": "9000000000"
        })
        assert huge.status_code == 422
