"""Single source of truth for the shop's business timezone and date ranges.

The application stores dates as ISO ``YYYY-MM-DD`` strings.  Reports must use
the shop's local calendar day (Asia/Kolkata) rather than the server's UTC day,
especially when the backend runs on a serverless host.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

try:  # pragma: no cover - zoneinfo is available on supported Python builds
    from zoneinfo import ZoneInfo

    BUSINESS_TZ = ZoneInfo("Asia/Kolkata")
except Exception:  # pragma: no cover - fallback for stripped-down runtimes
    BUSINESS_TZ = timezone(timedelta(hours=5, minutes=30))


def business_now() -> datetime:
    return datetime.now(BUSINESS_TZ)


def business_today() -> date:
    return business_now().date()


def period_bounds(period: str | None) -> tuple[str | None, str | None]:
    """Return inclusive ISO date bounds for a named reporting period."""
    key = (period or "today").strip().lower().replace("-", "_").replace(" ", "_")
    today = business_today()
    if key in {"all", "all_time", "everything"}:
        return None, None
    if key == "today":
        return today.isoformat(), today.isoformat()
    if key == "yesterday":
        value = today - timedelta(days=1)
        return value.isoformat(), value.isoformat()
    if key == "tomorrow":
        value = today + timedelta(days=1)
        return value.isoformat(), value.isoformat()
    if key == "this_week":
        start = today - timedelta(days=today.weekday())
        return start.isoformat(), today.isoformat()
    if key in {"last_7_days", "past_7_days", "seven_days"}:
        return (today - timedelta(days=6)).isoformat(), today.isoformat()
    if key in {"last_30_days", "past_30_days", "thirty_days"}:
        return (today - timedelta(days=29)).isoformat(), today.isoformat()
    if key == "this_month":
        return today.replace(day=1).isoformat(), today.isoformat()
    if key == "last_month":
        last_day = today.replace(day=1) - timedelta(days=1)
        return last_day.replace(day=1).isoformat(), last_day.isoformat()
    if key == "this_year":
        return today.replace(month=1, day=1).isoformat(), today.isoformat()
    # Unknown periods fail closed to today instead of silently reporting everything.
    return today.isoformat(), today.isoformat()
