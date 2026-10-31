# Voice assistant audit and setup

Updated: 2026-10-30 (Asia/Kolkata)

> Current implementation notes, environment variables, and limitations are in
> [`VOICE_ASSISTANT.md`](VOICE_ASSISTANT.md). This page records the original
> audit; the verification block at the end reflects the latest run.

## Audit summary

The application has a React/Vite frontend (`frontend/src/App.jsx`) and a FastAPI/SQLAlchemy backend (`backend/main.py`). The application currently has no React router or separate state-management library; UI state is local React state. `start.sh` starts FastAPI on port 8000 and Vite on port 5173. `vercel.json` maps `/api/*` to the FastAPI service, which is serverless in that deployment topology.

The backend uses `SUPABASE_DATABASE_URL` for PostgreSQL when configured and an isolated SQLite database only for local development/testing. Database models cover administrator accounts/sessions, customers, products, measurement templates and fields, embroidery rates, orders, order measurements, transactions, and the invoice counter. The additive migrations are in `backend/migrations/`. The app enforces admin authentication with a signed token plus a server-side `admin_sessions` record; protected routes use `require_admin`.

Existing business routes provide customers, products, templates, rates, orders, payments, finance reports/exports, backup/restore, and temporary in-memory invoice PDFs. The reference image/PDF flow remains temporary; this assistant does not upload or persist either.

## Voice architecture

Speech recognition now runs **in the admin's browser**. The panel captures with
the Web Audio API, segments speech with a local energy VAD, resamples to 16 kHz
in memory, and transcribes with Whisper through Transformers.js. No microphone
audio is uploaded. Model weights are downloaded once from the public Hugging
Face repository and cached by the browser; a control in the panel removes them.

Whisper multilingual checkpoints require an explicit language. The panel offers
English (`whisper-base`), Tamil (`whisper-small`), and Tanglish (`whisper-small`
with `language: "ta"`). The choice is saved as `emb_voice_language` in
`localStorage`; transcripts, audio, and business data are never stored there.
Tanglish recognition is partial.

The backend still exposes `POST /api/voice/transcribe` for API/testing use with
the optional local Faster-Whisper or Groq provider. It validates MIME type, byte
limit, media duration, and request rate, and deletes temporary files. The admin
panel does not call it.

`POST /api/voice/turn` is a stateful, authenticated conversation endpoint. Its
state is in a bounded process-memory store and is keyed by the authenticated
admin plus server-side auth session. It has a 30-minute idle TTL. This is
appropriate for one local process; it is deliberately not represented as
durable or shared across Vercel workers/restarts.

The agent uses an explicit fixed tool allowlist implemented as server functions:

- Database-backed report tools for today’s pending orders, order value, payments collected, outstanding amount, customer count, order count, and overdue orders.
- A prepared manual-price order workflow that resolves customer/product names, reads the real product measurement template, asks for units, preserves a draft through read-only interruptions, and creates a pending preview only after required values are present.
- Prepared payment recording and ISO-date delivery-date changes, both protected by the same owner-bound random confirmation mechanism and existing payment idempotency controls.
- A confirmation endpoint that validates the owner, random confirmation ID, exact confirmation phrase, expiration, current customer/product, and reuses the existing `create_order` business function with an idempotency key.

The assistant has no SQL, shell, arbitrary HTTP, arbitrary Python, or deletion tool. It cannot turn transcript text into a privileged action directly.

## Files added/changed

