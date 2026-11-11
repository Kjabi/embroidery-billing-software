# Intent Understanding Report

**Date:** 2026-11-07
**Scope:** typed English / Tamil / Tanglish read-only intent routing and the customer-creation intent triggers
**Environment:** isolated perf backend `127.0.0.1:8010` on PostgreSQL `perf_20261107`
**Provider:** deterministic parser (`VOICE_STT_PROVIDER=disabled`); no paid LLM was used
**Production data touched:** none
**Status:** **PASS — 91/91 live queries routed correctly** after two Tamil precedence fixes.

## 1. What was tested

A 91-query live matrix was sent to `POST /api/voice/turn` with a fresh voice session per query.
The observed result was classified from the returned tool `data` shape (for example
`query_plan.intent == sales_summary`, `total_outstanding`, `payments`, `by_status`,
`filter == pending`, `customers`, `customer`, `order`, `products`, help).

| Category | Queries | Passed |
|---|---|---|
| Today's / yesterday's / this month's sales (Tamil, Tanglish, English, mixed) | 50 | 50 |
| Money collected / payments received | 6 | 6 |
| Outstanding / balance due | 6 | 6 |
| Pending / unpaid / open orders (incl. Tamil) | 6 | 6 |
| Business summary / report / dashboard | 4 | 4 |
| Order counts | 4 | 4 |
| Customer search | 4 | 4 |
| Customer details | 3 | 3 |
| Customer order history | 2 | 2 |
| Invoice / order details | 2 | 2 |
| Product / work-type list | 2 | 2 |
| Help | 2 | 2 |
| **Total** | **91** | **91** |

The 50 sales queries are the same multilingual set exercised by the automated suite
(`backend/tests/test_voice_intents.py`), now confirmed against a real database response rather
than a mocked tool.

## 2. Defects found and fixed

The first live run scored **89/91**. Two genuine Tamil routing defects were found:

| Query | Expected | Observed | Cause |
|---|---|---|---|
| `நிலுவை ஆர்டர் காட்டு` ("show pending orders") | pending orders | outstanding payments | the broad `நிலுவை` outstanding rule ran first |
| `பாக்கி ஆர்டர் எத்தனை?` ("how many pending orders?") | pending orders | total order count | `ஆர்டர் எத்தனை` order-count rule ran first |

Fix applied in `backend/voice_agent.py`: the pending-order rule now runs before the broad
order-count and outstanding rules, with a comment explaining why. English pending-order phrases
were unaffected.

Regression coverage added in `backend/tests/test_voice_intents.py`
(`test_pending_order_questions_select_pending_list`, 6 cases). The full backend suite is now
**150 passed**. The live matrix was re-run after the fix and scored **91/91**.

## 3. Customer-creation intent coverage

The customer-creation branch was verified separately by the automated suite (87 focused voice
tests at the time of the customer-creation work) and by a typed UI end-to-end test that saved
`Meena / 9876509999 / Madurai` through preview + exact confirmation + DB read-back.

| Trigger family | Examples | Status |
|---|---|---|
| English | "create a new customer", "add customer" | PASS |
| Tamil | "புதிய கஸ்டமர் சேர்க்க வேண்டும்" | PASS |
| Tanglish | "new customer add pannu" | PASS |
| Transliterated Tamil name | Whisper-style spelling retained | PASS |
| Bare phone/name answers during collection | field retention and validation | PASS |
| Duplicate phone | detected before save | PASS |
| Preview + exact confirmation | save only on exact phrase or Confirm | PASS |
| Cancellation | no row written | PASS |

## 4. What this report does **not** prove

- **Speech, not text.** These are typed transcripts. Microphone → STT → intent is covered by
  `VOICE_ACCEPTANCE_REPORT.md` and is **NOT TESTED** physically.
- **Deterministic provider only.** The optional LLM provider (`VOICE_LLM_PROVIDER`) was not
  exercised; it is disabled by default and would require a paid/free external API decision.
- **Tamil speech digit accuracy.** Spoken Tamil digits remain unreliable per
  `SPEECH_MODEL_BENCHMARK_REPORT.md`; typed fallback and preview confirmation stay mandatory.
- **Writes beyond the tested customer flow.** Order creation by voice was not the focus of this
  matrix; the automated suite covers it, but no live audio was used.
- **Ambiguous paraphrases.** The deterministic parser is rule-based; unusual phrasings outside
  the dataset may still miss. Unknown text falls back to help/clarification rather than inventing
  an answer.

## 5. Verdict

**Intent understanding (typed, multilingual, read-only): PASS (91/91 live).**
**Customer-creation intent (typed/API): PASS.**
**Spoken-intent acceptance: NOT TESTED** (requires a physical microphone).
