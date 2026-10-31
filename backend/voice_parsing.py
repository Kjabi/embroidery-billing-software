"""Language-tolerant parsing for spoken Tamil, English, and Tanglish commands.

These helpers produce structured values only.  They never execute an action and
they flag missing units instead of guessing.
"""
from __future__ import annotations

import re
from datetime import date, timedelta

from business_time import business_today

_UNIT_WORDS: dict[str, int] = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19,
    # Common Tamil/Tanglish number words.
    "onnu": 1, "ondru": 1, "rendu": 2, "irandu": 2, "moonu": 3, "muunu": 3,
    "naalu": 4, "anju": 5, "aindhu": 5, "aaru": 6, "ezhu": 7, "elu": 7,
    "ettu": 8, "onbadhu": 9, "ombadhu": 9, "pathu": 10, "pattu": 10,
    "padhinondru": 11, "pannendu": 12, "padhimoonu": 13, "padhinaalu": 14,
    "padhinanju": 15, "padhinaaru": 16, "padhinezhu": 17, "padhinettu": 18,
    "padhithonbadhu": 19,
}
_TENS_WORDS: dict[str, int] = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
    "iruvadhu": 20, "irupadhu": 20, "irupathu": 20,
    "muppadhu": 30, "muppathi": 30, "muppathu": 30,
    "naarpadhu": 40, "narpadhu": 40, "narpathu": 40,
    "ambadhu": 50, "aimbadhu": 50, "aimpathu": 50,
    "aruvadhu": 60, "arupathu": 60, "ezhuvadhu": 70, "ezhupathu": 70,
    "enbadhu": 80, "enpathu": 80, "thonooru": 90, "thonnooru": 90,
}
_SCALE_WORDS: dict[str, int] = {"hundred": 100, "nooru": 100, "thousand": 1000, "aayiram": 1000}
_NUMBER_WORDS = {**_UNIT_WORDS, **_TENS_WORDS, **_SCALE_WORDS}

# Python's ``\b`` does not work reliably at the end of Tamil words because the
# final vowel sign is a combining mark. Keep Tamil alternatives outside the
# English word-boundary group.
_UNIT_PATTERNS = (
    ("in", re.compile(r"\b(?:inches|inch|in)\b|இஞ்ச்", re.I)),
    ("cm", re.compile(r"\b(?:centimet(?:er|re)s?|cms?)\b|செ\.?\s*மீ|செமீ", re.I)),
)

_FIELD_ALIASES: dict[str, list[str]] = {
    "bust": ["bust", "chest"],
    "chest": ["chest", "bust"],
    "waist": ["waist"],
    "shoulder": ["shoulder"],
    "armhole": ["armhole", "arm hole"],
    "sleeve length": ["sleeve length", "sleeve"],
    "blouse length": ["blouse length", "blouse"],
    "front neck": ["front neck"],
    "back neck": ["back neck"],
    "neck depth": ["neck depth"],
    "sleeve opening": ["sleeve opening"],
    "hip": ["hip"],
    "top length": ["top length", "top"],
    "pant length": ["pant length", "pant"],
    "bottom": ["bottom", "bottom opening"],
    "skirt length": ["skirt length", "skirt"],
    "flare": ["flare"],
    "waist to floor": ["waist to floor"],
    "frock length": ["frock length"],
    "length": ["length"],
}


def normalize(text: str) -> str:
    return " ".join((text or "").casefold().replace("₹", " rs ").split())


def _tokens(text: str) -> list[str]:
    return re.findall(r"[a-z]+|\d+(?:\.\d+)?", text)


def _words_to_number(part: str) -> float | None:
    words = [token for token in _tokens(part) if token in _NUMBER_WORDS or token in {"and", "point", "a", "half"}]
    if not words:
        return None
    if "point" in words or "half" in words:
        if "point" in words:
            index = words.index("point")
            whole_words, decimal_words = words[:index], words[index + 1:]
            whole = _words_to_number(" ".join(whole_words))
            decimal_digits = "".join(str(_UNIT_WORDS.get(word, word)) for word in decimal_words if _UNIT_WORDS.get(word, word) != word)
            if whole is None or not decimal_digits:
                return None
            return float(f"{int(whole)}.{decimal_digits}")
        if "half" in words:
            index = words.index("half")
            whole = _words_to_number(" ".join(words[:index]))
            return (whole or 0) + 0.5
    total = 0
    current = 0
    for word in words:
        if word in {"and", "a"}:
            continue
        if word in _SCALE_WORDS:
            current = max(current, 1) * _SCALE_WORDS[word]
        elif word in _TENS_WORDS or word in _UNIT_WORDS:
            current += _NUMBER_WORDS[word]
        else:
            return None
    return total + current


