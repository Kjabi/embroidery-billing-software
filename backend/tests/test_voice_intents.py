"""Natural-language intent coverage for Tamil, Tanglish, and English queries."""

import importlib
import os
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

import voice_agent
import voice_parsing
import voice_tools
from business_time import business_today
from voice_state import VoiceConversation


SALES_QUESTIONS = [
    "இன்று எவ்வளவு சேல்சி நடந்திருக்கும்?",
    "இன்னைக்கு எவ்வளவு சேல்ஸ்?",
    "இன்று மொத்த விற்பனை எவ்வளவு?",
    "நேற்று எவ்வளவு விற்பனை?",
    "இந்த மாதம் மொத்த விற்பனை எவ்வளவு?",
    "இன்னைக்கு எவ்வளவு சேல்சி?",
    "இன்று எவ்வளவு சேல்ஸ் நடந்திருக்கிறது?",
    "இன்னைக்கு எவ்வளவு விற்பனை?",
    "இன்னைக்கு மொத்தம் எவ்வளவு பிசினஸ் நடந்துச்சு?",
    "இன்று மொத்த விற்பனை என்ன?",
    "இன்னைக்கு sales எவ்வளவு?",
    "Inniku evlo sales?",
    "Innaiku mothama evlo amount sales?",
    "Inniku motham sales evlo?",
    "Innaikku sales evalo?",
    "today sales how much?",
    "How much sales happened today?",
    "Today's total sales?",
    "What is today's sales?",
    "Show today's revenue",
    "How much revenue did we make today?",
    "What was the order value today?",
    "total sales for today",
    "sales amount today please",
    "show me the turnover for today",
    "How much business happened today?",
    "எவ்வளவு business இன்று?",
    "இன்று sales amount எவ்வளவு?",
    "today மொத்த sales எவ்வளவு?",
    "இன்று விற்பனை நடந்ததா?",
    "இன்றைய sales total சொல்லுங்க",
    "இன்று எவ்வளவு revenue வந்தது?",
    "இன்னைக்கு business total என்ன?",
    "today order value please",
    "இந்த மாதத்தோட sales எவ்வளவு?",
    "நேத்து total sales எவ்வளவு?",
    "நேற்று revenue எவ்வளவு?",
    "show me today's business amount",
    "what did we sell today?",
    "how much did the shop sell today?",
    "today total order amount",
    "Inniku business amount evlo?",
    "Nethu sales evalo?",
    "intha maasam motha sales evlo?",
    "இன்று மொத்தம் எவ்வளவு விற்றோம்?",
    "இன்று கடை விற்பனை எவ்வளவு?",
    "சேல்சி இன்று எவ்வளவு?",
    "சேல்ஸ் நடந்ததா இன்று?",
    "இன்றைய விற்பனை தொகையை சொல்லுங்கள்",
    "today sales total amount please",
]


@pytest.mark.parametrize("question", SALES_QUESTIONS)
def test_sales_questions_select_live_sales_query(monkeypatch, question: str) -> None:
    calls = []

    def fake_call(tool, args, db, conversation):
        calls.append((tool, args))
        return voice_agent.AgentReply(
            reply="placeholder",
            data={
                "start_date": "2026-11-05",
                "end_date": "2026-11-05",
                "period": "today",
                "orders": 2,
                "order_value": 1500,
                "collected": 700,
                "average_order_value": 750,
                "note": "Order value is not the same as money collected.",
            },
        )

    monkeypatch.setattr(voice_agent, "_call_read", fake_call)
    conversation = VoiceConversation(session_id="test", admin_id=1, auth_session_id="auth")
    reply = voice_agent._deterministic_turn(None, conversation, question)

    normalized = voice_parsing.business_intent_text(question)
    expected_period = (
        "this_month" if "this month" in normalized
        else "yesterday" if "yesterday" in normalized
        else "today"
    )
    assert calls == [("get_sales_summary", {"period": expected_period})]
    assert reply.data["query_plan"]["intent"] == "sales_summary"
    assert reply.data["query_plan"]["operation"] == "sum"
    assert reply.data["query_plan"]["metric"] == "sales_amount"
    assert reply.data["query_plan"]["date_range"] == expected_period
    assert reply.data["query_plan"]["raw_transcript"] == question
    assert "Rs. 1,500.00" in reply.reply


