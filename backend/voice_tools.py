"""Allowlisted business tools for the voice assistant.

The language model may only request tools declared in :data:`TOOL_SPECS`.
Every argument is validated with Pydantic before a query or write is prepared.
Write tools only create a *preview*; the authenticated confirmation endpoint
performs the actual save.  The model can never execute SQL or confirm its own
operation.
"""
from __future__ import annotations

import copy
import json
import math
import re
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Callable, Optional

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy import func, or_

import voice_parsing
from business_time import business_today, period_bounds
from voice_state import PendingOperation, VoiceConversation


class VoiceOperationError(RuntimeError):
    """Safe error that may be shown to the administrator."""

    def __init__(self, message: str, status_code: int = 409) -> None:
        super().__init__(message)
        self.status_code = status_code


def _m():
    """Import the application module lazily to avoid a circular import."""
    import main

    return main


def _ok(**payload: Any) -> dict[str, Any]:
    return {"ok": True, **payload}


def _error(message: str, **payload: Any) -> dict[str, Any]:
    return {"ok": False, "error": message, **payload}


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EmptyArgs(_Strict):
    pass


class PeriodArgs(_Strict):
    period: str = Field(default="today", max_length=32)


class OrderListArgs(_Strict):
    filter: str = Field(default="pending", max_length=32)
    period: str = Field(default="today", max_length=32)
    limit: int = Field(default=20, ge=1, le=50)


class SearchArgs(_Strict):
    query: str = Field(min_length=1, max_length=120)
    limit: int = Field(default=10, ge=1, le=30)


class CustomerDetailsArgs(_Strict):
    customer_id: Optional[int] = Field(default=None, ge=1)
    query: Optional[str] = Field(default=None, max_length=120)


class OrderDetailsArgs(_Strict):
    order_id: Optional[int] = Field(default=None, ge=1)
    invoice_number: Optional[str] = Field(default=None, max_length=40)


class ProductArgs(_Strict):
    product_id: Optional[int] = Field(default=None, ge=1)
    query: Optional[str] = Field(default=None, max_length=120)


class CustomerCreateArgs(_Strict):
    name: str = Field(min_length=2, max_length=80)
    phone: str = Field(min_length=1, max_length=24)
    alternate_phone: str = Field(default="", max_length=24)
    address: str = Field(default="", max_length=240)
    city: str = Field(default="Madurai", max_length=80)
    notes: str = Field(default="", max_length=800)


class CustomerUpdateArgs(_Strict):
    customer_id: Optional[int] = Field(default=None, ge=1)
    customer_query: Optional[str] = Field(default=None, max_length=120)
    name: Optional[str] = Field(default=None, min_length=2, max_length=80)
    phone: Optional[str] = Field(default=None, max_length=24)
    alternate_phone: Optional[str] = Field(default=None, max_length=24)
    address: Optional[str] = Field(default=None, max_length=240)
    city: Optional[str] = Field(default=None, max_length=80)
    notes: Optional[str] = Field(default=None, max_length=800)


class OrderCreateArgs(_Strict):
    customer_id: Optional[int] = Field(default=None, ge=1)
    customer_query: Optional[str] = Field(default=None, max_length=120)
    product_id: Optional[int] = Field(default=None, ge=1)
    product_query: Optional[str] = Field(default=None, max_length=120)
    measurements: dict[str, str] = Field(default_factory=dict)
    total_amount: Optional[float] = Field(default=None, ge=0, le=100_000_000)
    paid_amount: float = Field(default=0, ge=0, le=100_000_000)
    extra_amount: float = Field(default=0, ge=0, le=100_000_000)
    delivery_date: str = Field(default="", max_length=20)
    description: str = Field(default="", max_length=1000)
    order_date: Optional[str] = Field(default=None, max_length=20)

    @field_validator("total_amount", "paid_amount", "extra_amount")
    @classmethod
    def finite(cls, value: Optional[float]) -> Optional[float]:
        if value is not None and not math.isfinite(value):
            raise ValueError("Amount must be finite")
        return value


class MeasurementUpdateArgs(_Strict):
    order_id: Optional[int] = Field(default=None, ge=1)
    invoice_number: Optional[str] = Field(default=None, max_length=40)
    measurements: dict[str, str] = Field(default_factory=dict)


