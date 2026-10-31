"""Stateful, allowlisted voice/text assistant for the shop administrator.

The assistant is a tool-using turn engine, not a chatbot that writes free-form
answers.  It can call only the tools declared in :mod:`voice_tools`.  Write
tools create a preview and an explicit confirmation phrase; the actual save
happens only in the authenticated confirmation endpoint.

Three planners are supported:

* ``deterministic`` (default): a rule-based Tamil/English/Tanglish planner that
  works with no external key, network, or paid service.
* ``groq``: optional, only when explicitly configured with a key and model.
* ``ollama``: optional local model.

Both model planners are wrapped by the same post-processing safety net: if a
write tool was requested, the model's prose is replaced with the server's
authoritative preview or clarification.  The model can never claim that a write
was saved.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Optional

import voice_config
import voice_parsing
import voice_tools
from voice_state import PendingOperation, VoiceConversation
from voice_tools import VoiceOperationError

try:  # Optional import keeps the deterministic mode dependency-free.
    from voice_providers import VoiceProviderError, chat_provider
except Exception:  # pragma: no cover - httpx is a normal dependency
    VoiceProviderError = RuntimeError  # type: ignore[assignment,misc]

    def chat_provider():  # type: ignore[no-redef]
        raise VoiceProviderError("Chat providers are unavailable.")


@dataclass
class AgentReply:
    reply: str
    warnings: list[str] = field(default_factory=list)
    ui_action: Optional[dict[str, Any]] = None
    data: Optional[dict[str, Any]] = None
    provider: str = "deterministic"


def _money(value: Any) -> str:
    try:
        return f"Rs. {float(value):,.2f}"
    except (TypeError, ValueError):
        return "Rs. 0.00"


def _period_label(start: Optional[str], end: Optional[str], period: str) -> str:
    if not start:
        return "All time"
    if start == end:
        return start
    return f"{start} to {end} ({period.replace('_', ' ')})"


def _clean_query(value: str) -> str:
    text = (value or "").strip(" .,!?:;")
    text = re.sub(r"^(?:a|an|the|named|name)\s+", "", text, flags=re.I)
    text = re.sub(r"\s+(?:please|now)$", "", text, flags=re.I)
    return text.strip(" .,!?:;")


# ---------------------------------------------------------------------------
# Public descriptions of previews and results
# ---------------------------------------------------------------------------
def describe_preview(pending: PendingOperation) -> str:
    preview = pending.preview or {}
    action = pending.action
    if action == "create_order":
        measurements = ", ".join(
            f"{name} {value}" for name, value in (preview.get("measurements") or {}).items()
        ) or "none"
        return (
            f"Order preview: {preview.get('customer')} — {preview.get('product')}. "
            f"Measurements: {measurements}. Total {_money(preview.get('total_amount'))}, "
            f"paid {_money(preview.get('paid_amount'))}, balance {_money(preview.get('balance'))}. "
            f"Delivery {preview.get('delivery_date') or 'not set'}."
        )
    if action == "record_payment":
        return (
            f"Payment preview: {_money(preview.get('payment_amount'))} for "
            f"{preview.get('invoice_number')}. Current balance "
            f"{_money(preview.get('current_balance'))}; balance after "
            f"{_money(preview.get('balance_after'))}."
        )
    if action == "update_delivery_date":
        return (
            f"Delivery preview: {preview.get('invoice_number')} changes from "
            f"{preview.get('old_delivery_date') or 'no date'} to {preview.get('new_delivery_date')}."
        )
    if action == "update_order_status":
        return (
            f"Status preview: {preview.get('invoice_number')} changes from "
            f"{preview.get('old_status')} to {preview.get('new_status')}."
        )
    if action == "update_measurements":
        changes = ", ".join(
            f"{name} {value}" for name, value in (preview.get("changes") or {}).items()
        )
        return f"Measurement preview for {preview.get('invoice_number')}: {changes}."
    if action == "create_customer":
        similar = preview.get("similar_customers") or []
        extra = (
            " Similar existing customers: "
            + ", ".join(f"{item['name']} ({item['phone']})" for item in similar)
            + "."
            if similar
            else ""
        )
        return (
            f"Customer preview: {preview.get('name')}, phone {preview.get('phone')}, "
            f"city {preview.get('city')}.{extra}"
        )
    if action == "update_customer":
        changes = ", ".join(
            f"{key.replace('_', ' ')} becomes {value}"
            for key, value in (preview.get("changes") or {}).items()
        )
        return f"Customer update preview for {preview.get('customer')}: {changes}."
    if action == "update_order":
        changes = ", ".join(
            f"{key.replace('_', ' ')} becomes {value}"
            for key, value in (preview.get("changes") or {}).items()
        )
        return f"Order update preview for {preview.get('invoice_number')}: {changes}."
    return "Operation preview ready."


def pending_reply(pending: PendingOperation) -> str:
    phrase = voice_tools.required_confirmation_phrase(pending)
    return (
        f"{describe_preview(pending)} Nothing has been saved yet. "
        f'To save it, say or type exactly: "{phrase}". '
        f"Or press Confirm in the preview. This confirmation expires in a few minutes."
    )


def _candidate_lines(candidates: list[dict[str, Any]]) -> str:
    if not candidates:
        return ""
    lines = []
    for index, item in enumerate(candidates[:8], start=1):
        if "invoice_number" in item:
            lines.append(f"{index}. {item['invoice_number']} — {item.get('customer_name')}")
        else:
            phone = f" — {item['phone']}" if item.get("phone") else ""
            lines.append(f"{index}. {item.get('name')}{phone}")
    return " Options: " + "; ".join(lines) + "."


def reply_from_tool_result(
    conversation: VoiceConversation, result: dict[str, Any]
) -> AgentReply:
    status = result.get("status")
    if result.get("ok") is False:
        message = str(result.get("error") or "The operation could not be prepared.")
        return AgentReply(
            reply=message + _candidate_lines(result.get("candidates") or []),
            data=result if result.get("candidates") else None,
            ui_action=result.get("ui_action"),
        )
    if status == "prepared" and conversation.pending:
        return AgentReply(reply=pending_reply(conversation.pending), data=result)
    if status == "needs_clarification":
        question = str(result.get("question") or "Please give the next detail.")
        return AgentReply(
            reply=question + _candidate_lines(result.get("candidates") or []),
            data=result if result.get("candidates") or result.get("draft") else None,
        )
    if status == "ui_action":
        return AgentReply(
            reply=str(result.get("message") or "Opening the invoice viewer."),
            ui_action=result.get("ui_action"),
            data=result,
        )
    return AgentReply(reply=str(result.get("message") or "Done."), data=result)


# ---------------------------------------------------------------------------
# Read-only formatting
# ---------------------------------------------------------------------------
def _format_orders(orders: list[dict[str, Any]], limit: int = 12) -> str:
    if not orders:
        return "No matching orders were found."
    lines = []
    for order in orders[:limit]:
        lines.append(
            f"{order['invoice_number']} — {order['customer_name']} — {order['product_name']} — "
            f"total {_money(order['total_amount'])}, paid {_money(order['paid_amount'])}, "
            f"balance {_money(order['balance'])}, delivery {order['delivery_date'] or 'not set'}"
            + (", overdue" if order.get("overdue") else "")
        )
    suffix = f" Showing {len(orders[:limit])} of {len(orders)}." if len(orders) > limit else ""
    return "; ".join(lines) + "." + suffix


def format_read_result(tool: str, result: dict[str, Any]) -> str:
    if result.get("ok") is False:
        return str(result.get("error") or "That information is not available.")
    if tool == "get_business_summary":
        label = _period_label(result.get("start_date"), result.get("end_date"), result.get("period", ""))
        return (
            f"{label}: {result.get('orders', 0)} orders, order value "
            f"{_money(result.get('order_value'))}, money collected "
            f"{_money(result.get('collected'))}, current outstanding "
            f"{_money(result.get('outstanding'))}. There are "
            f"{result.get('pending_orders', 0)} orders with a balance, "
            f"{result.get('overdue_orders', 0)} overdue, and "
            f"{result.get('customers', 0)} registered customers. "
            "Order value is not money collected."
        )
    if tool == "get_sales_summary":
        label = _period_label(result.get("start_date"), result.get("end_date"), result.get("period", ""))
        return (
            f"{label}: order value {_money(result.get('order_value'))} across "
            f"{result.get('orders', 0)} orders; average order value "
            f"{_money(result.get('average_order_value'))}; money collected "
            f"{_money(result.get('collected'))}. {result.get('note', '')}"
        )
    if tool == "get_order_counts":
        label = _period_label(result.get("start_date"), result.get("end_date"), result.get("period", ""))
        by_status = ", ".join(
            f"{name}: {count}" for name, count in (result.get("by_status") or {}).items()
        ) or "none"
        return (
            f"{label}: {result.get('total', 0)} orders ({by_status}). "
            f"{result.get('pending', 0)} with a balance, {result.get('paid', 0)} fully paid, "
            f"{result.get('overdue', 0)} overdue, {result.get('due_today', 0)} due today, "
            f"{result.get('due_tomorrow', 0)} due tomorrow."
        )
    if tool == "list_orders":
        return (
            f"{str(result.get('filter', '')).replace('_', ' ').title()} orders: "
            + _format_orders(result.get("orders") or [])
        )
    if tool == "get_outstanding_payments":
        return (
            f"Current outstanding is {_money(result.get('total_outstanding'))} across "
            f"{result.get('count', 0)} orders. " + _format_orders(result.get("orders") or [])
        )
    if tool == "get_payment_history":
        label = _period_label(result.get("start_date"), result.get("end_date"), result.get("period", ""))
        return (
            f"{label}: {result.get('count', 0)} income payments totalling "
            f"{_money(result.get('total'))}."
        )
    if tool == "search_customers":
        customers = result.get("customers") or []
        if not customers:
            return "No matching customers were found."
        lines = [
            f"{item['cust_code']} — {item['name']} — {item['phone']} — {item['city']}"
            for item in customers[:8]
        ]
        return "Matching customers: " + "; ".join(lines) + "."
    if tool == "get_customer_details":
        customer = result.get("customer") or {}
        measurements = ", ".join(
            f"{item['field_name']} {item['value']}"
            for item in customer.get("last_measurements", [])
        ) or "none recorded"
        return (
            f"{customer.get('cust_code')} — {customer.get('name')}, phone "
            f"{customer.get('phone')}, {customer.get('city')}. Latest measurements: "
            f"{measurements}. Recent orders: "
            + _format_orders(customer.get("orders") or [], limit=5)
        )
    if tool == "get_customer_order_history":
        customer = result.get("customer") or {}
        return (
            f"Orders for {customer.get('name')}: "
            + _format_orders(result.get("orders") or [])
        )
    if tool == "search_orders" or tool == "get_order_details":
        orders = result.get("orders") or []
        if result.get("order"):
            orders = [result["order"]]
        return _format_orders(orders)
    if tool == "list_products":
        products = result.get("products") or []
        if not products:
            return "No active products are configured."
        return "Active products: " + "; ".join(
            f"{item['name']} ({item['pricing_type']}, base {_money(item['base_price'])})"
            for item in products[:15]
        ) + "."
    if tool == "get_measurement_template":
        product = result.get("product") or {}
        fields = result.get("required_measurements") or []
        return (
            f"{product.get('name')} requires: "
            + (", ".join(fields) if fields else "no measurements")
            + "."
        )
    return str(result.get("message") or "Done.")


# ---------------------------------------------------------------------------
# Natural-language helpers
# ---------------------------------------------------------------------------
_PERIOD_WORDS = (
    ("last_month", ("last month", "previous month", "கடந்த மாதம்", "kada maasam")),
    ("this_month", ("this month", "current month", "இந்த மாதம்", "indha maasam")),
    ("last_7_days", ("last 7 days", "past week", "last week", "seven days")),
    ("last_30_days", ("last 30 days", "past 30 days", "thirty days")),
    ("this_week", ("this week", "current week", "இந்த வாரம்", "indha varam")),
    ("this_year", ("this year", "current year", "இந்த வருடம்", "indha varusham")),
    ("yesterday", ("yesterday", "நேற்று", "netru")),
    ("tomorrow", ("tomorrow", "நாளை", "naalai", "nalaikku")),
    ("all", ("all time", "overall", "everything", "எல்லா", "ellame")),
    ("today", ("today", "இன்று", "innaiku", "innaikku", "innikku", "indru")),
)


def detect_period(text: str) -> str:
    value = voice_parsing.normalize(text)
    for period, words in _PERIOD_WORDS:
        if any(word in value for word in words):
            return period
    return "today"


_ORDER_NUMBER = re.compile(
    r"\b(?:order|bill|ஆர்டர்)\s*(?:number|no|id)?\s*#?\s*(\d{1,9})\b", re.I
)
_INVOICE_NUMBER = re.compile(r"\b(INV-\d{4}-\d{1,6})\b", re.I)
_WRITE_VERBS = re.compile(
    r"\b(?:create|make|take|start|prepare|new|record|collect|receive|received|"
    r"paid|pay|add|change|move|set|mark|update|reschedule|cancel|delete)\b",
    re.I,
)


def parse_order_reference(text: str) -> dict[str, Any]:
    invoice = _INVOICE_NUMBER.search(text or "")
    if invoice:
        return {"invoice_number": invoice.group(1).upper()}
    number = _ORDER_NUMBER.search(text or "")
    if number:
        return {"order_id": int(number.group(1))}
    return {}


def _order_from_reference(db, text: str):
    reference = parse_order_reference(text)
    return voice_tools._get_order(
        db, reference.get("order_id"), reference.get("invoice_number")
    )


def _detect_unit(text: str) -> Optional[str]:
    return voice_parsing.detect_unit(text)


def _apply_draft_details(
    db, conversation: VoiceConversation, text: str
) -> Optional[dict[str, Any]]:
    """Apply measurements, money, delivery date, and notes in one utterance."""
    draft = conversation.draft
    fields = list(draft.get("required_measurements") or [])
    applied = False
    target_field = None
    missing = [field for field in fields if field not in (draft.get("measurements") or {})]
    if missing:
        target_field = missing[0]
    parsed = voice_parsing.parse_measurements(text, fields, target_field=target_field)
    values: dict[str, str] = {}
    for item in parsed:
        if item.get("value") is None:
            continue
        values[item["field"]] = (
            f"{item['value']} {item['unit']}" if item.get("unit") else str(item["value"])
        )
    if values:
        result = voice_tools.apply_measurements_to_draft(db, conversation, values)
        applied = True
        if result.get("awaiting") or result.get("invalid_fields"):
            return result

    value = voice_parsing.normalize(text)
    if re.search(r"\b(total|paid|advance|extra|amount|rs|rupees)\b", value) or any(
        word in value for word in ("மொத்தம்", "முன்பணம்", "பணம்", "ரூபாய்")
    ):
        money = voice_parsing.parse_money_with_label(text)
        if money:
            label, amount = money
            if label in {"paid", "advance", "payment"}:
                draft["paid_amount"] = round(amount, 2)
            elif label == "extra":
                draft["extra_amount"] = round(amount, 2)
            else:
                draft["total_amount"] = round(amount, 2)
            applied = True

    if (
        "delivery" in value
        or "deliver" in value
        or "date" in value
        or "டெலிவரி" in value
    ):
        parsed_date = voice_parsing.parse_date(text)
        if parsed_date:
            draft["delivery_date"] = parsed_date
            applied = True

    if value.startswith(("description ", "note ")):
        draft["description"] = text.split(" ", 1)[1].strip()[:1000]
        applied = True

    if not applied:
        return None
    return voice_tools.refresh_order_draft(conversation)



def _extract_amount(text: str) -> Optional[float]:
    amount = voice_parsing.parse_money(text)
    if amount is not None:
        return amount
    value = voice_parsing.normalize(text)
    match = re.search(
        r"\b(?:payment|paid|pay|collect|received|receive|amount|rs\.?|rupees?)\b"
        r"(?:\s+(?:of|is|for|to|against|a|an))*\s*([\d,]+(?:\.\d+)?)",
        value,
    )
    if match:
        return float(match.group(1).replace(",", ""))
    return None


def _parse_new_order(text: str) -> Optional[dict[str, Any]]:
    value = text.strip().rstrip(".!")
    patterns = (
        r"^(?:create|make|take|start|prepare|new)\s+(?:an?\s+)?(?:new\s+)?order\s+"
        r"(?:for|of)\s+(.+?)(?:\s+(?:for|with)\s+(.+))?$",
        r"^(?:create|make|take|start|prepare|new)\s+(?:an?\s+)?(.+?)\s+order\s+"
        r"(?:for|with)\s+(.+)$",
        r"^(.+?)\s+(?:ku|க்கு)\s+(.+?)\s+(?:order|ஆர்டர்)\s+(?:podu|போடு|உருவாக்கு)$",
    )
    for pattern in patterns:
        match = re.match(pattern, value, re.I)
        if not match:
            continue
        groups = [group for group in match.groups() if group]
        if len(groups) == 1:
            return {"customer_query": _clean_query(groups[0]), "product_query": None}
        # The second pattern captures customer first, product second.
        return {
            "customer_query": _clean_query(groups[0]),
            "product_query": _clean_query(groups[1]),
        }
    return None


def _parse_customer_creation(text: str) -> Optional[dict[str, str]]:
    match = re.search(
        r"(?:create|add|new|register)\s+(?:a\s+)?(?:new\s+)?customer\s+"
        r"(?:named\s+|name\s+|for\s+)?(.+?)"
        r"(?=\s+(?:phone|number|mobile|contact|address|city|notes?)\b|$)",
        text,
        re.I,
    )
    if not match:
        return None
    name = _clean_query(match.group(1))
    phone = voice_parsing.parse_phone(text)
    if not name or not phone:
        return None
    address = ""
    address_match = re.search(r"\baddress\s+(?:is\s+|to\s+)?(.+?)(?=\s+(?:city|notes?)\b|$)", text, re.I)
    if address_match:
        address = _clean_query(address_match.group(1))
    city = "Madurai"
    city_match = re.search(r"\bcity\s+(?:is\s+|to\s+)?([A-Za-z\u0B80-\u0BFF ]{2,40})", text, re.I)
    if city_match:
        city = _clean_query(city_match.group(1))
    return {"name": name, "phone": phone, "address": address, "city": city}


def _help_text() -> str:
    return (
        "I can use live shop data. Try: ‘How many pending orders today?’, "
        "‘What is today's sales?’, ‘How much money was collected today?’, "
        "‘Show overdue orders’, ‘Find customer Priya’, ‘Show order INV-2026-001’, "
        "‘Create an order for Priya for a blouse’, ‘Record a payment of 500 for INV-2026-001’, "
        "or ‘Move order 12 delivery to Friday’. "
        "Tamil questions such as ‘இன்று விற்பனை என்ன?’ and ‘எத்தனை ஆர்டர்?’ also work. "
        "I only save after showing a preview and receiving your explicit confirmation. "
        "I never guess measurement units, and I can work without any paid service."
    )


# ---------------------------------------------------------------------------
# Tool calls
# ---------------------------------------------------------------------------
def _call_read(tool: str, args: dict[str, Any], db, conversation) -> AgentReply:
    result = voice_tools.execute_tool(tool, args, db, conversation)
    return AgentReply(reply=format_read_result(tool, result), data=result)


def _call_prepare(tool: str, args: dict[str, Any], db, conversation) -> AgentReply:
    result = voice_tools.execute_tool(tool, args, db, conversation)
    if (
        tool != "prepare_order_creation"
        and result.get("status") == "prepared"
        and conversation.pending
        and conversation.intent == "create_order"
    ):
        # The administrator switched to a different task. Keep the new preview,
        # but discard the unsaved order draft so stale fields cannot leak into it.
        conversation.intent = None
        conversation.draft = {}
        conversation.missing_fields = []
        conversation.clarification = None
        conversation.awaiting = None
        conversation.last_field = None
    return reply_from_tool_result(conversation, result)


# ---------------------------------------------------------------------------
# Deterministic planner
# ---------------------------------------------------------------------------
def _handle_clarification(db, conversation: VoiceConversation, text: str) -> Optional[AgentReply]:
    awaiting = conversation.awaiting or {}
    kind = awaiting.get("kind")
    value = voice_parsing.normalize(text)

    if kind == "unit":
        unit = _detect_unit(text)
        if unit:
            result = voice_tools.apply_unit_answer(db, conversation, unit)
            return reply_from_tool_result(conversation, result)
        return AgentReply(
            reply=f'Please say inches or centimetres. I will not guess the unit for {awaiting.get("field")}.'
        )

    if kind == "customer_choice":
        candidates = awaiting.get("candidates") or []
        selected = _choose_candidate(candidates, text)
        if not selected:
            return AgentReply(
                reply="Please say the number or exact name of the customer."
                + _candidate_lines(candidates)
            )
        conversation.awaiting = None
        purpose = awaiting.get("purpose")
        if purpose == "customer_update":
            changes = dict(awaiting.get("changes") or {})
            return _call_prepare(
                "prepare_customer_update",
                {"customer_id": selected["customer_id"], **changes},
                db,
                conversation,
            )
        if purpose == "payment":
            m = voice_tools._m()
            order = (
                db.query(m.Order)
                .filter(m.Order.customer_id == selected["customer_id"], m.Order.balance > 0)
                .order_by(m.Order.id.desc())
                .first()
            )
            amount = awaiting.get("amount")
            if not order:
                return AgentReply(reply="That customer has no order with an outstanding balance.")
            if amount is None:
                return AgentReply(
                    reply="Which payment amount should I prepare for "
                    f"{order.invoice_number}?"
                )
            return _call_prepare(
                "prepare_payment_recording",
                {"order_id": order.id, "amount": round(float(amount), 2)},
                db,
                conversation,
            )
        measurements = {
            key: str(item)
            for key, item in (conversation.draft.get("measurements") or {}).items()
        }
        product_id = awaiting.get("product_id")
        product_query = awaiting.get("product_query")
        args: dict[str, Any] = {
            "customer_id": selected["customer_id"],
            "measurements": measurements,
        }
        if product_id:
            args["product_id"] = product_id
        elif product_query:
            args["product_query"] = product_query
        return _call_prepare("prepare_order_creation", args, db, conversation)

    if kind == "product_choice":
        candidates = awaiting.get("candidates") or []
        selected = _choose_candidate(candidates, text)
        if not selected:
            return AgentReply(
                reply="Please say the number or exact name of the product."
                + _candidate_lines(candidates)
            )
        conversation.awaiting = None
        return _call_prepare(
            "prepare_order_creation",
            {
                "customer_id": awaiting.get("customer_id"),
                "product_id": selected.get("product_id"),
                "measurements": {
                    key: str(item)
                    for key, item in (conversation.draft.get("measurements") or {}).items()
                },
            },
            db,
            conversation,
        )

    if kind == "order_product":
        customer_id = awaiting.get("customer_id")
        customer_query = awaiting.get("customer_query")
        conversation.awaiting = None
        args: dict[str, Any] = {"product_query": _clean_query(text)}
        if customer_id:
            args["customer_id"] = customer_id
        elif customer_query:
            args["customer_query"] = customer_query
        return _call_prepare("prepare_order_creation", args, db, conversation)

    return None


def _choose_candidate(candidates: list[dict[str, Any]], text: str) -> Optional[dict[str, Any]]:
    value = voice_parsing.normalize(text)
    ordinal = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5}
    for word, number in ordinal.items():
        if word in value:
            if 0 < number <= len(candidates):
                return candidates[number - 1]
    number_match = re.search(r"\b(\d{1,2})\b", value)
    if number_match:
        index = int(number_match.group(1))
        if 0 < index <= len(candidates):
            return candidates[index - 1]
    for candidate in candidates:
        name = str(candidate.get("name") or "").casefold()
        phone = str(candidate.get("phone") or "")
        code = str(candidate.get("cust_code") or "").casefold()
        if name and name in value:
            return candidate
        if phone and phone in re.sub(r"\D", "", value):
            return candidate
        if code and code in value:
            return candidate
    return None


def _handle_active_order_draft(
    db, conversation: VoiceConversation, text: str
) -> Optional[AgentReply]:
    if conversation.intent != "create_order" or not conversation.draft:
        return None
    draft = conversation.draft
    fields = list(draft.get("required_measurements") or [])
    value = voice_parsing.normalize(text)

    # An explicit reference to another order is a separate task, not an answer
    # to the current draft. Let the write planner handle it.
    if parse_order_reference(text) and re.search(
        r"\b(?:change|move|set|update|reschedule|mark|status|paid|ready|delivered)\b", value
    ):
        return None

    # Change the customer or product while a draft is active.
    customer_change = re.search(
        r"(?:change|set)\s+(?:the\s+)?customer\s+(?:to|is)?\s*(.+)$", text, re.I
    )
    if customer_change:
        query = _clean_query(customer_change.group(1))
        customer, candidates = voice_tools.resolve_customer(db, query_text=query)
        if not customer:
            if candidates:
                conversation.awaiting = {
                    "kind": "customer_choice",
                    "purpose": "create_order",
                    "candidates": voice_tools._customer_choices(candidates),
                    "product_id": draft.get("product_id"),
                }
                return AgentReply(
                    reply="Which customer did you mean?" + _candidate_lines(
                        voice_tools._customer_choices(candidates)
                    )
                )
            return AgentReply(reply="I could not find that customer. Say the exact name or phone number.")
        draft["customer_id"] = customer.id
        draft["customer_name"] = customer.name
        return reply_from_tool_result(conversation, voice_tools.refresh_order_draft(conversation))

    product_change = re.search(
        r"(?:change|set)\s+(?:the\s+)?product\s+(?:to|is)?\s*(.+)$", text, re.I
    )
    if product_change:
        query = _clean_query(product_change.group(1))
        product, candidates = voice_tools.resolve_product(db, query_text=query)
        if not product:
            if candidates:
                conversation.awaiting = {
                    "kind": "product_choice",
                    "purpose": "create_order",
                    "customer_id": draft.get("customer_id"),
                    "candidates": [
                        {"product_id": item.id, "name": item.name} for item in candidates
                    ],
                }
                return AgentReply(
                    reply="Which product did you mean?"
                    + _candidate_lines(
                        [{"name": item.name} for item in candidates]
                    )
                )
            return AgentReply(reply="I could not find an active product with that name.")
        if not voice_tools.voice_order_supported(product):
            return AgentReply(reply=voice_tools.VOICE_STITCH_BASED_MESSAGE)
        new_draft = voice_tools.start_order_draft(
            db,
            conversation,
            voice_tools.resolve_customer(db, customer_id=draft["customer_id"])[0],
            product,
        )
        kept = {
            name: measurement
            for name, measurement in (draft.get("measurements") or {}).items()
            if name in new_draft["required_measurements"]
        }
        new_draft["measurements"].update(kept)
        # The draft object is now the fresh one; refresh uses the conversation.
        return reply_from_tool_result(conversation, voice_tools.refresh_order_draft(conversation))

    if value.startswith(("description ", "note ")):
        draft["description"] = text.split(" ", 1)[1].strip()[:1000]
        return reply_from_tool_result(conversation, voice_tools.refresh_order_draft(conversation))

    details = _apply_draft_details(db, conversation, text)
    if details is not None:
        return reply_from_tool_result(conversation, details)

    # Bare numbers answer a pending amount or delivery-date question.
    missing = [field for field in fields if field not in (draft.get("measurements") or {})]
    if not missing and draft.get("total_amount") is None:
        amount = voice_parsing.parse_number(text)
        if amount is not None and amount > 0:
            draft["total_amount"] = round(float(amount), 2)
            return reply_from_tool_result(conversation, voice_tools.refresh_order_draft(conversation))
    if not missing and not draft.get("delivery_date"):
        parsed_date = voice_parsing.parse_date(text)
        if parsed_date:
            draft["delivery_date"] = parsed_date
            return reply_from_tool_result(conversation, voice_tools.refresh_order_draft(conversation))

    if conversation.clarification:
        # Not an answer to the current draft and not a different task: repeat
        # the next question while keeping the draft and any pending preview.
        return None
    return None


def _is_active_draft_delivery_answer(conversation: VoiceConversation, value: str) -> bool:
    """Return True when the turn is answering the draft's delivery question.

    Without this guard, "delivery tomorrow" is treated as the read-only report
    "which orders are due tomorrow?" and the active draft never receives the
    date.
    """
    if conversation.intent != "create_order" or not conversation.draft:
        return False
    if re.search(
        r"\b(?:show|list|who|which|what|how many|how much|find|search|pending|overdue|due)\b",
        value,
    ):
        return False
    return (
        "delivery" in value
        or "deliver" in value
        or "date" in value
        or "டெலிவரி" in value
        or "தேதி" in value
    )


def _handle_read_intent(db, conversation: VoiceConversation, text: str) -> Optional[AgentReply]:
    value = voice_parsing.normalize(text)

    if re.search(r"\b(help|what can you do|commands|how do i use)\b", value) or "உதவி" in value:
        return AgentReply(reply=_help_text())

    if (
        "how many customer" in value
        or "customer count" in value
        or "எத்தனை வாடிக்கையாளர்" in value
        or "வாடிக்கையாளர் எண்ணிக்கை" in value
    ):
        return _call_read("get_business_summary", {"period": "all"}, db, conversation)

    if (
        "how many order" in value
        or "order count" in value
        or "number of orders" in value
        or "total orders" in value
        or "எத்தனை ஆர்டர்" in value
        or "ஆர்டர் எத்தனை" in value
        or "ஆர்டர் எண்ணிக்கை" in value
    ):
        return _call_read("get_order_counts", {"period": detect_period(text)}, db, conversation)

    if re.search(r"\boverdue\b|\blate\b", value) or any(
        word in value for word in ("தாமதம்", "தாமதமான", "லேட்")
    ):
        return _call_read(
            "list_orders", {"filter": "overdue", "period": "today", "limit": 20}, db, conversation
        )

    if (
        re.search(r"\bdue today\b|\bdelivery today\b", value)
        or any(word in value for word in ("இன்று டெலிவரி", "இன்னைக்கு டெலிவரி"))
    ) and not _is_active_draft_delivery_answer(conversation, value):
        return _call_read(
            "list_orders", {"filter": "due_today", "period": "today", "limit": 20}, db, conversation
        )

    if (
        re.search(r"\bdue tomorrow\b|\bdelivery tomorrow\b", value)
        or any(word in value for word in ("நாளை டெலிவரி", "நாளைக்கு டெலிவரி"))
    ) and not _is_active_draft_delivery_answer(conversation, value):
        return _call_read(
            "list_orders", {"filter": "due_tomorrow", "period": "today", "limit": 20}, db, conversation
        )

    if re.search(
        r"\boutstanding\b|\bbalance due\b|\btotal due\b|\bhow much (?:is )?due\b|நிலுவை",
        value,
    ) or any(word in value for word in ("பாக்கி", "பாக்கி தொகை")):
        return _call_read(
            "get_outstanding_payments", {"filter": "pending", "period": "today", "limit": 20}, db, conversation
        )

    if (
        re.search(
            r"\b(?:money )?(?:collected|collection|receipts)\b"
            r"|\bpayments? (?:today|history)\b"
            r"|\bhow much (?:money )?(?:did (?:we|i) )?(?:collect|receive|get)\b",
            value,
        )
        or any(word in value for word in ("வசூல்", "வசூலான", "கலெக்ஷன்", "பணம் வந்த"))
    ):
        return _call_read(
            "get_payment_history", {"period": detect_period(text)}, db, conversation
        )

    if re.search(r"\b(?:sales|revenue|turnover|order value)\b", value) or any(
        word in value for word in ("விற்பனை", "வருவாய்")
    ):
        return _call_read("get_sales_summary", {"period": detect_period(text)}, db, conversation)

    if re.search(r"\b(?:summary|report|business|dashboard|overview)\b", value) or any(
        word in value for word in ("சுருக்கம்", "அறிக்கை")
    ):
        return _call_read("get_business_summary", {"period": detect_period(text)}, db, conversation)

    if re.search(r"\bpending orders?\b|\bunpaid orders?\b|\bopen orders?\b", value) or any(
        word in value for word in ("நிலுவை ஆர்டர்", "பாக்கி ஆர்டர்", "முடிக்காத ஆர்டர்")
    ):
        return _call_read(
            "list_orders", {"filter": "pending", "period": "today", "limit": 20}, db, conversation
        )

    if re.search(r"\b(?:recent|latest|list|show|all) orders?\b", value) or any(
        word in value for word in ("ஆர்டர் பட்டியல்", "ஆர்டர்கள் காட்டு")
    ):
        return _call_read(
            "list_orders", {"filter": "recent", "period": "today", "limit": 20}, db, conversation
        )

    if (
        re.search(r"\b(?:products?|work types?|items?)\b", value)
        and "measurement" not in value
    ) or any(word in value for word in ("பொருட்கள்", "வேலை வகை")):
        return _call_read("list_products", {}, db, conversation)

    template_match = re.search(
        r"(?:measurements?|sizes?)\s+(?:for|of|required for)\s+(.+)$", text, re.I
    )
    if template_match:
        query = _clean_query(template_match.group(1))
        return _call_read(
            "get_measurement_template", {"query": query}, db, conversation
        )

    invoice_match = _INVOICE_NUMBER.search(text)
    if (
        invoice_match
        and not _WRITE_VERBS.search(value)
        and (
            re.search(r"\b(?:\w+\s+){0,4}invoice\b|\border\b", value)
            or re.search(r"\b(?:show|find|search|details?|status)\b", value)
        )
    ):
        return _call_read(
            "get_order_details", {"invoice_number": invoice_match.group(1).upper()}, db, conversation
        )

    order_match = _ORDER_NUMBER.search(text)
    if order_match and not _WRITE_VERBS.search(value):
        return _call_read(
            "get_order_details", {"order_id": int(order_match.group(1))}, db, conversation
        )

    customer_history = re.search(
        r"(?:orders?|history)\s+(?:for|of)\s+(.+)$", text, re.I
    )
    if customer_history and not re.search(
        r"\b(?:create|make|take|start|prepare|new|record|collect|add)\b", value
    ):
        return _call_read(
            "get_customer_order_history",
            {"query": _clean_query(customer_history.group(1))},
            db,
            conversation,
        )

    customer_search = re.search(
        r"(?:find|search|show|pull up|details? (?:of|for)|customer)\s+"
        r"(?:me\s+|the\s+)?(?:customer\s+)?(?:named\s+|name\s+)?(.+)$",
        text,
        re.I,
    )
    if customer_search and re.search(
        r"\b(?:customer|find|search|show|details?|pull)\b", text, re.I
    ):
        query = _clean_query(customer_search.group(1))
        if (
            query
            and not re.search(r"\b(?:order|payment|invoice)\b", query, re.I)
            and not re.search(r"\b(?:create|add|new|register|update|change|edit)\b", value)
        ):
            return _call_read("search_customers", {"query": query, "limit": 10}, db, conversation)

    return None


def _handle_write_intent(db, conversation: VoiceConversation, text: str) -> Optional[AgentReply]:
    value = voice_parsing.normalize(text)

    # Payment recording.
    if re.search(
        r"\b(?:record|add|collect|receive|received|pay|paid)\b.*\bpayment\b|"
        r"\bpayment\b.*\b(?:for|against)\b|"
        r"\b(?:collect|received?|paid?)\s+(?:rs\.?|rupees?)?\s*[\d,]+\s+(?:from|for)\b",
        value,
    ) or ("பணம்" in value and _extract_amount(text) is not None):
        amount = _extract_amount(text)
        order = _order_from_reference(db, text)
        if not order:
            customer_match = re.search(
                r"(?:from|for)\s+(?!order\b|invoice\b|inv-)([A-Za-z\u0B80-\u0BFF ]{2,60})",
                text,
                re.I,
            )
            if customer_match:
                customer, candidates = voice_tools.resolve_customer(
                    db, query_text=_clean_query(customer_match.group(1))
                )
                if customer:
                    from_orders = (
                        db.query(voice_tools._m().Order)
                        .filter(
                            voice_tools._m().Order.customer_id == customer.id,
                            voice_tools._m().Order.balance > 0,
                        )
                        .order_by(voice_tools._m().Order.id.desc())
                        .first()
                    )
                    order = from_orders
                elif candidates:
                    conversation.awaiting = {
                        "kind": "customer_choice",
                        "purpose": "payment",
                        "candidates": voice_tools._customer_choices(candidates),
                        "amount": amount,
                    }
                    return AgentReply(
                        reply="Which customer's payment did you mean?"
                        + _candidate_lines(voice_tools._customer_choices(candidates))
                    )
        if amount is None:
            return AgentReply(
                reply="What payment amount should I prepare? Please include the rupees amount and the order or invoice number."
            )
        if not order:
            return AgentReply(
                reply="Which order received the payment? Give the order number or invoice number, for example INV-2026-001."
            )
        return _call_prepare(
            "prepare_payment_recording",
            {"order_id": order.id, "amount": round(float(amount), 2)},
            db,
            conversation,
        )

    # Invoice viewer.
    if (
        re.search(r"\b(?:open|show|generate|view)\b.*\binvoice\b|\binvoice\b.*\b(?:for|of)\b", value)
        or "இன்வாய்ஸ்" in value
        or "பில்" in value
    ):
        order = _order_from_reference(db, text)
        if order:
            return _call_prepare(
                "prepare_invoice_generation", {"order_id": order.id}, db, conversation
            )
        return AgentReply(
            reply="Which order's invoice should I open? Give the order number or invoice number."
        )

    # Measurement corrections.
    if re.search(r"\b(?:change|update|correct|fix|set)\b.*\bmeasurement", value) or (
        re.search(r"\b(?:change|update|set)\b", value)
        and re.search(r"\b(?:bust|waist|shoulder|armhole|sleeve|neck|hip|length|flare)\b", value)
    ):
        order = _order_from_reference(db, text)
        if not order:
            return AgentReply(
                reply="Which order's measurements should I change? Give the order number or invoice number."
            )
        product = (
            db.query(voice_tools._m().Product)
            .filter(voice_tools._m().Product.id == order.product_id)
            .first()
        )
        fields = voice_tools.template_fields(product, db)
        parsed = voice_parsing.parse_measurements(text, fields)
        if not parsed:
            return AgentReply(
                reply="I heard a measurement change but not the field and value. "
                "Say for example: change bust to 36 inches for INV-2026-001."
            )
        values = {
            item["field"]: (
                f"{item['value']} {item['unit']}" if item.get("unit") else str(item["value"])
            )
            for item in parsed
            if item.get("value") is not None
        }
        return _call_prepare(
            "prepare_measurement_update",
            {"order_id": order.id, "measurements": values},
            db,
            conversation,
        )

    # Delivery date changes.
    if re.search(r"\b(?:change|move|set|update|reschedule)\b.*\bdeliver", value) or (
        re.search(r"\b(?:move|change|reschedule|set)\b", value)
        and parse_order_reference(text)
        and voice_parsing.parse_date(text)
        and not re.search(r"\b(?:status|paid|pending|ready|delivered)\b", value)
    ) or (
        "டெலிவரி" in value
        and parse_order_reference(text)
        and voice_parsing.parse_date(text)
    ):
        order = _order_from_reference(db, text)
        if not order:
            return AgentReply(
                reply="Which order's delivery should I change? Give the order number or invoice number."
            )
        parsed_date = voice_parsing.parse_date(text)
        if not parsed_date:
            return AgentReply(
                reply="What new delivery date should I use? Say a date like 5 November, tomorrow, or Friday."
            )
        return _call_prepare(
            "prepare_delivery_date_update",
            {"order_id": order.id, "delivery_date": parsed_date},
            db,
            conversation,
        )

    # Status changes.
    if re.search(r"\b(?:mark|set|change)\b.*\b(?:status|as (?:paid|ready|delivered|pending))", value) or re.search(
        r"\bmark\s+(?:order\s+\d+|inv-\S+)\s+(?:as\s+)?(?:paid|ready|delivered|pending)\b", value
    ):
        order = _order_from_reference(db, text)
        if not order:
            return AgentReply(
                reply="Which order's status should I change? Give the order number or invoice number."
            )
        status_match = re.search(
            r"\b(partially paid|partial|paid|ready|delivered|pending|completed)\b", value
        )
        if not status_match:
            return AgentReply(reply="Which status: Pending, Partially Paid, Paid, Ready, or Delivered?")
        return _call_prepare(
            "prepare_order_status_update",
            {"order_id": order.id, "status": status_match.group(1)},
            db,
            conversation,
        )

    # Customer creation and update.
    customer_create = _parse_customer_creation(text)
    if customer_create:
        return _call_prepare("prepare_customer_creation", customer_create, db, conversation)

    if re.search(r"\b(?:update|change|edit)\b.*\bcustomer\b", value):
        customer_match = re.search(
            r"customer\s+(?:named\s+|name\s+)?(.+?)(?=\s+(?:phone|number|mobile|address|city|notes?)\b|$)",
            text,
            re.I,
        )
        if customer_match:
            query = _clean_query(customer_match.group(1))
            customer, candidates = voice_tools.resolve_customer(db, query_text=query)
            if not customer:
                if candidates:
                    conversation.awaiting = {
                        "kind": "customer_choice",
                        "purpose": "customer_update",
                        "candidates": voice_tools._customer_choices(candidates),
                        "changes": _customer_changes(text),
                    }
                    return AgentReply(
                        reply="Which customer did you mean?"
                        + _candidate_lines(voice_tools._customer_choices(candidates))
                    )
                return AgentReply(reply="I could not find that customer.")
            changes = _customer_changes(text)
            if not changes:
                return AgentReply(
                    reply="What should change? Say for example: update customer Priya phone 9876543210."
                )
            return _call_prepare(
                "prepare_customer_update",
                {"customer_id": customer.id, **changes},
                db,
                conversation,
            )

    # New order.
    start = _parse_new_order(text)
    if start:
        customer, candidates = voice_tools.resolve_customer(
            db, query_text=start["customer_query"]
        )
        if not customer:
            if candidates:
                conversation.awaiting = {
                    "kind": "customer_choice",
                    "purpose": "create_order",
                    "candidates": voice_tools._customer_choices(candidates),
                    "product_query": start.get("product_query"),
                }
                return AgentReply(
                    reply="I found more than one matching customer. Which one?"
                    + _candidate_lines(voice_tools._customer_choices(candidates))
                )
            return AgentReply(
                reply=(
                    "I could not find that customer. Create the customer first, or say the exact "
                    "registered name or phone number. For example: create customer Priya phone 9876543210."
                )
            )
        if not start.get("product_query"):
            conversation.intent = "create_order"
            conversation.draft = {}
            conversation.awaiting = {
                "kind": "order_product",
                "customer_id": customer.id,
                "customer_query": start["customer_query"],
            }
            return AgentReply(
                reply=f"Which product or work type is the order for {customer.name}? Say the configured product name."
            )
        product, products = voice_tools.resolve_product(
            db, query_text=start["product_query"]
        )
        if not product:
            if products:
                conversation.awaiting = {
                    "kind": "product_choice",
                    "purpose": "create_order",
                    "customer_id": customer.id,
                    "candidates": [
                        {"product_id": item.id, "name": item.name} for item in products
                    ],
                }
                return AgentReply(
                    reply="Which product did you mean?"
                    + _candidate_lines([{"name": item.name} for item in products])
                )
            return AgentReply(
                reply=(
                    "I could not find an active product with that name. Say the exact configured "
                    "product name, or ask me to list products."
                )
            )
        if not voice_tools.voice_order_supported(product):
            return AgentReply(reply=voice_tools.VOICE_STITCH_BASED_MESSAGE)
        voice_tools.start_order_draft(db, conversation, customer, product)
        details = _apply_draft_details(db, conversation, text)
        if details is not None:
            return reply_from_tool_result(conversation, details)
        return reply_from_tool_result(conversation, voice_tools.refresh_order_draft(conversation))

    return None


def _customer_changes(text: str) -> dict[str, str]:
    changes: dict[str, str] = {}
    phone = voice_parsing.parse_phone(text)
    if phone:
        changes["phone"] = phone
    address = re.search(r"\baddress\s+(?:is|to)?\s*(.+?)(?=\s+(?:city|notes?|phone)\b|$)", text, re.I)
    if address:
        changes["address"] = _clean_query(address.group(1))
    city = re.search(r"\bcity\s+(?:is|to)?\s*([A-Za-z\u0B80-\u0BFF ]{2,40})", text, re.I)
    if city:
        changes["city"] = _clean_query(city.group(1))
    notes = re.search(r"\bnotes?\s+(?:is|to)?\s*(.+)$", text, re.I)
    if notes:
        changes["notes"] = _clean_query(notes.group(1))
    return changes


def _deterministic_turn(
    db, conversation: VoiceConversation, text: str
) -> AgentReply:
    value = voice_parsing.normalize(text)

    if re.fullmatch(r"(?:cancel|never mind|stop|ரத்து|வேண்டாம்)[.! ]*", value):
        conversation.clear_draft()
        return AgentReply(reply="Cancelled. No business record was changed.")

    destructive = re.search(r"\b(?:delete|remove|erase|destroy|drop)\b", value) or any(
        word in value for word in ("அழி", "நீக்கு", "டெலீட்")
    )
    if destructive and not re.search(r"\b(?:draft|preview|cancel)\b", value):
        targets = re.search(
            r"\b(?:orders?|customers?|payments?|invoices?|products?|transactions?)\b", value
        ) or any(
            word in value for word in ("ஆர்டர்", "வாடிக்கையாளர்", "பணம்", "பில்", "பொருள்")
        )
        if targets:
            return AgentReply(
                reply=(
                    "I cannot delete orders, customers, payments, invoices, or products. "
                    "Nothing was changed. Use the existing manual screen only if an "
                    "administrator must make that change."
                )
            )

    if re.search(r"\b(?:show|current|review|open)\b.*\b(?:draft|preview)\b|\b(?:draft|preview)\b.*\b(?:show|status)\b", value):
        if conversation.pending:
            return AgentReply(reply=pending_reply(conversation.pending))
        if conversation.intent == "create_order" and conversation.draft:
            missing = conversation.missing_fields or voice_tools.compute_order_missing(conversation.draft)
            return AgentReply(
                reply=(
                    f"Current draft: {conversation.draft.get('customer_name')} — "
                    f"{conversation.draft.get('product_name')}. Missing: "
                    + (", ".join(missing) if missing else "nothing; the preview is ready.")
                ),
                data={"draft": conversation.draft, "missing_fields": missing},
            )
        return AgentReply(reply="There is no active draft.")

    # Read-only questions never discard or mutate an active draft.
    read = _handle_read_intent(db, conversation, text)
    if read:
        return read

    clarification = _handle_clarification(db, conversation, text)
    if clarification:
        return clarification

    draft_reply = _handle_active_order_draft(db, conversation, text)
    if draft_reply:
        return draft_reply

    write = _handle_write_intent(db, conversation, text)
    if write:
        return write

    if conversation.intent == "create_order" and conversation.draft:
        missing = conversation.missing_fields or voice_tools.compute_order_missing(conversation.draft)
        if missing:
            return AgentReply(
                reply=f"I still need: {conversation.clarification or voice_tools._next_question(missing)}. "
                "You can also correct the draft in the preview panel or say cancel."
            )

    if conversation.pending:
        return AgentReply(
            reply=(
                "There is a preview waiting for confirmation. "
                + pending_reply(conversation.pending)
                + " Say cancel to discard it."
            )
        )
    return AgentReply(reply=_help_text())


# ---------------------------------------------------------------------------
# Optional model planner
# ---------------------------------------------------------------------------
def _system_prompt() -> str:
    return (
        "You are the Lalitha's Apparel shop assistant. You must use the provided tools "
        "for every business fact and every write. Never invent customers, orders, "
        "measurements, amounts, dates, or results. Never write SQL. Never claim that "
        "something was saved: write tools only prepare a preview and the administrator "
        "must confirm explicitly. Ask at most one clarifying question at a time. "
        "Measurements must include inches or centimetres; ask instead of guessing. "
        "Order value is not the same as money collected. Use Asia/Kolkata business dates. "
        "Support Tamil, English, and Tanglish. Keep replies short and factual. "
        "If a tool returns needs_clarification, ask exactly the returned question. "
        "If a tool returns prepared, tell the administrator to review the preview and "
        "use the confirmation phrase. Do not call a write tool again to confirm."
    )


def _llm_messages(conversation: VoiceConversation) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = [{"role": "system", "content": _system_prompt()}]
    for message in conversation.messages[-14:]:
        messages.append({"role": message["role"], "content": message["content"]})
    return messages


def _llm_turn(
    db, conversation: VoiceConversation, text: str
) -> AgentReply:
    provider = chat_provider()
    messages = _llm_messages(conversation)
    tools = voice_tools.tool_definitions()
    write_result: Optional[dict[str, Any]] = None
    warnings: list[str] = []
    total_calls = 0
    last_content = ""

    for _iteration in range(voice_config.max_tool_iterations()):
        response = provider.chat(messages, tools)
        content = str(response.get("content") or "").strip()
        if content:
            last_content = content
        calls = response.get("tool_calls") or []
        if not calls:
            if write_result is not None:
                safe = reply_from_tool_result(conversation, write_result)
                safe.provider = provider.name
                safe.warnings = warnings
                return safe
            if content:
                reply = AgentReply(reply=content, provider=provider.name, warnings=warnings)
                if conversation.pending:
                    reply.reply = content + " " + pending_reply(conversation.pending)
                return reply
            break
        assistant_message: dict[str, Any] = {"role": "assistant", "content": content or None}
        tool_messages = []
        for call in calls:
            name = str(call.get("name") or "")
            if total_calls >= voice_config.max_tool_calls_per_turn():
                warnings.append("Tool-call limit reached; extra calls were ignored.")
                tool_messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.get("id") or "",
                        "name": name,
                        "content": json.dumps(
                            {"ok": False, "error": "Tool-call limit reached. Nothing was changed."}
                        ),
                    }
                )
                continue
            total_calls += 1
            raw_arguments = call.get("arguments")
            if isinstance(raw_arguments, str):
                try:
                    arguments = json.loads(raw_arguments or "{}")
                except ValueError:
                    arguments = None
            elif isinstance(raw_arguments, dict):
                arguments = raw_arguments
            else:
                arguments = None
            if not isinstance(arguments, dict):
                result = {
                    "ok": False,
                    "error": "The model produced invalid tool arguments. Nothing was changed.",
                }
            else:
                result = voice_tools.execute_tool(name, arguments, db, conversation)
            spec = voice_tools.TOOLS.get(name)
            if spec is not None and not spec.read_only:
                write_result = result
            tool_messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.get("id") or "",
                    "name": name,
                    "content": json.dumps(result, ensure_ascii=False)[:4000],
                }
            )
        assistant_message["tool_calls"] = [
            {
                "id": call.get("id") or "",
                "type": "function",
                "function": {
                    "name": call.get("name"),
                    "arguments": call.get("arguments")
                    if isinstance(call.get("arguments"), str)
                    else json.dumps(call.get("arguments") or {}),
                },
            }
            for call in calls
        ]
        messages.append(assistant_message)
        messages.extend(tool_messages)

    if write_result is not None:
        safe = reply_from_tool_result(conversation, write_result)
        safe.provider = provider.name
        safe.warnings = warnings
        return safe
    if last_content:
        return AgentReply(reply=last_content, provider=provider.name, warnings=warnings)
    raise VoiceProviderError("The configured model did not produce a reply.")


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------
def handle_turn(
    db, conversation: VoiceConversation, text: str, admin=None
) -> AgentReply:
    raw = (text or "").strip()
    if not raw:
        return AgentReply(reply="Please say or type a command.")
    if len(raw) > voice_config.max_transcript_chars():
        return AgentReply(
            reply=(
                "That message is too long. Please use a shorter command under "
                f"{voice_config.max_transcript_chars()} characters."
            )
        )
    conversation.touch()

    # An explicit confirmation phrase never reaches a model.
    if conversation.pending and voice_tools.confirmation_matches(conversation.pending, raw):
        pending = conversation.pending
        return AgentReply(
            reply=(
                "Confirmation received. Sending it to the secure confirmation step; "
                "the result will be shown only after it is verified."
            ),
            ui_action={
                "type": "confirm_pending",
                "confirmation_id": pending.confirmation_id,
                "confirmation_phrase": raw,
            },
            provider="deterministic",
        )

    if voice_config.llm_provider() != "deterministic":
        try:
            return _llm_turn(db, conversation, raw)
        except VoiceProviderError as exc:
            fallback = _deterministic_turn(db, conversation, raw)
            fallback.provider = "deterministic"
            fallback.warnings.append(str(exc))
            return fallback
        except Exception:
            fallback = _deterministic_turn(db, conversation, raw)
            fallback.provider = "deterministic"
            fallback.warnings.append(
                "The configured model failed; the built-in command parser answered instead."
            )
            return fallback

    return _deterministic_turn(db, conversation, raw)


def execute_confirmation(
    db,
    conversation: VoiceConversation,
    confirmation_id: str,
    phrase: str,
    admin,
) -> AgentReply:
    completed = conversation.completed.get(confirmation_id)
    if completed:
        message = str(completed.result.get("message") or "This operation was already completed.")
        return AgentReply(reply=message + " It was not submitted again.", data=completed.result)

    pending = conversation.pending
    if not pending or pending.confirmation_id != confirmation_id:
        raise VoiceOperationError(
            "This confirmation is missing or has already been used. Prepare the operation again.",
            409,
        )
    if pending.expired():
        conversation.clear_pending()
        raise VoiceOperationError(
            "This confirmation has expired. Prepare the operation again.", 409
        )
    if not voice_tools.confirmation_matches(pending, phrase):
        raise VoiceOperationError(
            "The confirmation phrase does not match this operation. Nothing was saved.", 422
        )
    result = voice_tools.execute_pending(pending, db, admin)
    conversation.remember_completed(pending, result)
    action = pending.action
    conversation.pending = None
    if action == "create_order":
        conversation.clear_draft()
    else:
        conversation.awaiting = None
    message = str(result.get("message") or "The operation completed successfully.")
    conversation.say("assistant", message)
    return AgentReply(reply=message, data=result)


def cancel(db, conversation: VoiceConversation, scope: str = "draft") -> AgentReply:
    if scope == "pending":
        if not conversation.pending:
            return AgentReply(reply="There is no preview waiting for confirmation.")
        conversation.pending = None
        return AgentReply(reply="The preview was discarded. No business record was changed.")
    conversation.clear_draft()
    return AgentReply(reply="The current draft was cancelled. No business record was changed.")


def apply_draft_patch(
    db, conversation: VoiceConversation, patch: dict[str, Any]
) -> AgentReply:
    if conversation.intent != "create_order" or not conversation.draft:
        return AgentReply(reply="There is no active order draft to edit.")
    draft = conversation.draft
    warnings: list[str] = []

    if patch.get("measurements"):
        values = {str(key): str(value) for key, value in patch["measurements"].items()}
        result = voice_tools.apply_measurements_to_draft(db, conversation, values)
        if result.get("status") == "needs_clarification" and (
            result.get("invalid_fields") or result.get("awaiting")
        ):
            return reply_from_tool_result(conversation, result)

    if patch.get("customer_id") is not None:
        customer, _ = voice_tools.resolve_customer(db, customer_id=patch["customer_id"])
        if not customer:
            return AgentReply(reply="That customer is not available.")
        draft["customer_id"] = customer.id
        draft["customer_name"] = customer.name

    if patch.get("product_id") is not None:
        product, _ = voice_tools.resolve_product(db, product_id=patch["product_id"])
        if not product:
            return AgentReply(reply="That product is not available.")
        if not voice_tools.voice_order_supported(product):
            return AgentReply(reply=voice_tools.VOICE_STITCH_BASED_MESSAGE)
        new_draft = voice_tools.start_order_draft(
            db,
            conversation,
            voice_tools.resolve_customer(db, customer_id=draft["customer_id"])[0],
            product,
        )
        draft = new_draft
        kept = {
            name: value
            for name, value in (patch.get("measurements") or {}).items()
            if name in draft["required_measurements"]
        }
        if kept:
            voice_tools.apply_measurements_to_draft(db, conversation, kept)

    if patch.get("total_amount") is not None:
        draft["total_amount"] = round(float(patch["total_amount"]), 2)
    if patch.get("paid_amount") is not None:
        draft["paid_amount"] = round(float(patch["paid_amount"]), 2)
    if patch.get("extra_amount") is not None:
        draft["extra_amount"] = round(float(patch["extra_amount"]), 2)
    if patch.get("description") is not None:
        draft["description"] = str(patch["description"])[:1000]
    if patch.get("delivery_date"):
        parsed_date = voice_parsing.parse_date(str(patch["delivery_date"]))
        if not parsed_date:
            return AgentReply(reply="Please provide a valid delivery date.")
        draft["delivery_date"] = parsed_date
    if draft.get("total_amount") is not None and draft.get("paid_amount", 0) > draft["total_amount"]:
        warnings.append("Paid amount cannot exceed the total. The server will refuse to save it.")

    result = voice_tools.refresh_order_draft(conversation)
    reply = reply_from_tool_result(conversation, result)
    reply.warnings.extend(warnings)
    return reply