@pytest.mark.parametrize(
    "question",
    [
        "இன்று எவ்வளவு பணம் கலெக்ட் பண்ணியிருக்கோம்?",
        "இன்னைக்கு collection எவ்வளவு?",
        "How much money was collected today?",
        "Inniku evlo payment vandhudhu?",
        "today payments received",
    ],
)
def test_collection_questions_do_not_select_sales(monkeypatch, question: str) -> None:
    calls = []

    def fake_call(tool, args, db, conversation):
        calls.append((tool, args))
        return voice_agent.AgentReply(reply="collection result", data={})

    monkeypatch.setattr(voice_agent, "_call_read", fake_call)
    conversation = VoiceConversation(session_id="test", admin_id=1, auth_session_id="auth")
    voice_agent._deterministic_turn(None, conversation, question)

    assert calls
    assert calls[0][0] == "get_payment_history"


@pytest.mark.parametrize(
    "question",
    [
        "pending orders",
        "show unpaid orders",
        "open orders please",
        "நிலுவை ஆர்டர் காட்டு",
        "பாக்கி ஆர்டர் எத்தனை?",
        "முடிக்காத ஆர்டர் காட்டு",
    ],
)
def test_pending_order_questions_select_pending_list(monkeypatch, question: str) -> None:
    calls = []

    def fake_call(tool, args, db, conversation):
        calls.append((tool, args))
        return voice_agent.AgentReply(
            reply="pending result", data={"filter": "pending", "count": 0, "orders": []}
        )

    monkeypatch.setattr(voice_agent, "_call_read", fake_call)
    conversation = VoiceConversation(session_id="test", admin_id=1, auth_session_id="auth")
    voice_agent._deterministic_turn(None, conversation, question)

    assert calls
    assert calls[0][0] == "list_orders"
    assert calls[0][1]["filter"] == "pending"


def test_business_normalization_preserves_amounts_and_normalizes_spoken_variants() -> None:
    assert voice_parsing.business_intent_text("இன்று எவ்வளவு சேல்சி நடந்திருக்கும்?") == (
        "today how much sales happened"
    )
    assert voice_parsing.normalize("Rs. 1,250.50") == "rs. 1,250.50"


def test_customer_creation_request_starts_conversational_workflow() -> None:
    conversation = VoiceConversation(session_id="test", admin_id=1, auth_session_id="auth")

    reply = voice_agent._deterministic_turn(None, conversation, "Can we add a new customer?")

    assert conversation.intent == "create_customer"
    assert conversation.missing_fields == ["name", "phone"]
    assert conversation.last_field == "name"
    assert "name" in reply.reply.lower()


def test_customer_creation_collects_fields_and_prepares_preview(monkeypatch) -> None:
    calls = []

    def fake_prepare(tool, args, db, conversation):
        calls.append((tool, args))
        return voice_agent.AgentReply(reply="preview ready", data={"status": "prepared"})

    monkeypatch.setattr(voice_agent, "_call_prepare", fake_prepare)
    conversation = VoiceConversation(session_id="test", admin_id=1, auth_session_id="auth")

    voice_agent._deterministic_turn(None, conversation, "add a new customer")
    voice_agent._deterministic_turn(None, conversation, "Priya")
    reply = voice_agent._deterministic_turn(None, conversation, "9876543210")

    assert reply.reply == "preview ready"
    assert calls == [(
        "prepare_customer_creation",
        {
            "name": "Priya",
            "phone": "9876543210",
            "alternate_phone": "",
            "address": "",
            "city": "Madurai",
            "notes": "",
        },
    )]