class PaymentArgs(_Strict):
    order_id: Optional[int] = Field(default=None, ge=1)
    invoice_number: Optional[str] = Field(default=None, max_length=40)
    amount: float = Field(gt=0, le=100_000_000)

    @field_validator("amount")
    @classmethod
    def finite(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("Amount must be finite")
        return value


class DeliveryArgs(_Strict):
    order_id: Optional[int] = Field(default=None, ge=1)
    invoice_number: Optional[str] = Field(default=None, max_length=40)
    delivery_date: str = Field(min_length=4, max_length=40)


class StatusArgs(_Strict):
    order_id: Optional[int] = Field(default=None, ge=1)
    invoice_number: Optional[str] = Field(default=None, max_length=40)
    status: str = Field(min_length=3, max_length=40)


class OrderUpdateArgs(_Strict):
    order_id: Optional[int] = Field(default=None, ge=1)
    invoice_number: Optional[str] = Field(default=None, max_length=40)
    delivery_date: Optional[str] = Field(default=None, max_length=40)
    status: Optional[str] = Field(default=None, max_length=40)
    description: Optional[str] = Field(default=None, max_length=1000)


class InvoiceArgs(_Strict):
    order_id: Optional[int] = Field(default=None, ge=1)
    invoice_number: Optional[str] = Field(default=None, max_length=40)


# ---------------------------------------------------------------------------
# Query helpers
# ---------------------------------------------------------------------------
def _get_order(db, order_id: Optional[int], invoice_number: Optional[str]):
    m = _m()
    if order_id:
        return db.query(m.Order).filter(m.Order.id == order_id).first()
    if invoice_number:
        value = invoice_number.strip()
        query = db.query(m.Order).filter(m.Order.invoice_number.ilike(value))
        if not value.upper().startswith("INV-"):
            query = db.query(m.Order).filter(m.Order.invoice_number.ilike(f"%{value}%"))
        return query.order_by(m.Order.id.desc()).first()
    return None


def _resolve_customer(db, customer_id: Optional[int], query_text: Optional[str]) -> tuple[Any | None, list[Any]]:
    m = _m()
    if customer_id:
        return db.query(m.Customer).filter(m.Customer.id == customer_id).first(), []
    value = (query_text or "").strip()
    if not value:
        return None, []
    digits = re.sub(r"\D", "", value)
    query = db.query(m.Customer)
    filters = [m.Customer.name.ilike(f"%{value}%")]
    if digits:
        filters.append(m.Customer.phone.ilike(f"%{digits}%"))
    matches = query.filter(or_(*filters)).order_by(m.Customer.id.desc()).limit(8).all()
    if not matches:
        return None, []
    exact = [item for item in matches if item.name.casefold() == value.casefold()]
    if len(exact) == 1:
        return exact[0], []
    if len(matches) == 1:
        return matches[0], []
    return None, matches


def _resolve_product(db, product_id: Optional[int], query_text: Optional[str]) -> tuple[Any | None, list[Any]]:
    m = _m()
    if product_id:
        return db.query(m.Product).filter(m.Product.id == product_id).first(), []
    value = (query_text or "").strip()
    if not value:
        return None, []
    matches = db.query(m.Product).filter(
        m.Product.name.ilike(f"%{value}%"), m.Product.active.is_(True)
    ).order_by(m.Product.id.asc()).limit(8).all()
    if not matches:
        return None, []
    exact = [item for item in matches if item.name.casefold() == value.casefold()]
    if len(exact) == 1:
        return exact[0], []
    if len(matches) == 1:
        return matches[0], []
    return None, matches


def _template_fields(product, db) -> list[str]:
    m = _m()
    if not product or not product.measurement_template_id:
        return []
    template = db.query(m.MeasurementTemplate).filter(
        m.MeasurementTemplate.id == product.measurement_template_id
    ).first()
    if not template:
        return []
    return [field.field_name for field in sorted(template.fields, key=lambda item: item.sort_order)]


def _serialize_orders(db, orders: list[Any]) -> list[dict[str, Any]]:
    if not orders:
        return []
    m = _m()
    customer_ids = {order.customer_id for order in orders if order.customer_id}
    product_ids = {order.product_id for order in orders if order.product_id}
    order_ids = [order.id for order in orders]
    customers = {
        item.id: item for item in db.query(m.Customer).filter(m.Customer.id.in_(customer_ids)).all()
    } if customer_ids else {}
    products = {
        item.id: item for item in db.query(m.Product).filter(m.Product.id.in_(product_ids)).all()
    } if product_ids else {}
    measurements: dict[int, list[dict[str, str]]] = {order_id: [] for order_id in order_ids}
    for row in db.query(m.OrderMeasurement).filter(m.OrderMeasurement.order_id.in_(order_ids)).all():
        measurements.setdefault(row.order_id, []).append(
            {"field_name": row.field_name, "value": row.value}
        )
    today = business_today().isoformat()
    output = []
    for order in orders:
        customer = customers.get(order.customer_id)
        product = products.get(order.product_id)
        output.append({
            "id": order.id,
            "invoice_number": order.invoice_number,
            "order_date": order.order_date,
            "delivery_date": order.delivery_date,
            "customer_id": order.customer_id,
            "customer_name": customer.name if customer else "Unknown",
            "customer_phone": customer.phone if customer else "",
            "product_id": order.product_id,
            "product_name": product.name if product else "Unknown",
            "total_amount": order.total_amount,
            "paid_amount": order.paid_amount,
            "balance": order.balance,
            "status": order.status,
            "description": order.description,
            "measurements": measurements.get(order.id, []),
            "overdue": bool(order.delivery_date and order.delivery_date < today and order.balance > 0),
        })
    return output


def _serialize_customer(db, customer, include_history: bool = True) -> dict[str, Any]:
    m = _m()
    orders = db.query(m.Order).filter(m.Order.customer_id == customer.id).order_by(m.Order.id.desc()).limit(10).all()
    serialized = _serialize_orders(db, orders)
    return {
        "id": customer.id,
        "cust_code": f"CUST-{customer.id:03d}",
        "name": customer.name,
        "phone": customer.phone,
        "alternate_phone": customer.alternate_phone,
        "address": customer.address,
        "city": customer.city,
        "notes": customer.notes,
        "order_count": len(orders),
        "orders": serialized if include_history else [],
        "last_measurements": serialized[0]["measurements"] if serialized else [],
    }


def _customer_choices(customers: list[Any]) -> list[dict[str, Any]]:
    return [
        {
            "customer_id": item.id,
            "name": item.name,
            "phone": item.phone,
            "city": item.city,
            "cust_code": f"CUST-{item.id:03d}",
        }
        for item in customers
    ]


def _parse_delivery(value: str) -> str:
    parsed = voice_parsing.parse_date(value)
    if not parsed:
        raise VoiceOperationError("Please give a valid delivery date, for example 2026-11-05, tomorrow, or Friday.", 422)
    return parsed


def _canonical_measurements(fields: list[str], values: dict[str, str]) -> tuple[dict[str, str], list[dict[str, Any]], list[str]]:
    """Return canonical field values, unresolved unit questions, and invalid fields."""
    canonical: dict[str, str] = {}
    unresolved: list[dict[str, Any]] = []
    invalid: list[str] = []
    lookup = {field.casefold(): field for field in fields}
    for key, raw_value in values.items():
        key_text = str(key).strip()
        field = lookup.get(key_text.casefold())
        if not field:
            field = next(
                (candidate for candidate in fields if key_text.casefold() and (
                    candidate.casefold().startswith(key_text.casefold())
                    or key_text.casefold() in candidate.casefold().split()
                )),
                None,
            )
        if not field:
            invalid.append(key_text)
            continue
        quantity = voice_parsing.parse_quantity(str(raw_value))
        if quantity is None:
            invalid.append(field)
            continue
        number, unit = quantity
        if unit is None:
            unresolved.append({"field": field, "value": str(number), "unit": None})
            continue
        text_value = f"{int(number) if float(number).is_integer() else number} {unit}"
        canonical[field] = text_value
    return canonical, unresolved, invalid


def _required_missing(fields: list[str], measurements: dict[str, str]) -> list[str]:
    return [field for field in fields if field not in measurements]


def _question_for(field: str) -> str:
    if field == "total amount":
        return "What is the total amount?"
    if field == "delivery date":
        return "What is the delivery date? You can say a date like 5 November, tomorrow, or Friday."
    return f"What is the {field} measurement, including inches or centimetres?"


def _next_question(missing: list[str]) -> str:
    return _question_for(missing[0]) if missing else ""


def _build_preview(draft: dict[str, Any]) -> dict[str, Any]:
    total = float(draft.get("total_amount") or 0)
    paid = float(draft.get("paid_amount") or 0)
    return {
        "customer_id": draft.get("customer_id"),
        "customer": draft.get("customer_name"),
        "product_id": draft.get("product_id"),
        "product": draft.get("product_name"),
        "measurements": draft.get("measurements", {}),
        "total_amount": round(total, 2),
        "paid_amount": round(paid, 2),
        "balance": round(total - paid, 2),
        "delivery_date": draft.get("delivery_date", ""),
        "description": draft.get("description", ""),
    }


def _new_order_draft(customer, product, fields: list[str]) -> dict[str, Any]:
    return {
        "customer_id": customer.id,
        "customer_name": customer.name,
        "product_id": product.id,
        "product_name": product.name,
        "pricing_type": product.pricing_type,
        "order_date": business_today().isoformat(),
        "delivery_date": "",
        "measurements": {},
        "required_measurements": list(fields),
        "total_amount": None,
        "paid_amount": 0,
        "extra_amount": 0,
        "description": "",
    }


def compute_order_missing(draft: dict[str, Any]) -> list[str]:
    missing = _required_missing(draft.get("required_measurements", []), draft.get("measurements", {}))
    if draft.get("total_amount") is None:
        missing.append("total amount")
    if not draft.get("delivery_date"):
        missing.append("delivery date")
    return missing


def refresh_order_draft(conversation: VoiceConversation) -> dict[str, Any]:
    """Recompute missing fields and prepare confirmation when the draft is complete."""
    draft = conversation.draft
    missing = compute_order_missing(draft)
    conversation.missing_fields = missing
    if missing:
        conversation.clarification = _next_question(missing)
        if conversation.pending and conversation.pending.action == "create_order":
            conversation.pending = None
        return _ok(
            status="needs_clarification",
            question=conversation.clarification,
            missing_fields=missing,
            draft=draft,
        )
    preview = _build_preview(draft)
    conversation.clarification = None
    conversation.pending = PendingOperation(
        action="create_order",
        payload={"draft": copy.deepcopy(draft), "preview": preview},
        preview=preview,
    )
    return _ok(
        status="prepared",
        preview=preview,
        confirmation_id=conversation.pending.confirmation_id,
        expires_at=conversation.pending.expires_at,
    )


# ---------------------------------------------------------------------------
# Draft continuation helpers used by the deterministic and model planners
# ---------------------------------------------------------------------------
def resolve_customer(db, customer_id: Optional[int] = None, query_text: Optional[str] = None):
    return _resolve_customer(db, customer_id, query_text)


def resolve_product(db, product_id: Optional[int] = None, query_text: Optional[str] = None):
    return _resolve_product(db, product_id, query_text)


def template_fields(product, db) -> list[str]:
    return _template_fields(product, db)


def public_customer(customer) -> dict[str, Any]:
    return _customer_choices([customer])[0]


def voice_order_supported(product) -> bool:
    """Voice pricing covers manual amounts only; stitch rates need more input."""
    return (getattr(product, "pricing_type", "") or "").upper() != "STITCH_BASED"


VOICE_STITCH_BASED_MESSAGE = (
    "This product is priced per stitch, so it needs a stitch count and embroidery rate. "
    "Please create that order in the manual order form; no order was prepared."
)


def start_order_draft(db, conversation: VoiceConversation, customer, product) -> dict[str, Any]:
    if not voice_order_supported(product):
        raise VoiceOperationError(VOICE_STITCH_BASED_MESSAGE, 409)
    fields = _template_fields(product, db)
    conversation.intent = "create_order"
    conversation.draft = _new_order_draft(customer, product, fields)
    conversation.awaiting = None
    conversation.last_field = None
    conversation.missing_fields = compute_order_missing(conversation.draft)
    conversation.clarification = _next_question(conversation.missing_fields)
    return conversation.draft


def apply_measurements_to_draft(
    db, conversation: VoiceConversation, values: dict[str, str]
) -> dict[str, Any]:
    """Merge measurement text into the active order draft without guessing units."""
    if conversation.intent != "create_order" or not conversation.draft:
        return _error("There is no active order draft. Start an order first.")
    fields = list(conversation.draft.get("required_measurements", []))
    canonical, unresolved, invalid = _canonical_measurements(fields, values)
    if invalid:
        return _ok(
            status="needs_clarification",
            question=(
                "I could not match these measurement names: "
                + ", ".join(invalid)
                + ". Valid measurements are: "
                + (", ".join(fields) if fields else "none for this product")
                + "."
            ),
            invalid_fields=invalid,
            valid_fields=fields,
            draft=conversation.draft,
        )
    conversation.draft.setdefault("measurements", {}).update(canonical)
    if unresolved:
        first = unresolved[0]
        conversation.awaiting = {"kind": "unit", "field": first["field"], "value": first["value"]}
        conversation.last_field = first["field"]
        conversation.missing_fields = compute_order_missing(conversation.draft)
        conversation.clarification = (
            f"Is {first['field']} {first['value']} inches or centimetres?"
        )
        return _ok(
            status="needs_clarification",
            question=conversation.clarification,
            awaiting=conversation.awaiting,
            missing_fields=conversation.missing_fields,
            draft=conversation.draft,
        )
    return refresh_order_draft(conversation)


def apply_unit_answer(db, conversation: VoiceConversation, unit: str) -> dict[str, Any]:
    """Resolve a pending inches/centimetres question with the spoken unit."""
    awaiting = conversation.awaiting or {}
    if awaiting.get("kind") != "unit":
        return _error("There is no measurement waiting for a unit.")
    field = awaiting.get("field")
    value = awaiting.get("value")
    if not field or value is None:
        conversation.awaiting = None
        return _error("That measurement could not be resolved. Please say it again with a unit.")
    text_value = f"{value} {unit}"
    purpose = awaiting.get("purpose", "create_order")
    if purpose == "measurement_update":
        measurements = dict(awaiting.get("measurements") or {})
        measurements[field] = text_value
        conversation.awaiting = None
        return prepare_measurement_update(
            MeasurementUpdateArgs(order_id=awaiting.get("order_id"), measurements=measurements),
            db,
            conversation,
        )
    if conversation.intent != "create_order" or not conversation.draft:
        conversation.awaiting = None
        return _error("The order draft is no longer active. Please start the order again.")
    conversation.draft.setdefault("measurements", {})[field] = text_value
    conversation.awaiting = None
    conversation.last_field = field
    return refresh_order_draft(conversation)


# ---------------------------------------------------------------------------
# Read-only tools
# ---------------------------------------------------------------------------
def get_business_summary(args: PeriodArgs, db, conversation) -> dict[str, Any]:
    m = _m()
    start, end = period_bounds(args.period)
    order_query = db.query(m.Order)
    if start:
        order_query = order_query.filter(m.Order.order_date >= start, m.Order.order_date <= end)
    orders = order_query.all()
    payment_query = db.query(m.Transaction).filter(m.Transaction.type == "INCOME")
    if start:
        payment_query = payment_query.filter(m.Transaction.date >= start, m.Transaction.date <= end)
    payments = payment_query.all()
    outstanding = db.query(func.coalesce(func.sum(m.Order.balance), 0)).filter(m.Order.balance > 0).scalar() or 0
    today = business_today().isoformat()
    overdue = db.query(func.count(m.Order.id)).filter(
        m.Order.delivery_date != "", m.Order.delivery_date < today, m.Order.balance > 0
    ).scalar() or 0
    return _ok(
        period=args.period,
        start_date=start,
        end_date=end,
        orders=len(orders),
        order_value=round(sum(order.total_amount for order in orders), 2),
        collected=round(sum(payment.amount for payment in payments), 2),
        outstanding=round(float(outstanding), 2),
        pending_orders=db.query(func.count(m.Order.id)).filter(m.Order.balance > 0).scalar() or 0,
        overdue_orders=overdue,
        customers=db.query(func.count(m.Customer.id)).scalar() or 0,
    )


def get_sales_summary(args: PeriodArgs, db, conversation) -> dict[str, Any]:
    summary = get_business_summary(args, db, conversation)
    order_value = summary.get("order_value", 0)
    collected = summary.get("collected", 0)
    orders = summary.get("orders", 0)
    return _ok(
        period=args.period,
        start_date=summary.get("start_date"),
        end_date=summary.get("end_date"),
        orders=orders,
        order_value=order_value,
        collected=collected,
        average_order_value=round(order_value / orders, 2) if orders else 0,
        outstanding_current=summary.get("outstanding", 0),
        pending_orders_current=summary.get("pending_orders", 0),
        note="Order value is not the same as money collected.",
    )


def get_order_counts(args: PeriodArgs, db, conversation) -> dict[str, Any]:
    m = _m()
    start, end = period_bounds(args.period)
    query = db.query(m.Order)
    if start:
        query = query.filter(m.Order.order_date >= start, m.Order.order_date <= end)
    orders = query.all()
    today = business_today().isoformat()
    counts: dict[str, int] = {}
    for order in orders:
        counts[order.status or "Unknown"] = counts.get(order.status or "Unknown", 0) + 1
    return _ok(
        period=args.period,
        start_date=start,
        end_date=end,
        total=len(orders),
        by_status=counts,
        pending=sum(1 for order in orders if order.balance > 0),
        paid=sum(1 for order in orders if order.balance == 0),
        overdue=sum(1 for order in orders if order.delivery_date and order.delivery_date < today and order.balance > 0),
        due_today=sum(1 for order in orders if order.delivery_date == today and order.balance > 0),
        due_tomorrow=sum(1 for order in orders if order.delivery_date == (business_today() + timedelta(days=1)).isoformat() and order.balance > 0),
    )


def list_orders(args: OrderListArgs, db, conversation) -> dict[str, Any]:
    m = _m()
    today = business_today()
    tomorrow = (today + timedelta(days=1)).isoformat()
    query = db.query(m.Order)
    key = args.filter.strip().lower().replace("-", "_")
    if key in {"pending", "unpaid", "outstanding"}:
        query = query.filter(m.Order.balance > 0)
    elif key in {"overdue", "late"}:
        query = query.filter(m.Order.delivery_date != "", m.Order.delivery_date < today.isoformat(), m.Order.balance > 0)
    elif key in {"due_today", "today"}:
        query = query.filter(m.Order.delivery_date == today.isoformat(), m.Order.balance > 0)
    elif key in {"due_tomorrow", "tomorrow"}:
        query = query.filter(m.Order.delivery_date == tomorrow, m.Order.balance > 0)
    elif key in {"completed", "paid"}:
        query = query.filter(m.Order.balance == 0)
    elif key in {"completed_today", "paid_today"}:
        query = query.filter(m.Order.order_date == today.isoformat(), m.Order.balance == 0)
    elif key in {"this_week", "last_7_days", "this_month"}:
        start, end = period_bounds(key)
        query = query.filter(m.Order.order_date >= start, m.Order.order_date <= end)
    elif key not in {"recent", "all"}:
        return _error(f"Unknown order filter '{args.filter}'. Use pending, overdue, due_today, due_tomorrow, completed, or recent.")
    orders = query.order_by(m.Order.id.desc()).limit(args.limit).all()
    return _ok(filter=key, count=len(orders), orders=_serialize_orders(db, orders))


def search_customers(args: SearchArgs, db, conversation) -> dict[str, Any]:
    m = _m()
    value = args.query.strip()
    digits = re.sub(r"\D", "", value)
    query = db.query(m.Customer)
    if digits:
        query = query.filter((m.Customer.name.ilike(f"%{value}%")) | (m.Customer.phone.ilike(f"%{digits}%")))
    else:
        query = query.filter(m.Customer.name.ilike(f"%{value}%"))
    customers = query.order_by(m.Customer.id.desc()).limit(args.limit).all()
    return _ok(count=len(customers), customers=[_serialize_customer(db, item, include_history=False) for item in customers])


def get_customer_details(args: CustomerDetailsArgs, db, conversation) -> dict[str, Any]:
    customer, candidates = _resolve_customer(db, args.customer_id, args.query)
    if not customer:
        if candidates:
            return _error("Multiple customers match. Ask which one is correct.", candidates=_customer_choices(candidates))
        return _error("Customer not found.")
    return _ok(customer=_serialize_customer(db, customer))


def get_customer_order_history(args: CustomerDetailsArgs, db, conversation) -> dict[str, Any]:
    customer, candidates = _resolve_customer(db, args.customer_id, args.query)
    if not customer:
        if candidates:
            return _error("Multiple customers match. Ask which one is correct.", candidates=_customer_choices(candidates))
        return _error("Customer not found.")
    m = _m()
    orders = db.query(m.Order).filter(m.Order.customer_id == customer.id).order_by(m.Order.id.desc()).limit(20).all()
    return _ok(customer=_customer_choices([customer])[0], orders=_serialize_orders(db, orders))


def search_orders(args: SearchArgs, db, conversation) -> dict[str, Any]:
    m = _m()
    value = args.query.strip()
    order_query = db.query(m.Order).filter(m.Order.invoice_number.ilike(f"%{value}%"))
    digits = re.sub(r"\D", "", value)
    customer_ids = [
        row.id for row in db.query(m.Customer.id).filter(
            (m.Customer.name.ilike(f"%{value}%")) |
            (m.Customer.phone.ilike(f"%{digits}%") if digits else m.Customer.name.ilike(f"%{value}%"))
        ).limit(20).all()
    ]
    if customer_ids:
        order_query = db.query(m.Order).filter(
            (m.Order.invoice_number.ilike(f"%{value}%")) | (m.Order.customer_id.in_(customer_ids))
        )
    orders = order_query.order_by(m.Order.id.desc()).limit(args.limit).all()
    return _ok(count=len(orders), orders=_serialize_orders(db, orders))


def get_order_details(args: OrderDetailsArgs, db, conversation) -> dict[str, Any]:
    order = _get_order(db, args.order_id, args.invoice_number)
    if not order:
        return _error("Order not found. Provide the order number or invoice number.")
    return _ok(order=_serialize_orders(db, [order])[0])


def get_outstanding_payments(args: OrderListArgs, db, conversation) -> dict[str, Any]:
    m = _m()
    orders = db.query(m.Order).filter(m.Order.balance > 0).order_by(m.Order.delivery_date.asc(), m.Order.id.asc()).limit(args.limit).all()
    total = db.query(func.coalesce(func.sum(m.Order.balance), 0)).filter(m.Order.balance > 0).scalar() or 0
    return _ok(total_outstanding=round(float(total), 2), count=len(orders), orders=_serialize_orders(db, orders))


def get_payment_history(args: PeriodArgs, db, conversation) -> dict[str, Any]:
    m = _m()
    start, end = period_bounds(args.period)
    query = db.query(m.Transaction).filter(m.Transaction.type == "INCOME")
    if start:
        query = query.filter(m.Transaction.date >= start, m.Transaction.date <= end)
    rows = query.order_by(m.Transaction.date.desc(), m.Transaction.id.desc()).limit(50).all()
    return _ok(
        period=args.period,
        start_date=start,
        end_date=end,
        count=len(rows),
        total=round(sum(row.amount for row in rows), 2),
        payments=[
            {
                "date": row.date,
                "amount": row.amount,
                "category": row.category,
                "description": row.description,
                "reference": row.reference,
            }
            for row in rows
        ],
    )


def list_products(args: ProductArgs, db, conversation) -> dict[str, Any]:
    m = _m()
    query = db.query(m.Product).filter(m.Product.active.is_(True))
    if args.product_id:
        query = query.filter(m.Product.id == args.product_id)
    if args.query:
        query = query.filter(m.Product.name.ilike(f"%{args.query.strip()}%"))
    products = query.order_by(m.Product.name.asc()).limit(50).all()
    return _ok(products=[
        {
            "product_id": product.id,
            "name": product.name,
            "pricing_type": product.pricing_type,
            "base_price": product.base_price,
            "required_measurements": _template_fields(product, db),
        }
        for product in products
    ])


def get_measurement_template(args: ProductArgs, db, conversation) -> dict[str, Any]:
    product, candidates = _resolve_product(db, args.product_id, args.query)
    if not product:
        if candidates:
            return _error("Multiple products match. Ask which product is correct.", candidates=[item.name for item in candidates])
        return _error("Product not found.")
    fields = _template_fields(product, db)
    return _ok(product={"product_id": product.id, "name": product.name, "pricing_type": product.pricing_type}, required_measurements=fields)


# ---------------------------------------------------------------------------
# Prepare (write) tools
# ---------------------------------------------------------------------------
def prepare_customer_creation(args: CustomerCreateArgs, db, conversation) -> dict[str, Any]:
    m = _m()
    phone = voice_parsing.parse_phone(args.phone)
    if not phone:
        return _error("Please provide a valid phone number with 10 to 15 digits.")
    existing = db.query(m.Customer).filter(m.Customer.phone == phone).first()
    if existing:
        return _ok(
            status="needs_clarification",
            question=f"A customer with phone {phone} already exists: {existing.name}. Do you want to use that customer instead?",
            existing_customer=_customer_choices([existing])[0],
        )
    similar = db.query(m.Customer).filter(m.Customer.name.ilike(f"%{args.name.strip()}%")).limit(5).all()
    preview = {
        "name": args.name.strip(),
        "phone": phone,
        "alternate_phone": args.alternate_phone.strip(),
        "address": args.address.strip(),
        "city": args.city.strip() or "Madurai",
        "notes": args.notes.strip(),
        "similar_customers": _customer_choices(similar),
    }
    conversation.pending = PendingOperation(
        action="create_customer",
        payload={"customer": preview},
        preview=preview,
    )
    return _ok(status="prepared", preview=preview, confirmation_id=conversation.pending.confirmation_id,
               expires_at=conversation.pending.expires_at)


def prepare_customer_update(args: CustomerUpdateArgs, db, conversation) -> dict[str, Any]:
    m = _m()
    customer, candidates = _resolve_customer(db, args.customer_id, args.customer_query)
    if not customer:
        if candidates:
            return _ok(status="needs_clarification", question="Which customer did you mean?",
                       candidates=_customer_choices(candidates),
                       awaiting={"kind": "customer_choice", "purpose": "customer_update",
                                 "candidates": _customer_choices(candidates), "changes": args.model_dump(exclude_none=True)})
        return _error("Customer not found.")
    changes = args.model_dump(exclude_none=True, exclude={"customer_id", "customer_query"})
    if not changes:
        return _error("No customer changes were provided.")
    if "phone" in changes:
        phone = voice_parsing.parse_phone(changes["phone"])
        if not phone:
            return _error("Please provide a valid phone number with 10 to 15 digits.")
        duplicate = db.query(m.Customer).filter(m.Customer.phone == phone, m.Customer.id != customer.id).first()
        if duplicate:
            return _error(f"Phone {phone} already belongs to {duplicate.name}.")
        changes["phone"] = phone
    preview = {
        "customer_id": customer.id,
        "customer": customer.name,
        "current": {key: getattr(customer, key) for key in changes},
        "changes": changes,
    }
    conversation.pending = PendingOperation(
        action="update_customer",
        payload={"customer_id": customer.id, "changes": changes},
        preview=preview,
    )
    return _ok(status="prepared", preview=preview, confirmation_id=conversation.pending.confirmation_id,
               expires_at=conversation.pending.expires_at)


def prepare_order_creation(args: OrderCreateArgs, db, conversation) -> dict[str, Any]:
    customer, candidates = _resolve_customer(db, args.customer_id, args.customer_query)
    if not customer:
        if candidates:
            return _ok(
                status="needs_clarification",
                question="I found more than one matching customer. Which one do you mean?",
                candidates=_customer_choices(candidates),
                awaiting={"kind": "customer_choice", "purpose": "create_order",
                          "candidates": _customer_choices(candidates),
                          "product_id": args.product_id, "product_query": args.product_query},
            )
        return _error(
            "I could not find that customer. Create the customer first, or say a different name or phone number."
        )
    product, products = _resolve_product(db, args.product_id, args.product_query)
    if not product:
        if products:
            return _ok(
                status="needs_clarification",
                question="Which product or work type did you mean?",
                candidates=[{"product_id": item.id, "name": item.name} for item in products],
                awaiting={"kind": "product_choice", "purpose": "create_order",
                          "candidates": [{"product_id": item.id, "name": item.name} for item in products],
                          "customer_id": customer.id},
            )
        return _error("I could not find an active matching product. Say the exact configured product name.")

    if not voice_order_supported(product):
        return _error(VOICE_STITCH_BASED_MESSAGE)

    fields = _template_fields(product, db)
    same_draft = (
        conversation.intent == "create_order"
        and conversation.draft.get("customer_id") == customer.id
        and conversation.draft.get("product_id") == product.id
    )
    if same_draft:
        draft = conversation.draft
        draft["required_measurements"] = fields
    else:
        draft = _new_order_draft(customer, product, fields)
        conversation.draft = draft
    conversation.intent = "create_order"

    canonical, unresolved, invalid = _canonical_measurements(fields, args.measurements or {})
    if invalid:
        return _ok(
            status="needs_clarification",
            question=(
                "I could not match these measurement names: "
                + ", ".join(invalid)
                + ". Valid measurements are: " + (", ".join(fields) if fields else "none for this product") + "."
            ),
            invalid_fields=invalid,
            valid_fields=fields,
        )
    draft["measurements"].update(canonical)
    if unresolved:
        first = unresolved[0]
        conversation.awaiting = {"kind": "unit", "field": first["field"], "value": first["value"]}
        conversation.last_field = first["field"]
        conversation.missing_fields = compute_order_missing(draft)
        conversation.clarification = f"Is {first['field']} {first['value']} inches or centimetres?"
        return _ok(
            status="needs_clarification",
            question=conversation.clarification,
            awaiting=conversation.awaiting,
            missing_fields=conversation.missing_fields,
            draft=draft,
        )

    if args.total_amount is not None:
        draft["total_amount"] = round(float(args.total_amount), 2)
    if args.paid_amount:
        draft["paid_amount"] = round(float(args.paid_amount), 2)
    if args.extra_amount:
        draft["extra_amount"] = round(float(args.extra_amount), 2)
    if args.description:
        draft["description"] = args.description
    if args.order_date:
        draft["order_date"] = _parse_delivery(args.order_date)
    if args.delivery_date:
        try:
            draft["delivery_date"] = _parse_delivery(args.delivery_date)
        except VoiceOperationError as exc:
            return _error(str(exc))

    result = refresh_order_draft(conversation)
    return result


def prepare_measurement_update(args: MeasurementUpdateArgs, db, conversation) -> dict[str, Any]:
    order = _get_order(db, args.order_id, args.invoice_number)
    if not order:
        return _error("Order not found.")
    m = _m()
    product = db.query(m.Product).filter(m.Product.id == order.product_id).first()
    fields = _template_fields(product, db)
    if not fields:
        return _error("This product has no measurement template.")
    if not args.measurements:
        return _error("No measurements were provided.")
    canonical, unresolved, invalid = _canonical_measurements(fields, args.measurements)
    if invalid:
        return _error("Unknown measurement name(s): " + ", ".join(invalid) + ". Valid fields: " + ", ".join(fields) + ".")
    if unresolved:
        first = unresolved[0]
        conversation.awaiting = {
            "kind": "unit", "field": first["field"], "value": first["value"],
            "purpose": "measurement_update", "order_id": order.id,
            "measurements": canonical,
        }
        conversation.last_field = first["field"]
        return _ok(status="needs_clarification",
                   question=f"Is {first['field']} {first['value']} inches or centimetres?",
                   awaiting=conversation.awaiting)
    preview = {
        "order_id": order.id,
        "invoice_number": order.invoice_number,
        "customer": None,
        "changes": canonical,
    }
    conversation.pending = PendingOperation(
        action="update_measurements",
        payload={"order_id": order.id, "measurements": canonical},
        preview=preview,
    )
    return _ok(status="prepared", preview=preview, confirmation_id=conversation.pending.confirmation_id,
               expires_at=conversation.pending.expires_at)


def prepare_payment_recording(args: PaymentArgs, db, conversation) -> dict[str, Any]:
    order = _get_order(db, args.order_id, args.invoice_number)
    if not order:
        return _error("I could not find that order. Give the order number or invoice number.")
    amount = round(float(args.amount), 2)
    if not math.isfinite(amount) or amount <= 0:
        return _error("Payment amount must be greater than zero.")
    if amount > order.balance:
        return _error(
            f"{order.invoice_number} has an outstanding balance of Rs. {order.balance:,.2f}; "
            f"Rs. {amount:,.2f} is too much."
        )
    preview = {
        "order_id": order.id,
        "invoice_number": order.invoice_number,
        "payment_amount": amount,
        "current_balance": order.balance,
        "balance_after": round(order.balance - amount, 2),
    }
    conversation.pending = PendingOperation(
        action="record_payment",
        payload={"order_id": order.id, "amount": amount},
        preview=preview,
    )
    return _ok(status="prepared", preview=preview, confirmation_id=conversation.pending.confirmation_id,
               expires_at=conversation.pending.expires_at)


def prepare_delivery_date_update(args: DeliveryArgs, db, conversation) -> dict[str, Any]:
    order = _get_order(db, args.order_id, args.invoice_number)
    if not order:
        return _error("Order not found.")
    parsed = voice_parsing.parse_date(args.delivery_date)
    if not parsed:
        return _error("Please give a valid delivery date, for example 2026-11-05, tomorrow, or Friday.")
    preview = {
        "order_id": order.id,
        "invoice_number": order.invoice_number,
        "old_delivery_date": order.delivery_date,
        "new_delivery_date": parsed,
    }
    conversation.pending = PendingOperation(
        action="update_delivery_date",
        payload={"order_id": order.id, "delivery_date": parsed},
        preview=preview,
    )
    return _ok(status="prepared", preview=preview, confirmation_id=conversation.pending.confirmation_id,
               expires_at=conversation.pending.expires_at)


_STATUS_MAP = {
    "pending": "Pending",
    "partially paid": "Partially Paid",
    "partial": "Partially Paid",
    "paid": "Paid",
    "ready": "Ready",
    "delivered": "Delivered",
    "completed": "Delivered",
}


def _normalize_status(value: str) -> str:
    return _STATUS_MAP.get(value.strip().casefold(), "")


def prepare_order_status_update(args: StatusArgs, db, conversation) -> dict[str, Any]:
    order = _get_order(db, args.order_id, args.invoice_number)
    if not order:
        return _error("Order not found.")
    status = _normalize_status(args.status)
    if not status:
        return _error("Unsupported status. Use Pending, Partially Paid, Paid, Ready, or Delivered.")
    if status == "Paid" and order.balance > 0:
        return _error(
            f"{order.invoice_number} still has Rs. {order.balance:,.2f} outstanding. "
            "Record the payment instead of marking it paid."
        )
    preview = {
        "order_id": order.id,
        "invoice_number": order.invoice_number,
        "old_status": order.status,
        "new_status": status,
    }
    conversation.pending = PendingOperation(
        action="update_order_status",
        payload={"order_id": order.id, "status": status},
        preview=preview,
    )
    return _ok(status="prepared", preview=preview, confirmation_id=conversation.pending.confirmation_id,
               expires_at=conversation.pending.expires_at)


def prepare_order_update(args: OrderUpdateArgs, db, conversation) -> dict[str, Any]:
    order = _get_order(db, args.order_id, args.invoice_number)
    if not order:
        return _error("Order not found.")
    changes: dict[str, Any] = {}
    if args.delivery_date:
        parsed = voice_parsing.parse_date(args.delivery_date)
        if not parsed:
            return _error("Please give a valid delivery date.")
        changes["delivery_date"] = parsed
    if args.status:
        status = _normalize_status(args.status)
        if not status:
            return _error("Unsupported status. Use Pending, Partially Paid, Paid, Ready, or Delivered.")
        if status == "Paid" and order.balance > 0:
            return _error(f"{order.invoice_number} still has Rs. {order.balance:,.2f} outstanding.")
        changes["status"] = status
    if args.description is not None:
        changes["description"] = args.description
    if not changes:
        return _error("No order changes were provided.")
    preview = {
        "order_id": order.id,
        "invoice_number": order.invoice_number,
        "current": {key: getattr(order, key) for key in changes},
        "changes": changes,
    }
    conversation.pending = PendingOperation(
        action="update_order",
        payload={"order_id": order.id, "changes": changes},
        preview=preview,
    )
    return _ok(status="prepared", preview=preview, confirmation_id=conversation.pending.confirmation_id,
               expires_at=conversation.pending.expires_at)


def prepare_invoice_generation(args: InvoiceArgs, db, conversation) -> dict[str, Any]:
    order = _get_order(db, args.order_id, args.invoice_number)
    if not order:
        return _error("Order not found.")
    return _ok(
        status="ui_action",
        ui_action={"type": "open_invoice", "order_id": order.id, "invoice_number": order.invoice_number},
        message=(
            f"Invoice {order.invoice_number} can be generated in the existing invoice viewer. "
            "The PDF is generated in memory and is not stored permanently."
        ),
    )


# ---------------------------------------------------------------------------
# Confirmation helpers and execution
# ---------------------------------------------------------------------------
def _phrase_amount(value: Any) -> str:
    """Format an amount without losing paise, while keeping whole rupees short."""
    try:
        amount = float(value)
    except (TypeError, ValueError):
        amount = 0.0
    text = f"{amount:.2f}".rstrip("0").rstrip(".")
    return text or "0"


def required_confirmation_phrase(pending: PendingOperation) -> str:
    preview = pending.preview or {}
    if pending.action == "record_payment":
        return f"confirm payment of {_phrase_amount(preview.get('payment_amount'))} for {preview.get('invoice_number', 'this order')}"
    if pending.action == "create_order":
        return f"confirm order for {preview.get('customer', 'this customer')} total {_phrase_amount(preview.get('total_amount'))}"
    if pending.action == "update_delivery_date":
        return f"confirm delivery for {preview.get('invoice_number', 'this order')} on {preview.get('new_delivery_date', '')}"
    if pending.action == "update_order_status":
        return f"confirm status {preview.get('new_status', '')} for {preview.get('invoice_number', 'this order')}"
    if pending.action == "update_measurements":
        return f"confirm measurements for {preview.get('invoice_number', 'this order')}"
    if pending.action == "create_customer":
        return f"confirm customer {preview.get('name', '')} {preview.get('phone', '')}"
    if pending.action == "update_customer":
        return f"confirm customer update for {preview.get('customer', '')}"
    if pending.action == "update_order":
        return f"confirm order update for {preview.get('invoice_number', 'this order')}"
    return "confirm this operation"


def confirmation_matches(pending: PendingOperation, phrase: str) -> bool:
    value = voice_parsing.normalize(phrase)
    if "confirm" not in value and "proceed" not in value:
        return False
    if pending.confirmation_id.casefold() in value:
        return True
    preview = pending.preview or {}
    invoice = str(preview.get("invoice_number", "")).casefold()
    order_id = preview.get("order_id")
    order_ref = bool(invoice and invoice in value) or bool(order_id and re.search(rf"\b{order_id}\b", value))

    def has_amount(amount: Any) -> bool:
        try:
            expected = float(amount)
        except (TypeError, ValueError):
            return False
        numbers = [float(item.replace(",", "")) for item in re.findall(r"\d+(?:[.,]\d+)?", value)]
        return any(abs(number - expected) < 0.01 for number in numbers)

    if pending.action == "record_payment":
        return order_ref and has_amount(preview.get("payment_amount"))
    if pending.action == "create_order":
        customer = str(preview.get("customer", "")).casefold()
        total_matches = has_amount(preview.get("total_amount"))
        customer_matches = not customer or customer in value
        return bool(total_matches and customer_matches)
    if pending.action in {"update_delivery_date", "update_measurements", "update_order_status", "update_order"}:
        return order_ref
    if pending.action == "create_customer":
        phone = str(preview.get("phone", ""))
        name = str(preview.get("name", "")).casefold()
        phone_matches = bool(phone and phone in value)
        name_matches = bool(name and name in value)
        return bool((phone_matches and (not name or name_matches)) or (not phone and name_matches))
    if pending.action == "update_customer":
        name = str(preview.get("customer", "")).casefold()
        return bool(name and name in value)
    return False


def _verify_order(db, order_id: int) -> dict[str, Any]:
    m = _m()
    order = db.query(m.Order).filter(m.Order.id == order_id).first()
    if not order:
        raise VoiceOperationError("The order could not be verified after saving.", 500)
    return _serialize_orders(db, [order])[0]


def _call_business(m, function, *args) -> Any:
    """Run an existing business function and translate its public errors safely."""
    try:
        return function(*args)
    except Exception as exc:
        status = getattr(exc, "status_code", None) or 409
        detail = getattr(exc, "detail", None)
        if isinstance(detail, str) and detail:
            raise VoiceOperationError(detail, int(status)) from exc
        raise VoiceOperationError(
            "The existing business rule rejected this change. No successful save was reported.",
            int(status) if isinstance(status, int) else 409,
        ) from exc


def execute_pending(pending: PendingOperation, db, admin) -> dict[str, Any]:
    """Execute an already-previewed operation.  The caller must validate ownership and expiry."""
    if pending.expired():
        raise VoiceOperationError("This confirmation has expired. Prepare the operation again.", 409)
    m = _m()
    action = pending.action
    payload = pending.payload

    if action == "create_customer":
        customer_data = payload["customer"]
        existing = db.query(m.Customer).filter(m.Customer.phone == customer_data["phone"]).first()
        if existing:
            raise VoiceOperationError(
                f"A customer with phone {customer_data['phone']} already exists: {existing.name}.", 409
            )
        customer = m.Customer(
            name=customer_data["name"],
            phone=customer_data["phone"],
            alternate_phone=customer_data.get("alternate_phone", ""),
            address=customer_data.get("address", ""),
            city=customer_data.get("city", "Madurai"),
            notes=customer_data.get("notes", ""),
        )
        try:
            db.add(customer)
            db.commit()
            db.refresh(customer)
        except Exception:
            db.rollback()
            raise VoiceOperationError("The customer could not be saved. No record was added.", 500)
        return {
            "ok": True,
            "message": f"Customer {customer.name} was created with customer code CUST-{customer.id:03d}.",
            "result": {"customer_id": customer.id, "name": customer.name, "phone": customer.phone},
        }

    if action == "update_customer":
        customer = db.query(m.Customer).filter(m.Customer.id == payload["customer_id"]).with_for_update().first()
        if not customer:
            raise VoiceOperationError("The customer is no longer available. Prepare the change again.", 409)
        changes = payload["changes"]
        if "phone" in changes:
            duplicate = db.query(m.Customer).filter(
                m.Customer.phone == changes["phone"], m.Customer.id != customer.id
            ).first()
            if duplicate:
                raise VoiceOperationError(f"Phone {changes['phone']} already belongs to {duplicate.name}.", 409)
        try:
            for key, value in changes.items():
                setattr(customer, key, value)
            db.commit()
            db.refresh(customer)
        except Exception:
            db.rollback()
            raise VoiceOperationError("The customer update could not be saved.", 500)
        return {
            "ok": True,
            "message": f"Customer {customer.name} was updated.",
            "result": {"customer_id": customer.id, "changes": changes},
        }

    if action == "create_order":
        draft = payload["draft"]
        customer = db.query(m.Customer).filter(m.Customer.id == draft["customer_id"]).first()
        product = db.query(m.Product).filter(m.Product.id == draft["product_id"], m.Product.active.is_(True)).first()
        if not customer or not product:
            raise VoiceOperationError("The selected customer or product is no longer available. Prepare the order again.", 409)
        fields = _template_fields(product, db)
        missing = _required_missing(fields, draft.get("measurements", {}))
        if missing:
            raise VoiceOperationError("Missing measurements: " + ", ".join(missing) + ".", 409)
        total = float(draft.get("total_amount") or 0)
        paid = float(draft.get("paid_amount") or 0)
        if total <= 0 or paid < 0 or paid > total:
            raise VoiceOperationError("The order amount or payment is invalid. Prepare the order again.", 409)
        request = m.OrderCreate(
            customer_id=customer.id,
            product_id=product.id,
            order_date=draft["order_date"],
            delivery_date=draft.get("delivery_date", ""),
            description=draft.get("description", ""),
            embroidery_category=None,
            stitch_count=0,
            rate_per_stitch=0,
            base_amount=round(total - float(draft.get("extra_amount") or 0), 2),
            extra_amount=round(float(draft.get("extra_amount") or 0), 2),
            total_amount=round(total, 2),
            paid_amount=round(paid, 2),
            measurements=[
                m.MeasurementItem(field_name=name, value=value)
                for name, value in draft.get("measurements", {}).items()
            ],
            idempotency_key=f"voice:{pending.confirmation_id}",
        )
        result = _call_business(m, m.create_order, request, db, admin)
        verified = _verify_order(db, result["id"])
        return {
            "ok": True,
            "message": (
                f"Order {verified['invoice_number']} was created successfully. "
                f"Total Rs. {verified['total_amount']:,.2f}, paid Rs. {verified['paid_amount']:,.2f}, "
                f"balance Rs. {verified['balance']:,.2f}, delivery {verified['delivery_date']}."
            ),
            "result": {"order_id": verified["id"], "invoice_number": verified["invoice_number"],
                       "total_amount": verified["total_amount"], "paid_amount": verified["paid_amount"],
                       "balance": verified["balance"]},
        }

    if action == "record_payment":
        result = _call_business(
            m,
            m.collect_balance,
            payload["order_id"],
            m.PaymentUpdate(
                additional_paid=payload["amount"],
                idempotency_key=f"voice:{pending.confirmation_id}",
            ),
            db,
            admin,
        )
        verified = _verify_order(db, payload["order_id"])
        return {
            "ok": True,
            "message": (
                f"Payment recorded successfully. {verified['invoice_number']} balance is now "
                f"Rs. {verified['balance']:,.2f}."
            ),
            "result": {"order_id": verified["id"], "balance": verified["balance"],
                       "paid_amount": verified["paid_amount"], "status": verified["status"]},
        }

    if action == "update_measurements":
        order = db.query(m.Order).filter(m.Order.id == payload["order_id"]).with_for_update().first()
        if not order:
            raise VoiceOperationError("The order is no longer available. Prepare the change again.", 409)
        product = db.query(m.Product).filter(m.Product.id == order.product_id).first()
        fields = _template_fields(product, db)
        canonical, unresolved, invalid = _canonical_measurements(fields, payload["measurements"])
        if invalid or unresolved:
            raise VoiceOperationError("The measurements are no longer valid. Prepare the change again.", 409)
        try:
            existing = {
                row.field_name.casefold(): row
                for row in db.query(m.OrderMeasurement).filter(m.OrderMeasurement.order_id == order.id).all()
            }
            for field, value in canonical.items():
                row = existing.get(field.casefold())
                if row:
                    row.value = value
                else:
                    db.add(m.OrderMeasurement(order_id=order.id, field_name=field, value=value))
            db.commit()
        except Exception:
            db.rollback()
            raise VoiceOperationError("The measurements could not be saved.", 500)
        verified = _verify_order(db, order.id)
        return {
            "ok": True,
            "message": f"Measurements for {verified['invoice_number']} were updated: " + ", ".join(
                f"{item['field_name']} {item['value']}" for item in verified["measurements"]
                if item["field_name"] in canonical
            ) + ".",
            "result": {"order_id": verified["id"], "measurements": verified["measurements"]},
        }

    if action in {"update_delivery_date", "update_order_status", "update_order"}:
        order = db.query(m.Order).filter(m.Order.id == payload["order_id"]).with_for_update().first()
        if not order:
            raise VoiceOperationError("The order is no longer available. Prepare the change again.", 409)
        changes = payload.get("changes") or {}
        if action == "update_delivery_date":
            changes = {"delivery_date": payload["delivery_date"]}
        elif action == "update_order_status":
            changes = {"status": payload["status"]}
        if changes.get("status") == "Paid" and order.balance > 0:
            raise VoiceOperationError(f"{order.invoice_number} still has Rs. {order.balance:,.2f} outstanding.", 409)
        try:
            for key, value in changes.items():
                setattr(order, key, value)
            db.commit()
            db.refresh(order)
        except Exception:
            db.rollback()
            raise VoiceOperationError("The order update could not be saved.", 500)
        verified = _verify_order(db, order.id)
        return {
            "ok": True,
            "message": f"{verified['invoice_number']} was updated: " + ", ".join(
                f"{key.replace('_', ' ')} {value}" for key, value in changes.items()
            ) + ".",
            "result": {"order_id": verified["id"], "changes": changes},
        }

    raise VoiceOperationError("This operation is not supported.", 400)


# ---------------------------------------------------------------------------
# Tool registry
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    model: type[BaseModel]
    handler: Callable[..., dict[str, Any]]
    read_only: bool


TOOL_SPECS: list[ToolSpec] = [
    ToolSpec(
        "get_business_summary",
        "Get live totals for a period: order value, money collected, outstanding balance, order counts, and customer count.",
        PeriodArgs, get_business_summary, True,
    ),
    ToolSpec(
        "get_sales_summary",
        "Get sales order value, money collected, and average order value for a period. Order value is not money collected.",
        PeriodArgs, get_sales_summary, True,
    ),
    ToolSpec(
        "get_order_counts",
        "Count orders for a period, including pending, paid, overdue, due today, and due tomorrow.",
        PeriodArgs, get_order_counts, True,
    ),
    ToolSpec(
        "list_orders",
        "List orders by filter: pending, overdue, due_today, due_tomorrow, completed, completed_today, recent, this_week, or this_month.",
        OrderListArgs, list_orders, True,
    ),
    ToolSpec(
        "search_customers",
        "Search registered customers by name or phone number.",
        SearchArgs, search_customers, True,
    ),
    ToolSpec(
        "get_customer_details",
        "Get one customer's details, recent orders, and latest measurements.",
        CustomerDetailsArgs, get_customer_details, True,
    ),
    ToolSpec(
        "get_customer_order_history",
        "List a customer's order history.",
        CustomerDetailsArgs, get_customer_order_history, True,
    ),
    ToolSpec(
        "search_orders",
        "Search orders by invoice number, customer name, or phone number.",
        SearchArgs, search_orders, True,
    ),
    ToolSpec(
        "get_order_details",
        "Get one order by order number or invoice number.",
        OrderDetailsArgs, get_order_details, True,
    ),
    ToolSpec(
        "get_outstanding_payments",
        "List orders with an outstanding balance and the total amount due.",
        OrderListArgs, get_outstanding_payments, True,
    ),
    ToolSpec(
        "get_payment_history",
        "List successful income/payment transactions for a period.",
        PeriodArgs, get_payment_history, True,
    ),
    ToolSpec(
        "list_products",
        "List active products with pricing type and required measurement fields.",
        ProductArgs, list_products, True,
    ),
    ToolSpec(
        "get_measurement_template",
        "Get the required measurement fields for a product.",
        ProductArgs, get_measurement_template, True,
    ),
    ToolSpec(
        "prepare_customer_creation",
        "Prepare a new customer for confirmation. Does not save until the administrator confirms.",
        CustomerCreateArgs, prepare_customer_creation, False,
    ),
    ToolSpec(
        "prepare_customer_update",
        "Prepare changes to an existing customer for confirmation.",
        CustomerUpdateArgs, prepare_customer_update, False,
    ),
    ToolSpec(
        "prepare_order_creation",
        "Prepare an order for an existing customer and product. Measurements must include inches or centimetres. Returns missing fields until the draft is complete.",
        OrderCreateArgs, prepare_order_creation, False,
    ),
    ToolSpec(
        "prepare_measurement_update",
        "Prepare corrected measurements for an existing order.",
        MeasurementUpdateArgs, prepare_measurement_update, False,
    ),
    ToolSpec(
        "prepare_payment_recording",
        "Prepare a payment against an order's outstanding balance.",
        PaymentArgs, prepare_payment_recording, False,
    ),
    ToolSpec(
        "prepare_delivery_date_update",
        "Prepare a delivery date change for an order.",
        DeliveryArgs, prepare_delivery_date_update, False,
    ),
    ToolSpec(
        "prepare_order_status_update",
        "Prepare an order status change: Pending, Partially Paid, Paid, Ready, or Delivered.",
        StatusArgs, prepare_order_status_update, False,
    ),
    ToolSpec(
        "prepare_order_update",
        "Prepare a combined delivery date, status, or description change for an order.",
        OrderUpdateArgs, prepare_order_update, False,
    ),
    ToolSpec(
        "prepare_invoice_generation",
        "Open the existing in-memory invoice viewer for an order. The PDF is not stored permanently.",
        InvoiceArgs, prepare_invoice_generation, False,
    ),
]

TOOLS: dict[str, ToolSpec] = {spec.name: spec for spec in TOOL_SPECS}


def tool_definitions() -> list[dict[str, Any]]:
    definitions = []
    for spec in TOOL_SPECS:
        schema = spec.model.model_json_schema()
        schema.pop("title", None)
        definitions.append({
            "type": "function",
            "function": {
                "name": spec.name,
                "description": spec.description,
                "parameters": schema,
            },
        })
    return definitions


def execute_tool(name: str, arguments: dict[str, Any], db, conversation: VoiceConversation) -> dict[str, Any]:
    spec = TOOLS.get(name)
    if not spec:
        return _error("Unknown tool. Only the provided tools may be used.")
    try:
        parsed = spec.model(**(arguments or {}))
    except ValidationError as exc:
        return _error("Invalid tool arguments.", details=json.loads(exc.json())[:5])
    try:
        return spec.handler(parsed, db, conversation)
    except VoiceOperationError as exc:
        return _error(str(exc), status_code=exc.status_code)
    except Exception:
        # Never leak database/provider exceptions to the model or browser.
        return _error("The business operation could not be completed. No change was reported as successful.")