def parse_number(text: str) -> float | int | None:
    """Parse digits, English number words, or common Tamil number words."""
    value = (text or "").replace(",", " ").strip()
    digits = re.search(r"\d+(?:\.\d+)?", value)
    if digits:
        number = float(digits.group(0))
        return int(number) if number.is_integer() else number
    words = _tokens(value)
    # Find the longest contiguous run of number words so "chest thirty six" works.
    best: tuple[int, int] | None = None
    start = None
    for index, word in enumerate(words + ["__end__"]):
        if word in _NUMBER_WORDS or word in {"and", "point", "half", "a"}:
            if start is None:
                start = index
        elif start is not None:
            if best is None or index - start > best[1] - best[0]:
                best = (start, index)
            start = None
    if not best:
        return None
    parsed = _words_to_number(" ".join(words[best[0]:best[1]]))
    if parsed is None:
        return None
    return int(parsed) if float(parsed).is_integer() else parsed


def detect_unit(text: str) -> str | None:
    for unit, pattern in _UNIT_PATTERNS:
        if pattern.search(text or ""):
            return unit
    return None


def parse_quantity(text: str) -> tuple[float | int, str | None] | None:
    unit = detect_unit(text)
    cleaned = text or ""
    for _unit, pattern in _UNIT_PATTERNS:
        cleaned = pattern.sub(" ", cleaned)
    number = parse_number(cleaned)
    if number is None:
        return None
    return number, unit


def _alias_map(fields: list[str]) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for field in fields:
        key = field.casefold().strip()
        aliases = _FIELD_ALIASES.get(key, [key])
        if key not in aliases:
            aliases = [key, *aliases]
        for alias in aliases:
            pairs.append((alias, field))
    return sorted(pairs, key=lambda item: len(item[0]), reverse=True)


def parse_measurements(
    text: str,
    fields: list[str],
    target_field: str | None = None,
) -> list[dict[str, object]]:
    """Extract one or more measurement values without inventing a unit."""
    value = normalize(text)
    results: list[dict[str, object]] = []
    consumed: list[tuple[int, int]] = []
    found_fields: set[str] = set()

    def overlaps(start: int, end: int) -> bool:
        return any(start < used_end and end > used_start for used_start, used_end in consumed)

    for alias, field in _alias_map(fields):
        if field in found_fields:
            continue
        pattern = re.compile(rf"\b{re.escape(alias)}\b", re.I)
        for match in pattern.finditer(value):
            if overlaps(match.start(), match.end()):
                continue
            after = value[match.end(): match.end() + 48]
            before = value[max(0, match.start() - 28): match.start()]
            quantity = parse_quantity(after) or parse_quantity(before)
            consumed.append((match.start(), match.end()))
            found_fields.add(field)
            if quantity is None:
                results.append({"field": field, "value": None, "unit": None, "raw": value})
            else:
                number, unit = quantity
                results.append({
                    "field": field,
                    "value": str(int(number)) if float(number).is_integer() else str(number),
                    "unit": unit,
                    "raw": value,
                })
            break

    if target_field and not results:
        quantity = parse_quantity(value)
        if quantity is not None:
            number, unit = quantity
            results.append({
                "field": target_field,
                "value": str(int(number)) if float(number).is_integer() else str(number),
                "unit": unit,
                "raw": value,
            })
    return results


def measurement_warning(field: str, value: str, unit: str | None) -> str | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return f"{field} is not a number."
    if number <= 0:
        return f"{field} must be greater than zero."
    if number > 300:
        return f"{field} looks unusually large."
    if unit == "in" and number > 100:
        return f"{field} looks large for inches; please confirm the unit."
    if unit == "cm" and number > 250:
        return f"{field} looks large for centimetres; please confirm the unit."
    return None


def parse_money(text: str) -> float | None:
    value = normalize(text)
    patterns = (
        r"(?:rs\.?|rupees?|ரூபாய்|ரூ)\s*([\d,]+(?:\.\d+)?)",
        r"([\d,]+(?:\.\d+)?)\s*(?:rs\.?|rupees?|ரூபாய்|ரூ)",
    )
    for pattern in patterns:
        match = re.search(pattern, value, re.I)
        if match:
            return float(match.group(1).replace(",", ""))
    if re.search(r"(?:rs\.?|rupees?)", value) or any(
        word in value for word in ("ரூபாய்", "மொத்தம்", "முன்பணம்", "பணம்")
    ):
        number = parse_number(value)
        return float(number) if number is not None else None
    return None