def test_customer_creation_voice_flow_saves_and_verifies_record(tmp_path: Path) -> None:
    os.environ["APP_ENV"] = "test"
    os.environ["APP_SECRET_KEY"] = "customer-voice-test-key"
    os.environ["ADMIN_INITIAL_PASSWORD"] = "test-password"
    os.environ["APP_DATA_DIR"] = str(tmp_path / "data")
    os.environ["APP_INVOICE_DIR"] = str(tmp_path / "invoices")
    os.environ["APP_BACKUP_DIR"] = str(tmp_path / "backups")
    os.environ.pop("SUPABASE_DATABASE_URL", None)
    import main

    with TestClient(importlib.reload(main).app) as client:
        login = client.post(
            "/api/login",
            json={"username": "admin", "password": "test-password"},
        )
        headers = {"Authorization": f"Bearer {login.json()['token']}"}

        for text in ("Can we add a new customer?", "Priya", "9876543211"):
            response = client.post("/api/voice/turn", headers=headers, json={"text": text})
            assert response.status_code == 200, response.text

        pending = response.json()["pending_operation"]
        assert pending["action"] == "create_customer"
        assert pending["preview"]["name"] == "Priya"
        assert pending["preview"]["phone"] == "9876543211"

        confirmed = client.post(
            "/api/voice/confirm",
            headers=headers,
            json={
                "confirmation_id": pending["confirmation_id"],
                "confirmation_phrase": "confirm customer Priya 9876543211",
            },
        )
        assert confirmed.status_code == 200, confirmed.text
        confirmed_payload = confirmed.json()
        assert confirmed_payload["data"]["result"]["name"] == "Priya"
        assert confirmed_payload["data"]["verified"] is True
        # The confirmation must report the actual saved details, not a generic message.
        assert "9876543211" in confirmed_payload["reply"]
        assert "CUST-" in confirmed_payload["reply"]
        # A completed workflow must not hijack the next unrelated turn.
        assert confirmed_payload["task"] is None

        customers = client.get(
            "/api/customers", headers=headers, params={"q": "Priya"}
        ).json()["items"]
        assert any(item["name"] == "Priya" and item["phone"] == "9876543211" for item in customers)

        # Starting the same request again must detect the existing phone.
        for text in ("Can we add a new customer?", "Priya", "9876543211"):
            duplicate = client.post("/api/voice/turn", headers=headers, json={"text": text})
            assert duplicate.status_code == 200, duplicate.text
        assert "already exists" in duplicate.json()["reply"].lower()
        assert duplicate.json()["pending_operation"] is None


def test_tanglish_and_tamil_customer_flow_saves_and_verifies(tmp_path: Path) -> None:
    os.environ["APP_ENV"] = "test"
    os.environ["APP_SECRET_KEY"] = "customer-voice-test-key-2"
    os.environ["ADMIN_INITIAL_PASSWORD"] = "test-password"
    os.environ["APP_DATA_DIR"] = str(tmp_path / "data")
    os.environ["APP_INVOICE_DIR"] = str(tmp_path / "invoices")
    os.environ["APP_BACKUP_DIR"] = str(tmp_path / "backups")
    os.environ.pop("SUPABASE_DATABASE_URL", None)
    import main

    with TestClient(importlib.reload(main).app) as client:
        login = client.post(
            "/api/login",
            json={"username": "admin", "password": "test-password"},
        )
        headers = {"Authorization": f"Bearer {login.json()['token']}"}

        for text in ("Pudhu customer add pannu", "பெயர் மீனா", "9876543212"):
            response = client.post("/api/voice/turn", headers=headers, json={"text": text})
            assert response.status_code == 200, response.text

        pending = response.json()["pending_operation"]
        assert pending["action"] == "create_customer"
        assert pending["preview"]["name"] == "மீனா"
        assert pending["preview"]["phone"] == "9876543212"

        confirmed = client.post(
            "/api/voice/confirm",
            headers=headers,
            json={
                "confirmation_id": pending["confirmation_id"],
                "confirmation_phrase": "confirm customer மீனா 9876543212",
            },
        )
        assert confirmed.status_code == 200, confirmed.text
        body = confirmed.json()
        assert body["data"]["verified"] is True
        assert body["data"]["result"]["name"] == "மீனா"
        assert "9876543212" in body["reply"]
        assert body["task"] is None

        customers = client.get(
            "/api/customers", headers=headers, params={"q": "மீனா"}
        ).json()["items"]
        assert any(item["name"] == "மீனா" and item["phone"] == "9876543212" for item in customers)

        # The saved workflow must not capture the next unrelated question.
        sales = client.post(
            "/api/voice/turn", headers=headers, json={"text": "What are today's sales?"}
        )
        assert sales.status_code == 200, sales.text
        assert "What is the new customer's name" not in sales.json()["reply"]