- `backend/business_time.py` — Asia/Kolkata business dates.
- `backend/voice_config.py` — environment-backed voice configuration.
- `backend/voice_parsing.py` — multilingual money/date/measurement/phone parsing.
- `backend/voice_state.py` — temporary typed conversation, draft, and pending state.
- `backend/voice_agent.py` — deterministic intent parsing, planner, and replies.
- `backend/voice_tools.py` — allowlisted read/prepare/execute tools.
- `backend/voice_providers.py` — optional local Faster-Whisper, Groq, and Ollama providers.
- `backend/voice_schemas.py` — request/response contracts.
- `backend/main.py` — authenticated voice routes, rate limits, and allowlisted database tools.
- `frontend/src/voice/browserSpeech.js` — browser-local Whisper, VAD, resampling, model cache, language/model mapping.
- `frontend/src/voice/VoiceMicButton.jsx` — continuous local voice session, language selector, progress, level meter.
- `frontend/src/voice/VoiceTranscript.jsx`, `VoiceTaskCard.jsx`, `VoiceDraftEditor.jsx`, `VoiceConfirmationDialog.jsx` — panel UI pieces.
- `frontend/src/voice/voiceLogic.js` — pure formatting/confirmation/draft helpers.
- `frontend/src/VoiceAssistantPanel.jsx` — messages, typed fallback, task/draft, confirmation, language, TTS controls.
- `frontend/src/App.jsx` — voice panel integration.
- `backend/tests/test_security_and_orders.py`, `test_voice_parsing.py`, `test_voice_providers.py` — voice/security coverage.
- `frontend/src/voice/browserSpeech.test.js`, `voiceLogic.test.js` — frontend helper coverage.

No database migration is required because conversation state and transcripts are intentionally temporary.

## Provider configuration and limits

The default UI path is browser-local speech recognition and needs no STT
configuration:

```dotenv
# optional frontend/.env overrides
VITE_VOICE_MODEL_EN=onnx-community/whisper-base
VITE_VOICE_MODEL_TA=onnx-community/whisper-small
VITE_VOICE_MODEL_TANGLISH=onnx-community/whisper-small
VITE_VOICE_MODEL_DTYPE=q4
```

Approximate first-use downloads: `whisper-base` q4 ~142 MB; `whisper-small` q4
~299 MB. The build includes a ~27 MB ONNX Runtime WASM asset. Inference runs on
the CPU/WASM backend without cross-origin isolation; the tested browser produced
warm latencies of roughly 3 seconds (base) and 12–15 seconds (small) for short
utterances. Model files are cached in browser Cache Storage and can be removed
from the panel.

The optional backend transcription endpoint uses local Faster-Whisper:

```dotenv
VOICE_STT_PROVIDER=local
VOICE_LOCAL_MODEL_SIZE=base
VOICE_LOCAL_COMPUTE_TYPE=int8
VOICE_LOCAL_CPU_THREADS=4
VOICE_MAX_DURATION_SECONDS=60
VOICE_MAX_UPLOAD_MB=10
```

`faster-whisper` is listed as an optional free software dependency. It was not
installed in this environment, so that endpoint’s inference remains unverified.
A serverless Vercel function is not suitable for keeping a local Whisper model
warm.

Groq is not automatically enabled or called. Current official documentation lists `whisper-large-v3-turbo`, but its published rate is per hour. A configured API key is therefore not proof of zero cost. Do not enable it unless its usage allowance has been verified independently. The same principle applies to an optional LLM provider: this build remains deterministic and fully usable without one.

## Local startup

```bash
cd /Users/abisheekkj/Documents/embroidery-management
./start.sh
```

Use the existing admin login, then open the Voice assistant panel. Choose
English, Tamil, or Tanglish; the first conversation downloads and caches the
matching Whisper model in the browser. If the microphone is unavailable or
denied, the model fails to load, or recognition is unreliable, type the same
command in the panel or use the existing manual forms.

## Actual verification

```text
cd backend && ../.venv/bin/python -m pytest -q     passed (27 tests)
cd frontend && npm test                            passed (17 tests)
cd frontend && npm run build                       passed
```

Browser smoke test (temporary local backend on 8001 and Vite on 5180, isolated
SQLite data): admin login, typed read turn, customer creation preview and
explicit confirmation, order creation preview and explicit confirmation
(`INV-2026-001`, total 600, delivery 2026-10-31), and model download/caching.

Browser-local transcription with fixed audio through the real
`browserSpeech.js` code: English exact ("Show me today's sales."); Tamil exact
with `language: "ta"`; quiet refusal when no language was supplied (English
fallback). Tanglish read text ("Indru Sales Enna") was recognized and parsed;
Tanglish write speech was not reliable. Microphone permission was denied by the
automated browser, and the typed fallback handled it correctly.

Not yet verified: a real microphone capture and end-to-end spoken turn in a
physical browser, backend Faster-Whisper/Groq/Ollama inference, multi-worker or
serverless state continuity, and Vercel Preview end-to-end behavior. No
production deployment, provider billing, database migration, customer-data
rewrite, or external paid request was performed.
