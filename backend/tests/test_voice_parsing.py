"""Unit tests for language-tolerant voice parsing (no network or model needed)."""

from datetime import date, timedelta

import voice_parsing
from voice_parsing import (
    measurement_warning,
    parse_date,
    parse_measurements,
    parse_money,
    parse_money_with_label,
    parse_number,
    parse_phone,
    parse_quantity,
)
from voice_state import VoiceConversation


def test_parse_number_supports_digits_english_and_tanglish_words() -> None:
    assert parse_number("36") == 36
    assert parse_number("thirty six") == 36
    assert parse_number("irupathu anju") == 25
    assert parse_number("aayiram") == 1000
    assert parse_number("no number here") is None


def test_parse_quantity_never_invents_a_unit() -> None:
    assert parse_quantity("36 inches") == (36, "in")
    assert parse_quantity("90 cm") == (90, "cm")
    assert parse_quantity("செ.மீ 90") == (90, "cm")
    assert parse_quantity("36") == (36, None)


def test_parse_measurements_matches_fields_and_flags_missing_values() -> None:
    parsed = parse_measurements("bust 36 waist 30 in", ["Bust", "Waist"])
    by_field = {item["field"]: item for item in parsed}
    assert by_field["Bust"]["value"] == "36"
    assert by_field["Bust"]["unit"] == "in"
    assert by_field["Waist"]["value"] == "30"
    assert by_field["Waist"]["unit"] == "in"

    target = parse_measurements("36", ["Bust"], target_field="Bust")
    assert target == [
        {"field": "Bust", "value": "36", "unit": None, "raw": "36"},
    ]

    missing_value = parse_measurements("bust", ["Bust"])
    assert missing_value[0]["value"] is None


def test_measurement_warning_does_not_silently_accept_impossible_values() -> None:
    assert measurement_warning("Bust", "36", "in") is None
    assert measurement_warning("Bust", "0", "in") is not None
    assert measurement_warning("Bust", "150", "in") is not None
    assert measurement_warning("Bust", "136", "cm") is None


def test_money_parsing_distinguishes_labelled_amounts() -> None:
    assert parse_money("Rs. 1,250.50") == 1250.5
    assert parse_money("₹500") == 500
    assert parse_money("500 rupees") == 500
    assert parse_money("total 500") is None
    assert parse_money_with_label("advance 300") == ("advance", 300.0)
    assert parse_money_with_label("total rs 1,200") == ("total", 1200.0)
    assert parse_money("மொத்தம் 750") == 750
    assert parse_money_with_label("முன்பணம் 200") == ("advance", 200.0)


def test_parse_date_accepts_iso_spoken_dates_and_relative_words(monkeypatch) -> None:
    # Pin "today" so the assertions do not drift as the wall clock passes the
    # reference date (the unqualified month/day form rolls into next year once
    # that date is in the past).
    fixed_today = date(2026, 11, 5)
    monkeypatch.setattr(voice_parsing, "business_today", lambda: fixed_today)
    assert parse_date("2026-11-05") == "2026-11-05"
    assert parse_date("5 November") == "2026-11-05"
    assert parse_date("5/11/2026") == "2026-11-05"
    assert parse_date("tomorrow") == (fixed_today + timedelta(days=1)).isoformat()
    assert parse_date("நாளை") == (fixed_today + timedelta(days=1)).isoformat()
    assert parse_date("not a date") is None


def test_tamil_whisper_read_only_variants_are_not_rewritten_before_parsing(monkeypatch) -> None:
    # This covers observed STT variants while keeping the original transcript intact.
    import voice_agent
    monkeypatch.setattr(voice_agent, "_call_read", lambda tool, args, db, conversation: voice_agent.AgentReply(reply=f"tool:{tool}:{args['period']}"))
    conversation = VoiceConversation(session_id="s", admin_id=1, auth_session_id="a")
    for transcript in (
        "இன்னுக்கு விர்ப்பனை எவ்வளவு",
        "இன்னுக்கு சேல்ஸ் எவ்வளவு",
        "இன்று விருப்பனையே எவ்வளவு",
    ):
        reply = voice_agent._deterministic_turn(None, conversation, transcript)
        assert reply.reply.startswith("tool:get_sales_summary:today")


def test_parse_phone_normalizes_country_code_and_rejects_short_numbers() -> None:
    assert parse_phone("+91 98765 43210") == "9876543210"
    assert parse_phone("9876543210") == "9876543210"
    assert parse_phone("12345") is None