@pytest.mark.parametrize(
    "utterance",
    [
        "Can we add a new customer?",
        "I want to add a new customer",
        "I'd like to create a customer",
        "please register a new client",
        "new customer",
        "Pudhu customer add pannu",
        "Pudhu customer add pannanum",
        "Pudhu customer serkanum",
        # Raw output from the local Whisper base model for the Tamil request.
        "Pudhiya vadi kayaalar sirka vendung",
        "oru customer add pannu",
        "customer add pannu",
        "new customer create pannu",
        "புதிய customer சேர்க்க வேண்டும்",
        "புது கஸ்டமர் சேர்க்கணும்",
        "customer சேர்க்கணும்",
        "புதிய வாடிக்கையாளரை உருவாக்கு",
        "வாடிக்கையாளரை சேர்க்க வேண்டும்",
    ],
)
def test_customer_creation_trigger_supports_english_tamil_and_tanglish(
    utterance: str,
) -> None:
    conversation = VoiceConversation(session_id="test", admin_id=1, auth_session_id="auth")

    reply = voice_agent._deterministic_turn(None, conversation, utterance)

    assert conversation.intent == "create_customer"
    assert conversation.draft == {}
    assert conversation.missing_fields == ["name", "phone"]
    assert "name" in reply.reply.lower() or "பெயர்" in reply.reply


def test_customer_creation_keeps_collected_fields_and_accepts_tamil_answers() -> None:
    calls = []

    def fake_prepare(tool, args, db, conversation):
        calls.append((tool, dict(args)))
        return voice_agent.AgentReply(reply="preview ready", data={"status": "prepared"})

    original = voice_agent._call_prepare
    voice_agent._call_prepare = fake_prepare
    try:
        conversation = VoiceConversation(
            session_id="test", admin_id=1, auth_session_id="auth"
        )
        voice_agent._deterministic_turn(
            None, conversation, "புதிய customer சேர்க்க வேண்டும்"
        )
        voice_agent._deterministic_turn(None, conversation, "பெயர் பிரியா")
        reply = voice_agent._deterministic_turn(None, conversation, "எண் 9876543210")
    finally:
        voice_agent._call_prepare = original

    assert reply.reply == "preview ready"
    assert calls == [
        (
            "prepare_customer_creation",
            {
                "name": "பிரியா",
                "phone": "9876543210",
                "alternate_phone": "",
                "address": "",
                "city": "Madurai",
                "notes": "",
            },
        )
    ]


def test_customer_creation_accepts_whisper_transliterated_tamil_name() -> None:
    calls = []

    def fake_prepare(tool, args, db, conversation):
        calls.append(dict(args))
        return voice_agent.AgentReply(reply="preview ready", data={"status": "prepared"})

    original = voice_agent._call_prepare
    voice_agent._call_prepare = fake_prepare
    try:
        conversation = VoiceConversation(
            session_id="test", admin_id=1, auth_session_id="auth"
        )
        voice_agent._deterministic_turn(
            None, conversation, "Pudhiya vadi kayaalar sirka vendung"
        )
        reply = voice_agent._deterministic_turn(None, conversation, "pair piriya")
        voice_agent._deterministic_turn(None, conversation, "9876543210")
    finally:
        voice_agent._call_prepare = original

    assert "phone" in reply.reply.lower()
    assert calls[0]["name"] == "piriya"
    assert calls[0]["phone"] == "9876543210"


