# Voice Acceptance Report

**Date:** 2026-11-07
**Scope:** customer-creation voice workflow end to end, plus the assistant's typed/multilingual behaviour and microphone failure handling
**Environments:** isolated SQLite (`TestClient` and a throwaway UI database), isolated PostgreSQL perf copy, in-app browser against a local dev server
**Production data touched:** none
**Status:** typed / API / duplicate / confirmation / read-back / cancellation / mic-denial **PASS**;
**physical microphone acceptance NOT TESTED.**

> The honest headline: the workflow is verified with typed transcripts and with an automated
> browser whose microphone permission is denied. It has **not** been verified with a real person
> speaking into a real microphone. Do not mark the voice feature production-ready until §7 is
> completed.

## 1. What the workflow must do

A customer-creation request must:

1. recognise English, Tamil, Tanglish and transliterated Tamil trigger phrases,
2. collect the **live** `CustomerCreate` required fields (name, phone) and optional fields,
3. retain state across turns and not hijack unrelated later questions,
4. validate input and keep previously collected fields on an invalid answer,
5. detect an existing customer (duplicate phone) before saving,
6. show a preview with the actual values,
7. require the **exact** confirmation phrase (a bare "yes" is rejected) or the Confirm button,
8. save through the authenticated function (not a side channel),
9. read the record back from the database,
10. return the actual saved details (id, name, phone), and
11. write nothing on cancel.

## 2. Automated backend coverage

Full backend suite: **150 passed** in ≈16 s (isolated SQLite, no production access).

| File | Tests | Focus |
|---|---|---|
| `backend/tests/test_voice_intents.py` | 93 | intent routing, 50 multilingual sales questions, collections, pending orders, customer creation |
| `backend/tests/test_voice_parsing.py` | 8 | Tamil/Tanglish normalisation, amounts, digits |
| `backend/tests/test_voice_providers.py` | 7 | provider selection / disabled fallback / parsing helpers |
| `backend/tests/test_security_and_orders.py` | 16 | auth, confirmation phrases, order/payment/delivery workflows |
| `backend/tests/test_release_hardening.py` | 26 | abuse, cascade delete, update validation, idempotency |
| **Total** | **150** | |

Customer-specific tests include:

- `test_customer_creation_request_starts_conversational_workflow`
- `test_customer_creation_collects_fields_and_prepares_preview`
- `test_customer_creation_voice_flow_saves_and_verifies_record`
- `test_tanglish_and_tamil_customer_flow_saves_and_verifies`
- `test_customer_creation_trigger_supports_english_tamil_and_tanglish` (parametrised)
- `test_customer_creation_keeps_collected_fields_and_accepts_tamil_answers`
- `test_customer_creation_accepts_whisper_transliterated_tamil_name`
- `test_customer_creation_rejects_invalid_phone_and_keeps_previous_fields`
- `test_customer_creation_uses_live_validation_model_required_fields`

The save test asserts all of the following in one flow: `action == "create_customer"`, preview values,
`data.verified is True`, the reply contains the saved phone **and** `CUST-`, `task is None` after
completion, the customer is returned by `GET /api/customers?q=…`, and a repeat request reports
*"already exists"* with **no** pending operation.

## 3. Frontend automated coverage

`npm test` → **19 passed, 0 failed** (Node test runner).

Relevant cases:

- `NativeSpeechSession ends cleanly when the microphone is denied`
- `speechCapabilities fails closed outside a browser`
- `Tamil and Tanglish select the multilingual small model`
- `speechLanguage chooses Tamil for Tamil script`
- `canUseMicrophone detects browser support`
- `confirmation phrases match the server-side phrase format`
- `buildDraftPatch trims, filters empty measurements, and validates amounts`
- `parseApiError handles FastAPI detail shapes`

## 4. Typed UI end-to-end (executed)

Environment: local backend + Vite dev server, throwaway SQLite database, in-app browser.

| Step | Input | Observed | Result |
|---|---|---|---|
| Trigger | typed "add a new customer" | assistant asks for the name; no write | PASS |
| Name | typed `Meena` | field retained | PASS |
| Phone | typed `9876509999` | preview shown, nothing saved | PASS |
| City | typed `Madurai` | preview updated | PASS |
| Confirmation | exact phrase / Confirm | saved | PASS |
| Read-back | customer list + direct SQLite query | row `id=3, name=Meena, phone=9876509999, city=Madurai` | PASS |
| Reply | assistant response | reports the real saved details, not a generic "done" | PASS |
| Cancellation | start a new customer, then cancel | **no** extra row; database still has 3 customers | PASS |
| Unrelated turn after save | "What are today's sales?" | answered as a sales query, not captured by the customer flow | PASS |

Artifact: `/private/var/folders/.../opencode/mic-acceptance/data/embroidery.db` contains exactly
three customers; the third is the saved `Meena / 9876509999 / Madurai`. The cancellation run left
the same three rows.

A second artifact from an earlier run
(`/private/var/folders/.../opencode/voice-cust-e2e3/data/embroidery.db`) also shows exactly three
customers, confirming cancellation did not append a row.

## 5. Confirmation and duplicate safety

