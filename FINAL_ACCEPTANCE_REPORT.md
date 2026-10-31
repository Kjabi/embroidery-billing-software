# Final Acceptance Report — Lalitha's Apparel

**Date:** 31 October 2026 (Asia/Kolkata)  
**Scope:** final testing of the existing application and browser voice assistant, free-tier deployment preparation, and validation of migration `0003` on a development database.  
**Verdict:** **Application and voice logic are test-verified. Production deployment is NOT signed off.** Browser microphone capture and browser Tamil text-to-speech could not be verified in this environment, migration `0003` has not been applied to production, and no external deployment was performed.

No production data, production credentials, paid service, or destructive production action was used. All test data lived in isolated SQLite/PostgreSQL development stores.

---

## 1. What was tested and where

| Item | Value |
| --- | --- |
| Repository | `/Users/abisheekkj/Documents/embroidery-management` |
| Git baseline | `420a67d` on `main` |
| Pre-test backup | `/private/var/folders/g0/tyb605l92nz1wrp669twflnr0000gn/T/opencode/embroidery-backups/embroidery-management-20261031-163829.tar.gz` — 417,297 bytes, mode `600` |
| Isolated API | FastAPI on `127.0.0.1:8001` with a throwaway SQLite database |
| Isolated PostgreSQL | PostgreSQL 17.10 on `127.0.0.1:55432`, database `embroidery_dev` |
| Browser | In-app browser against Vite dev server on `localhost:5180` |
| Microphone | Automated browser permission was **denied**; real microphone-path testing used macOS `ffmpeg avfoundation` acoustic loopback fed through the real browser Whisper module |

`.env` files are ignored by Git (`**/.env`); only `.env.example` and `frontend/.env.example` are tracked. The prepared deployment files contain placeholders only.

---

## 2. Automated test results

| Suite | Result |
| --- | --- |
| Backend `pytest` | **28 passed** |
| Frontend `npm test -- --run` | **17 passed** |
| Frontend production build (`npm run build`) | **passed** (Vite 5.4.21) |

The backend suite includes the new regression test `test_voice_read_phrase_regressions`, which covers:

- “Show me today's collections” → payment history, not customer search.
- “Show me Priya's details” → customer details.
- “What measurements are required for Normal Blouse?” → measurement template.
- “Open invoice for order N” is not consumed by the generic order-read path.

Parser defects found during final testing and fixed in `backend/voice_agent.py`:

1. `collections?`/`receipts?` plurals were not matched.
2. “measurements **are required for** …” was not matched.
3. “Show me Priya's **details**” fell through to a customer search failure.
4. The generic order-number read intercepted “Open invoice for order N”.

---

## 3. End-to-end business workflow

A reproducible API suite (`workflow_check.py`) exercised the real endpoints against the isolated SQLite backend, with every write checked directly in the database afterward.

**Result: 35 of 36 checks passed.**

The only recorded “failure” is a test-expectation artifact, not an application defect: voice invoice generation intentionally returns a `ui_action` that opens the existing invoice viewer instead of creating a `pending_operation`. The suite expected `pending_operation`. Direct verification of the actual invoice endpoints then passed:

- `GET /api/orders/2/pdf` → HTTP 200, 47,127 bytes, valid `%PDF-`.
- `POST /api/orders/2/invoice` → HTTP 200, 47,127 bytes, valid `%PDF-`.
- `invoice_snapshot` stored: 879 bytes.
- `invoice_sequences`: `(year 2026, next_number 3)`.

Verified business behavior:

| Area | Evidence |
| --- | --- |
| Order creation | Voice draft preserved across unrelated questions; explicit confirmation reversed a wrong phrase (`yes`) with HTTP 422; correct phrase created order `INV-2026-002`. |
| Database persistence | Order total ₹800, delivery `2026-11-10`, measurements stored. |
| Payment | ₹300 payment applied; balance became ₹500; one transaction row. |
| Duplicate confirmation | Replaying the same confirmation did not create a second transaction. |
| Cancellation | Cancelled pending payment wrote nothing. |
| Measurement update | Bust changed to 34 in. |
| Delivery update | Delivery date became `2026-11-12`. |
| Status update | Status became `Ready`. |
| Invoice generation | Valid PDFs regenerated from billing data; no permanent PDF storage. |
| Authentication | Unauthenticated and invalid-token voice access returned HTTP 401. |

---

## 4. Voice assistant verification

### 4.1 Browser microphone

**Blocked / not verified.** The automated browser reports microphone permission `denied`; the UI correctly showed “Voice is unavailable — type instead” and “Voice input: Permission denied”. Typed fallback worked. There is no tool available to grant the browser microphone permission, so no claim of `getUserMedia` success is made.

### 4.2 Real acoustic loopback through the real browser Whisper module

Audio recorded from the physical microphone output via `ffmpeg avfoundation`, then decoded and passed to the repository's actual `transcribeLocally` function in the browser:

| Case | Spoken | Transcript | Time |
| --- | --- | --- | --- |
| English | “Show me today's sales.” | **“Show me today's sales.”** (exact) | 3.2 s warm on a 5.6 s clip |
| Tamil | “இன்று விற்பனை என்ன?” | “இன்று விப்பனையில் என்ன?” (விற்பனை → விப்பனையில்) | first run 78.5 s including model load; 15.3 s warm on a 5.5 s clip |
| Mixed English, Tamil model | English sentence | Garbage/repetition loop | 97.5 s |
| Mixed Tamil, Tamil model | “இன்று sales என்ன?” | “இன்று சேல் சேன்னா.” | 13.7 s |

Interpretation:

- English speech recognition is accurate and usable on this hardware.
- Tamil speech recognition is **not yet acceptable for production**: it substituted a word and retained an inflection ending; the meaning survived only approximately. Warm latency of about 15 s for a 5.5 s utterance is slow.
- Mixed Tamil/English spoken input is unreliable. The deterministic **text** parser still accepts typed Tanglish, but spoken mixed input should not be advertised as working.

### 4.3 Browser text-to-speech

| Case | Result |
| --- | --- |
| English, voice `Rishi` (`en-IN`) | Speech started and ended normally in ~3.5 s with 9 boundary events. |
| Tamil, voice `Vani` (`ta-IN`) | Speech “started” then ended after ~125 ms with 6 boundary events and no intelligible audio. Recording the output and transcribing it returned “டாவ்டி.” |
| System `say -v Vani` | Audible and transcribable, proving the voice asset itself works outside `speechSynthesis`. |

**Tamil browser TTS is not verified.** The failure is in this browser's `speechSynthesis` path, not proven to be a code bug, and no local Tamil TTS model has been integrated. Do not claim Tamil spoken replies work in the browser.

### 4.4 What the assistant does and does not do

- Speech recognition and model inference run locally in the browser. Audio buffers and transcripts are not written to Web Storage, IndexedDB, analytics, or the backend by design.
- The backend receives **text only** for the browser voice path.
- Write actions always produce a preview and require the server-issued confirmation phrase; the deterministic backend parser is authoritative for writes.
- No paid STT, TTS, or LLM API is enabled by default. The optional Groq/Ollama planners remain off unless explicitly configured.

---

## 5. Security and privacy checks

| Check | Result |
| --- | --- |
| All business API routes require a signed, expiring admin token | Verified by tests and live 401 responses |
| Wrong confirmation phrase rejected | HTTP 422; no write |
| Duplicate confirmation replay | No duplicate payment or order |
| Cancelled pending operation | No database write |
| CORS restricted to configured frontend origins | Configured; `*` not used |
| Login throttling and password-hash upgrade | Present and covered by existing tests |
| Audio/transcript retention | Browser-local by design; no audio upload in the tested path |
| Secrets in repository | `.env` ignored; deployment files contain placeholders only |
| Invoice privacy | PDF generated in memory; no permanent PDF object in the tested path |

Residual risks:

- Conversation state, login throttling, and rate limits are **process-local**. The production design is intentionally one uvicorn worker; scaling out requires a shared store.
- The Supabase service-role key is a server-side secret and must never appear in any `VITE_` variable or frontend asset.

---

## 6. Migration `0003` validation

Migration file: `backend/migrations/0003_session_invoice_snapshots_and_idempotency.sql`

Validated only on the isolated PostgreSQL 17.10 development database. **Production Supabase was not touched; migration `0003` remains unapplied there.**

Evidence:

1. Pre-migration schema contained an existing order `INV-2026-005`, with no `admin_sessions`, `invoice_sequences`, `invoice_snapshot`, `create_request_id`, or `transactions.idempotency_key`.
2. The migration seeded `invoice_sequences` to `2026 → 6` (highest existing invoice + 1).
3. It created `admin_sessions`, `invoice_sequences`, both new `orders` columns, the `transactions.idempotency_key` column, and all three indexes.
4. The real application then:
   - created `INV-2026-007`;
   - replayed a duplicate order request without a new row (`idempotent_replay: true`);
   - recorded one ₹300 payment and replayed it as `idempotent_replay` with one transaction row;
   - generated a valid 47,123-byte PDF;
   - advanced the sequence to `2026 → 8`.
5. Final database state: order 3 total ₹1000, paid ₹300, balance ₹700, status `Partially Paid`.

One test order (`INV-2026-006`) was intentionally created with a zero total to probe validation; it exists only in the throwaway development database.

---

## 7. Free-tier hosting assessment

Target: Cloudflare Pages Free (frontend) + Oracle Cloud Always Free ARM64 (FastAPI) + existing Supabase Free (PostgreSQL and private Storage) + Let's Encrypt via Caddy. **Expected recurring cost: ₹0.**