def test_customer_creation_rejects_invalid_phone_and_keeps_previous_fields() -> None:
    conversation = VoiceConversation(session_id="test", admin_id=1, auth_session_id="auth")

    voice_agent._deterministic_turn(None, conversation, "Can we add a new customer?")
    voice_agent._deterministic_turn(None, conversation, "Priya")
    reply = voice_agent._deterministic_turn(None, conversation, "123")

    assert conversation.draft == {"name": "Priya"}
    assert conversation.last_field == "phone"
    assert "phone" in reply.reply.lower()
    assert "10 to 15" in reply.reply


def test_customer_creation_uses_live_validation_model_required_fields() -> None:
    assert voice_tools.customer_required_fields() == ["name", "phone"]


@pytest.mark.parametrize(
    "utterance",
    [
        "Can we add a new order?",
        "I want to create an order",
        "புதிய ஆர்டர் சேர்க்க வேண்டும்",
        "Pudhu order add pannanum",
    ],
)
def test_bare_order_request_starts_interactive_workflow(utterance: str) -> None:
    conversation = VoiceConversation(session_id="test", admin_id=1, auth_session_id="auth")

    reply = voice_agent._deterministic_turn(None, conversation, utterance)

    assert conversation.intent == "create_order"
    assert conversation.awaiting == {"kind": "order_customer"}
    assert "customer" in reply.reply.lower()


def test_order_workflow_accepts_customer_then_requests_product(monkeypatch) -> None:
    class Customer:
        id = 7
        name = "Priya"

    monkeypatch.setattr(
        voice_agent.voice_tools,
        "resolve_customer",
        lambda db, query_text=None: (Customer(), []),
    )
    conversation = VoiceConversation(session_id="test", admin_id=1, auth_session_id="auth")
    voice_agent._deterministic_turn(None, conversation, "add a new order")
    reply = voice_agent._deterministic_turn(None, conversation, "Priya")

    assert conversation.awaiting == {"kind": "order_product", "customer_id": 7}
    assert "product" in reply.reply.lower()


def test_tamil_sales_question_executes_real_database_query(tmp_path: Path) -> None:
    os.environ["APP_ENV"] = "test"
    os.environ["APP_SECRET_KEY"] = "voice-intent-test-key"
    os.environ["ADMIN_INITIAL_PASSWORD"] = "test-password"
    os.environ["APP_DATA_DIR"] = str(tmp_path / "data")
    os.environ["APP_INVOICE_DIR"] = str(tmp_path / "invoices")
    os.environ["APP_BACKUP_DIR"] = str(tmp_path / "backups")
    os.environ.pop("SUPABASE_DATABASE_URL", None)
    import main

    with TestClient(importlib.reload(main).app) as client:
        login = client.post(
            "/api/login",
            json={"username": "admin", "password": "test-password"},
        )
        headers = {"Authorization": f"Bearer {login.json()['token']}"}
        customer = client.post(
            "/api/customers",
            headers=headers,
            json={"name": "Tamil Query Customer", "phone": "9000000001"},
        ).json()
        product = client.post(
            "/api/products",
            headers=headers,
            json={"name": "Tamil Query Product", "pricing_type": "MANUAL", "base_price": 0},
        ).json()
        created = client.post(
            "/api/orders",
            headers=headers,
            json={
                "customer_id": customer["id"],
                "product_id": product["id"],
                "order_date": business_today().isoformat(),
                "base_amount": 1250,
                "total_amount": 1250,
                "paid_amount": 500,
                "measurements": [],
                "idempotency_key": str(uuid4()),
            },
        )
        assert created.status_code == 200, created.text

        response = client.post(
            "/api/voice/turn",
            headers=headers,
            json={"text": "இன்று எவ்வளவு சேல்சி நடந்திருக்கும்?"},
        )
        payload = response.json()
        assert response.status_code == 200
        assert payload["data"]["query_plan"]["intent"] == "sales_summary"
        assert payload["data"]["query_plan"]["normalized_transcript"] == (
            "today how much sales happened"
        )
        assert payload["data"]["order_value"] == 1250
        assert "Rs. 1,250.00" in payload["reply"]
