# Voice assistant

The voice assistant is an authenticated, stateful tool-using agent inside the
existing admin app. It answers live business questions and prepares changes,
but it never saves a business record without a server-generated preview and an
explicit confirmation.

It works with **zero paid services** by default:

- Speech-to-text: **browser-local Whisper** through Transformers.js
  (`@huggingface/transformers`). Audio never leaves the admin's browser.
- Commands and answers: the built-in deterministic Tamil / English / Tanglish
  parser (`VOICE_LLM_PROVIDER=deterministic`).
- Spoken replies: the browser's `speechSynthesis` (free, client-side).
- Typed commands: always available, even when the microphone or local model is
  missing.

No paid SDK is installed. Groq and Ollama are optional, explicit opt-ins. The
application never falls back to a paid provider.

## Flow

1. The admin presses **Start conversation**. The browser captures microphone
   audio with the Web Audio API, segments it with a local energy VAD, resamples
   it to 16 kHz in memory, and transcribes each segment locally with Whisper.
   No audio is uploaded.
2. The transcript is sent as text to `POST /api/voice/turn`. The backend never
   receives audio, and the transcript is held only in bounded process memory.
3. The backend validates the transcript length/rate and runs one stateful turn.
   The agent may call only the allowlisted tools, ask a clarifying question, or
   prepare a preview.
4. A write tool returns a server-built preview and a random `confirmation_id`
   with a short expiry. Nothing is saved.
5. The UI shows the preview. The admin edits the draft if needed
   (`PATCH /api/voice/draft`), then reads or types the exact confirmation phrase.
6. `POST /api/voice/confirm` verifies the owning admin, confirmation ID, phrase,
   expiry, current customer/product, and idempotency. Only then does it call the
   existing business function (`create_order`, `collect_balance`, and so on).
7. The endpoint reads the saved record back and returns verified values.

`POST /api/voice/cancel` discards a pending preview or the active draft.
`DELETE /api/voice/session` clears the temporary conversation.

The older `POST /api/voice/transcribe` endpoint remains for API/testing use with
the optional backend Faster-Whisper provider. The admin panel does not call it.

## Tool allowlist

Read tools use real database values and Asia/Kolkata business dates
(`backend/business_time.py`):

- Business/sales summary, order counts, outstanding payments, payment history.
- Order lists, order search/details, customer search/details/history.
- Product list and measurement templates.

Prepare-only tools (never save on their own):

- Create/update customer.
- Create an order (manual pricing only).
- Update measurements, delivery date, status, or order description.
- Record a payment.
- Open the existing in-memory invoice viewer.

There is no SQL, shell, HTTP, arbitrary Python, delete, or invoice-file tool.

## Order value vs money collected

Reports always distinguish **order value** (the total value of orders placed)
from **money collected** (payments/advance actually received) and
**outstanding balance**. The assistant never presents one as the other.

## Confirmation security

- The confirmation ID is random, owner-bound, and expires
  (`VOICE_CONFIRMATION_TTL_SECONDS`, default 5 minutes).
- The phrase is generated server-side from the preview, for example
  `confirm payment of 500 for INV-2026-001`.
- `create_order` requires the customer name and the exact total; payments
  require the invoice and exact amount; other order changes require the invoice
  or order number.
- Amounts preserve paise in both the backend phrase and the frontend helper.
- Repeating the same confirmation replays the completed result instead of
  submitting twice. `create_order` and `collect_balance` also receive
  idempotency keys derived from the confirmation ID.
- Expired previews are rejected; the admin must ask again.

## Language modes and models

Whisper's multilingual checkpoints need an explicit language. If it is omitted,
Transformers.js falls back to English, which turns Tamil speech into unrelated
English text. The panel therefore has a language selector; the choice is stored
in `localStorage` under `emb_voice_language` (preference only, not conversation
data).

| Mode | Whisper language | Model | Approx. download (q4) |
| --- | --- | --- | --- |
| English | `en` | `onnx-community/whisper-base` | ~142 MB |
| தமிழ் (Tamil) | `ta` | `onnx-community/whisper-small` | ~299 MB |
| Tanglish (mixed) | `ta` | `onnx-community/whisper-small` | ~299 MB |

- Models are loaded lazily on the first conversation and cached by the browser's
  Cache Storage. A **Remove cached model** control clears them.
- The UI runs on the WASM backend. It loads in single-threaded mode unless the
  page is cross-origin isolated. Warm inference in the tested browser was roughly
  3 seconds for `whisper-base` and 12–15 seconds for `whisper-small` per short
  utterance. Plan for that delay on modest hardware.
- Tanglish recognition is partial. Whisper transliterates mixed speech, and the
  deterministic backend parser understands common Tanglish read phrases such as
  "Indru sales enna" but not every mixed write command. Typed commands remain the
  reliable fallback.