| Case | Behaviour | Result |
|---|---|---|
| Bare "yes" | rejected; exact phrase required | PASS (security suite) |
| Exact phrase | saves only the prepared operation | PASS |
| Confirmation id reuse | rejected after completion | PASS (security suite) |
| Duplicate phone | detected before preview/save; reply says *already exists* | PASS |
| Invalid phone | rejected; previously collected fields kept | PASS |
| Completed workflow | `task` cleared; next turn is independent | PASS |
| Audit fields | `verified: true` only after DB read-back | PASS |

## 6. Microphone denial (executed)

The in-app browser exposes `getUserMedia` but the host denies microphone permission. That is a
useful failure-mode test:

| Check | Observed | Result |
|---|---|---|
| Permission state | `denied` | — |
| UI after start | shows a clear denial message and stops | PASS |
| Message text | “Microphone permission was denied. Type the command instead.” | PASS |
| Silent success / hang | none | PASS |
| Typed fallback still works | yes | PASS |
| Unit test | `NativeSpeechSession ends cleanly when the microphone is denied` | PASS |

A defect was found and fixed during this work: the earlier code could leave the mic button in a
listening state after denial. `frontend/src/voice/browserSpeech.js` and
`frontend/src/voice/VoiceMicButton.jsx` now terminate the session and surface the message above.

## 7. Physical microphone acceptance — NOT TESTED

No human with a physical microphone has run the checklist below. This cannot be simulated with an
automated browser: permission must be granted interactively, and the tester must speak.

### 7.1 Required test matrix (to be completed by the owner/tester)

Use English, Tamil and Tanglish for at least one row each.

| # | Scenario | Expected | Actual | Status |
|---|---|---|---|---|
| 1 | Grant microphone permission | browser records; no error | — | NOT TESTED |
| 2 | Deny permission | clear message; typed fallback works | — | PASS (automated) / physical NOT TESTED |
| 3 | English: "add a new customer" | asks for name | — | NOT TESTED |
| 4 | Tamil: "புதிய கஸ்டமர் சேர்க்க வேண்டும்" | asks for name | — | NOT TESTED |
| 5 | Tanglish: "pudhu customer add pannu" | asks for name | — | NOT TESTED |
| 6 | Speak a Tamil name | name captured (spelling may vary) | — | NOT TESTED |
| 7 | Speak a 10-digit phone | phone captured exactly | — | NOT TESTED |
| 8 | Speak a Tamil number word (e.g. ஐந்நூறு) | must not silently save a wrong amount | — | NOT TESTED (benchmark says unreliable) |
| 9 | Preview accuracy | preview matches what was said | — | NOT TESTED |
| 10 | Confirmation | saves only on the exact phrase | — | NOT TESTED |
| 11 | DB read-back | saved row matches preview | — | NOT TESTED |
| 12 | Cancel | no row written | — | NOT TESTED (typed PASS) |
| 13 | Background shop noise | transcript still usable or asks to repeat | — | NOT TESTED |
| 14 | Long pause / silence | stops cleanly, no phantom save | — | NOT TESTED |

### 7.2 How to run it

1. Start the backend and `npm run dev`; open the app in a real browser (not the automated pane).
2. Log in, open the voice assistant, choose **English** / **தமிழ்** / **Tanglish**.
3. Allow the microphone when prompted.
4. Run rows 1–14 above; for each, record the transcript, the preview and the saved row.
5. For row 11, verify with `GET /api/customers?q=<phone>` or a read-only SQLite query.
6. For row 12, cancel and confirm the row count did not change.
7. Report the browser, OS, microphone and model shown in the panel.

### 7.3 Known limitations that the physical test must respect

- `whisper-base` is not usable for Tamil/Tanglish; the UI switches to `whisper-small` for `ta` and
  `mixed`. See `SPEECH_MODEL_BENCHMARK_REPORT.md`.
- Spoken Tamil **number words** are unreliable. The preview/confirmation step is mandatory.
- Speech is an input convenience, never an authority. Nothing auto-saves.
- The browser downloads the model on first use; the first attempt can be slow.

## 8. What is verified vs not

| Area | Status |
|---|---|
| Typed English trigger + collection + save | **PASS** |
| Typed Tamil trigger + save | **PASS** |
| Typed Tanglish trigger + save | **PASS** |
| Transliterated Tamil name | **PASS** |
| Live required-field validation | **PASS** |
| Duplicate detection | **PASS** |
| Exact confirmation / bare yes rejected | **PASS** |
| Cancellation writes nothing | **PASS** |
| DB read-back / actual saved details returned | **PASS** |
| Mic permission denial handling | **PASS** (automated) |
| **Physical microphone capture** | **NOT TESTED** |
| **Physical English/Tamil/Tanglish accuracy** | **NOT TESTED** |
| **Spoken Tamil digits** | **NOT TESTED / benchmark says unreliable** |
| Browser-local Whisper end-to-end on this hardware | **NOT TESTED** (Cloudflare asset block; model download) |

## 9. Verdict

**Customer-creation workflow with typed input: PASS.**
**Microphone failure handling: PASS.**
**Physical microphone acceptance: NOT TESTED — blocks a "voice-ready" production label.**