| Item | Free allowance / limit | Risk |
| --- | --- | --- |
| Cloudflare Pages Free | Static hosting on `*.pages.dev`; build/bandwidth quotas | No paid add-ons; Pages domain only |
| Oracle Ampere A1 Always Free | Conservative documented allowance: 1,500 OCPU-hours + 9,000 GB-hours/month ≈ **2 OCPU / 12 GB** total; 200 GB block volume; 10 TB egress | “Out of host capacity” launch failures, **idle reclamation** if 7-day 95th-percentile CPU/network (and A1 memory) stay below 20%, no SLA, terms can change |
| Supabase Free | 500 MB database, 1 GB Storage, ~5 GB egress, 2 projects | Project pauses after ~7 days of inactivity; no automated backups, no email support |
| Let's Encrypt via Caddy | Free certificates | Requires a DNS name you control; rate limits |
| Hugging Face model weights | Public, browser-cached | Large first download; consumes user bandwidth, not Pages bandwidth |
| Vercel Hobby / paid APIs | **not used** | Vercel Hobby is non-commercial-only; a paid plan would be required |

Cloudflare Python Workers remain **incompatible** with this backend without a data-layer rewrite (native `psycopg`/Pillow, synchronous SQLAlchemy, local filesystem, process-local state). Cloudflare Pages is used only for the static frontend; the API stays on a Python host. Details: `CLOUDFLARE_COMPATIBILITY.md`.

The backend image was checked for ARM64 availability by a CPython 3.12 wheel dry-run: `psycopg_binary 3.3.6`, `Pillow 11.3.0`, `SQLAlchemy 2.0.35`, plus pure-Python/aarch64 FastAPI, uvicorn, reportlab, and pydantic-core wheels. No ARM64 boot or Docker build was executed because this machine is macOS x86_64 and the Docker daemon is not running.

---

## 8. Deployment artifacts and instructions

Prepared in `deploy/`:

| File | Purpose |
| --- | --- |
| `Dockerfile` | CPython 3.12-slim production image; excludes optional `faster-whisper` |
| `docker-compose.yml` | Backend behind Caddy; API bound to loopback only |
| `Caddyfile.example` | Automatic TLS and security headers |
| `backend.env.example` | Production environment placeholders, Supabase **session** pooler |
| `embroidery-backend.service` | systemd unit for Compose |
| `oracle-always-free.md` | Full zero-cost runbook, limits, migration steps, and blockers |

Short form:

1. Create Oracle `VM.Standard.A1.Flex` (2 OCPU / 12 GB, ARM64), allow only SSH from the admin IP plus 80/443.
2. Point a DNS name you control at the instance; run `docker compose -f deploy/docker-compose.yml up -d --build` with `deploy/backend.env` at mode `600`.
3. Apply migration `0003` to a verified production backup **after owner approval**, then start the backend.
4. Build the frontend with `VITE_API_BASE_URL=https://<backend-domain>/api` and `VITE_VOICE_ENABLED=true`, then deploy `dist` with Wrangler to Pages.
5. Add the exact Pages origin to `FRONTEND_ORIGIN`; never use `*`.

Not performed: Cloudflare account/token provisioning, Oracle tenancy/SSH, Docker build, ARM64 boot, Caddy certificate issuance, production Supabase connection, migration `0003` on production.

---

## 9. Status matrix

| Capability | Implemented | Tested | Deployed |
| --- | --- | --- | --- |
| Existing billing/order/payment/invoice app | Yes | Yes (backend 28, frontend 17, build) | No |
| Browser-local Whisper STT, English | Yes | Yes (acoustic loopback, exact transcript) | No |
| Browser-local Whisper STT, Tamil | Yes | Partial (word substitution, ~15 s warm) | No |
| Mixed Tamil/English spoken input | Yes | No (garbage or mangled) | No |
| Deterministic Tamil/English/Tanglish text parser | Yes | Yes (28 backend tests) | No |
| English browser TTS | Yes | Yes (`Rishi`) | No |
| Tamil browser TTS (`Vani`) | Yes | **No** (silent/aborted in `speechSynthesis`) | No |
| Explicit confirmation and duplicate protection | Yes | Yes | No |
| Migration `0003` on development PostgreSQL | Yes | Yes (PG 17.10) | Dev only |
| Migration `0003` on production | No | No | No |
| Cloudflare Pages frontend | Prepared | Build only | No |
| Oracle Always Free backend | Prepared | Wheel compatibility only | No |

---

## 10. Required actions before production sign-off

1. **Verify the microphone in a real browser** with a granted permission: record English, Tamil, and mixed input through `getUserMedia` and confirm the transcript and confirmation flow.
2. **Resolve Tamil TTS** — confirm `Vani` works on the target machine/browser, or integrate and verify a local Tamil TTS model. Until then, do not promise spoken Tamil replies.
3. **Improve Tamil/mixed STT accuracy and latency** if spoken Tamil is a launch requirement (larger model, quantisation, or a different decoding strategy), then re-test on target hardware.
4. **Apply migration `0003` to production** only after a verified backup, `pg_dump` restore test, and explicit owner approval.
5. **Actually deploy and re-test** Cloudflare Pages, Oracle TLS/CORS, login, order/payment/invoice flows, and Supabase Storage on the deployed host.
6. **Accept the free-tier risks in writing**: Supabase inactivity pause, Oracle idle reclamation/capacity shortages, no SLA, no automated backups.

**Production verdict: not ready until items 1–5 are completed and the owner accepts item 6.**