Optional build-time overrides live in `frontend/.env` (not the backend `.env`):

```dotenv
VITE_VOICE_MODEL_EN=onnx-community/whisper-base
VITE_VOICE_MODEL_TA=onnx-community/whisper-small
VITE_VOICE_MODEL_TANGLISH=onnx-community/whisper-small
VITE_VOICE_MODEL_DTYPE=q4
```

## Data retention

- Microphone audio exists only in browser memory for the current segment. It is
  never uploaded, written to Web Storage/IndexedDB, or logged.
- Transcripts are sent to the backend as text and held only in bounded process
  memory with an idle TTL. They are not written to PostgreSQL, Supabase Storage,
  browser storage, or log files.
- The only browser setting persisted is the language preference
  (`emb_voice_language`). Cached model weights are public model files, not
  business data.
- No new database migration or bucket is required.
- Invoice PDFs remain in memory only, as before.

## Configuration

Copy the voice section from `.env.example`. Backend defaults:

```dotenv
VOICE_LLM_PROVIDER=deterministic
VOICE_CONVERSATION_TTL_SECONDS=1800
VOICE_CONFIRMATION_TTL_SECONDS=300
VOICE_TTS_PROVIDER=browser
```

Browser speech recognition needs no environment variable. The model names above
are the defaults; `frontend/.env` can override them at build time. Set
`VITE_VOICE_ENABLED=false` to hide the assistant panel while leaving every
existing dashboard and manual workflow intact. The backend
`VOICE_STT_PROVIDER`/`VOICE_LOCAL_*` variables apply only to the optional
`/api/voice/transcribe` endpoint used by tests or API clients.

Optional providers:

- **Ollama** (free, local): run Ollama, set `OLLAMA_CHAT_MODEL`, then set
  `VOICE_LLM_PROVIDER=ollama`.
- **Groq**: set `VOICE_LLM_PROVIDER=groq`, `GROQ_API_KEY`, and
  `GROQ_CHAT_MODEL` **only after independently verifying a zero-cost allowance
  on your own account**. Setting `VOICE_STT_PROVIDER=groq` additionally uses
  `GROQ_STT_MODEL` for the backend endpoint. Neither is enabled automatically.

Secrets stay on the backend. React never receives the database URL, service
role key, or provider keys.

## Local run and tests

```bash
./start.sh                    # FastAPI :8000 + Vite :5173
cd backend && ../.venv/bin/python -m pytest -q
cd frontend && npm test
cd frontend && npm run build
```

Latest local run: **27 backend tests passed**, **17 frontend tests passed**, and
the production build succeeded. Tests use an isolated SQLite database and never
touch production data.

The build emits the ONNX Runtime WASM asset (~27 MB) plus the Transformers.js
chunk (~599 kB) and the main app chunk (~683 kB). Vite prints a >500 kB chunk
warning; it is a size warning, not a failure.

## Deployment constraints

- Conversation state is process-local. Run **one** backend process, or add a
  shared store before scaling to multiple workers. A serverless Vercel function
  may lose state between requests; typed commands still work, but voice
  conversations may not survive across function instances.
- Browser speech recognition downloads model weights from Hugging Face on first
  use, so the admin browser needs HTTPS (or localhost) and a network connection
  once per model. It needs no GPU; WASM is the fallback and was used in testing.
- The existing production migration (`backend/migrations/0003_*.sql`) is still
  required for the manual order/payment flows and remains unapplied here.
- The frontend is Pages-compatible, but the current FastAPI backend is not
  compatible with Cloudflare Python Workers without a data-layer rewrite. See
  [`CLOUDFLARE_COMPATIBILITY.md`](CLOUDFLARE_COMPATIBILITY.md) for the exact
  blockers.
- No production deployment, paid API call, destructive migration, or customer
  data rewrite was performed.

## Known limitations

- The deterministic parser understands the common phrasings covered by tests,
  but it is not a general-purpose language model. Unusual phrasing may need to
  be reworded or typed.
- Tanglish recognition is partial. Tamil script and English are more reliable,
  and the parser does not accept every mixed-language write command.
- A real microphone was not available to the automated browser (permission
  denied), so the full speak → transcribe → turn → confirm path was verified with
  fixed audio through the same browser transcription code, plus typed turns.
- Voice order creation supports manual-priced products only. Stitch-based
  products require a stitch count and embroidery rate, so the assistant refuses
  them and directs the admin to the manual form.
- Measurement names must exist in the product's configured template. The
  assistant asks for a unit instead of guessing inches or centimetres.
- In-memory state is lost on backend restart and is not shared across workers.
- Browser speech synthesis and microphone permission behavior depend on the
  browser and operating system.