def _has_label(value: str, word: str) -> bool:
    if word.isascii():
        return bool(re.search(rf"\b{word}\b", value))
    return word in value


def parse_money_with_label(text: str) -> tuple[str, float] | None:
    value = normalize(text)
    label_groups = (
        ("advance", ("advance", "முன்பணம்")),
        ("extra", ("extra",)),
        ("paid", ("paid", "payment", "பணம்")),
        ("total", ("total", "amount", "மொத்தம்")),
    )
    label = next(
        (
            candidate
            for candidate, words in label_groups
            if any(_has_label(value, word) for word in words)
        ),
        None,
    )
    amount = parse_money(value)
    if amount is None:
        # A bare number is accepted only when a label or a pending field exists.
        stripped = re.sub(r"\b(?:rs\.?|rupees?)\b", " ", value).strip(" .")
        if label or re.fullmatch(r"[\d\s.,]+", stripped):
            number = parse_number(stripped)
            amount = float(number) if number is not None else None
    if amount is None:
        return None
    return (label or "total"), amount


_WEEKDAYS = {
    "monday": 0, "mon": 0, "thingal": 0,
    "tuesday": 1, "tue": 1, "sevvaai": 1,
    "wednesday": 2, "wed": 2, "budhan": 2,
    "thursday": 3, "thu": 3, "vyazhan": 3,
    "friday": 4, "fri": 4, "velli": 4,
    "saturday": 5, "sat": 5, "sani": 5,
    "sunday": 6, "sun": 6, "gnayiru": 6,
}
_MONTHS = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
    "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
    "august": 8, "aug": 8, "september": 9, "sep": 9, "sept": 9,
    "october": 10, "oct": 10, "november": 11, "nov": 11, "december": 12, "dec": 12,
}


def parse_date(text: str) -> str | None:
    """Parse a spoken/typed delivery date; returns an ISO date or None."""
    value = normalize(text)
    today = business_today()

    iso = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", value)
    if iso:
        try:
            return date(int(iso.group(1)), int(iso.group(2)), int(iso.group(3))).isoformat()
        except ValueError:
            return None

    numeric = re.search(r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b", value)
    if numeric:
        day, month, year = int(numeric.group(1)), int(numeric.group(2)), int(numeric.group(3))
        if year < 100:
            year += 2000
        try:
            return date(year, month, day).isoformat()
        except ValueError:
            return None

    if "day after tomorrow" in value or "naalai kku appuram" in value:
        return (today + timedelta(days=2)).isoformat()
    if "tomorrow" in value or "naalai" in value or "நாளை" in value or "நாளைக்கு" in value:
        return (today + timedelta(days=1)).isoformat()
    if "today" in value or "innaiku" in value or "innikku" in value or "indru" in value or "இன்று" in value:
        return today.isoformat()
    if "next week" in value:
        return (today + timedelta(days=7)).isoformat()

    weekday_match = re.search(r"\b(" + "|".join(_WEEKDAYS) + r")\b", value)
    if weekday_match:
        target = _WEEKDAYS[weekday_match.group(1)]
        delta = (target - today.weekday()) % 7
        if delta == 0:
            delta = 7
        return (today + timedelta(days=delta)).isoformat()

    month_match = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(" + "|".join(_MONTHS) + r")\b", value)
    if not month_match:
        month_match = re.search(r"\b(" + "|".join(_MONTHS) + r")\s+(\d{1,2})(?:st|nd|rd|th)?\b", value)
        if month_match:
            month_text, day_text = month_match.group(1), month_match.group(2)
        else:
            month_text = day_text = None
    else:
        day_text, month_text = month_match.group(1), month_match.group(2)
    if month_text and day_text:
        month = _MONTHS[month_text]
        day = int(day_text)
        year = today.year
        try:
            candidate = date(year, month, day)
            if candidate < today:
                candidate = date(year + 1, month, day)
            return candidate.isoformat()
        except ValueError:
            return None
    return None


def parse_phone(text: str) -> str | None:
    digits = re.sub(r"\D", "", text or "")
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    if 10 <= len(digits) <= 15:
        return digits
    return None


def contains_any(text: str, words: tuple[str, ...] | list[str]) -> bool:
    value = normalize(text)
    return any(word.casefold() in value for word in words)
