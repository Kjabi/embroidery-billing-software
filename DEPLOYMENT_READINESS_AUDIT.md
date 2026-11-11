# Deployment Readiness Audit — Lalitha's Apparel

**Date:** 2026-11-07
**Repository:** `/Users/abisheekkj/Documents/embroidery-management`
**Branch / HEAD:** `main` / `f32a2fa` (`Add customer editing to the Customer Directory`)
**Audit scope:** Phase 0 (repository audit) and Phase 1 (release-candidate stabilization)
**Production actions taken:** none. No production database, storage, migration, DNS or deployment was touched.

## 0. Release-candidate update — 2026-11-08

This section supersedes the dated Cloudflare/Oracle assumptions where noted. It records what was
actually executed on an isolated local instance (SQLite under `.runtime/run-20261108/`, backend
`127.0.0.1:8010`, frontend `127.0.0.1:5173`). Production was not touched.

### 0.1 Verified in this pass

| Check | Command / harness | Result |
|---|---|---|
| Backend suite | `.venv/bin/python -m pytest -q` | **PASS — 156 passed** |
| Frontend suite | `npm test -- --run` | **PASS — 19 passed** |
| Production build | `npx vite build` with `frontend/.env.production` | **PASS — ~2.7 s** |
| Endpoint sweep | `.runtime/run-20261108/endpoint_smoke.py` | **62/62 checks PASS** (two earlier non-passes were harness-expectation errors, not product defects; the harness was corrected: `STITCH_BASED` requires `total_amount`, and `PATCH /api/voice/draft` with no draft intentionally returns a friendly 200) |
| Route coverage | 37 routes incl. auth/revocation, customers, templates, products, rates, orders, idempotent replay, payments, PDFs, invoice upload, finance CSV/PDF, backup, cloud-backup, restore, voice | **PASS on the isolated instance** |
| UI audit | Playwright, 1440 / 768 / 390 px, all six tabs, real customer CRUD, real order submit, finance export | **0 console errors, 0 page errors, 0 failed requests, 0 unnamed controls, 0 small buttons, 0 unlabeled inputs, 0 horizontal overflow** |
| Vercel config | `jsonschema` draft-04 against `https://openapi.vercel.sh/vercel.json` | **VALID**, including `services`, `rewrites` and `headers` |
| Vercel dependency set | `backend/requirements-vercel.txt` | excludes `faster-whisper` and `pytest`; voice disabled in build |
| Vercel Python runtime | `python3.12` | **NOT TESTED locally** — the suite ran on Python 3.14.3; no 3.12 interpreter is installed in this environment |
| Vercel upload safety | `.vercelignore` | excludes `.env*`, `.runtime/`, `.venv/`, local data and build output; keeps `frontend/.env.production` |
| Vercel request-body cap | backend + UI reference-image limit | lowered from 5 MB to **4 MB** (Vercel rejects bodies over 4.5 MB before the app); regression test added |

Artifacts: `.runtime/run-20261108/ui-audit.json` (latest run 2026-11-08 17:29 UTC), screenshots,
endpoint log, `.runtime/run-20261108/vercel-schema-validation.txt` and server logs.

### 0.2 UI score (internal heuristic — not a formal benchmark)

**82 / 100.** Scored only from the Playwright evidence above and a code review of `App.jsx`.

| Dimension | Weight | Score | Main deduction |
|---|---|---|---|
| Core workflow completeness | 20 | 17 | no production/delivery status flow; no list pagination/sort; no password change |
| Task friction and feedback | 20 | 15 | payment collection uses `window.prompt`; deletes use `window.confirm`/`alert` |
| Accessibility | 15 | 13 | native prompt/confirm are not app-managed or focus-trapped |
| Responsive layout | 15 | 13 | functional at 390/768, but dense tables are cramped on mobile |
| Error / empty / loading states | 15 | 12 | good banners and empty states; no global toast/undo |
| Visual consistency | 10 | 8 | coherent Tailwind system; mixed dark/light card treatments |
| Perceived performance | 5 | 4 | fast first paint; 26 MB wasm asset is emitted but never fetched when voice is off |

This score is not a WCAG conformance claim and not a substitute for physical-device testing.

### 0.3 Remaining missing UI elements (prioritised)

**P1 — normal-use friction**
1. **Production/delivery pipeline.** The dashboard's “production stages” are payment stages.
   There is no UI or API to move an order through `Pending → Cutting/Stitching → Ready →
   Delivered`, and `completed_orders` means “balance is zero”. Add a status transition endpoint,
   per-order control, delivery timestamp and a “due/ready for pickup” list.
2. **Payment modal.** `window.prompt` for balance collection has no field labels, method choice,
   validation, or visible idempotency state. Replace with an in-app modal.
3. **Delete confirmations.** Replace `window.confirm`/`alert` with an app modal and a toast;
   the current flow is functional but visually jarring and not focus-managed.
4. **Tab persistence / deep links.** `tab` is component state only: refresh returns to the
   dashboard and browser Back does not traverse tabs. Persist in the URL hash.

**P2 — scale and daily operations**
5. Pagination or virtualisation plus column sorting for orders, customers and transactions.
6. Customer detail drawer with order/measurement history (today only an edit modal exists).
7. Admin password change and an expiring-session warning.
8. Global toast + undo for deletes (soft delete) instead of immediate destructive writes.
9. Customer/order CSV export (finance export exists today).
10. Server-side customer phone validation: the UI enforces 10 digits and warns on duplicates, but
    direct `POST /api/customers` still accepts non-numeric or duplicate numbers.

**P3 — polish and reporting**
11. Dashboard date range, today's deliveries and outstanding-balance ageing.
12. Print-friendly delivery challan and measurement slip.
13. Bulk status update for selected orders.
14. Optional dark mode and richer chart accessibility summaries.

### 0.4 Hosting decision update

The owner has selected **Vercel** (Services config) as the deployment target; the earlier
Oracle/Caddy decision is now a fallback. `vercel.json` declares a static Vite `web` service and a
Python 3.12 ASGI `api` service, with `/api` rewrites ordered before the SPA catch-all. The
configuration validates against the published schema, but **no deployment, DNS, database
migration or environment provisioning was performed**.

`vercel.json`, `frontend/.env.production`, `backend/requirements-vercel.txt` and
`.vercelignore` are currently **uncommitted**. A CLI deploy (`npx vercel deploy`) uploads the
working tree and can proceed without a commit; a Git-connected Vercel project would build the
last commit and fail the guarded frontend build until these files are committed (approval
required). `.vercelignore` excludes the root `.env`, `.runtime/`, `.venv/`, local data and build
output, and keeps `frontend/.env.production`.

Owner decision still required: Vercel's **Hobby** plan is for non-commercial use. A commercial
deployment needs Pro (~US$20/month), which conflicts with the ₹0 recurring-cost target.

## 1. Verdict

**Current label: NOT READY** (unchanged by the 2026-11-08 verification pass: tests, endpoints and UI
are healthy on an isolated instance, but no production deployment, migration, backup or TLS has
been proven).

**Update (2026-11-08, after owner decisions):** the hosting target is **Vercel** (Services config);
the Cloudflare Pages asset-limit blocker (§7.1) no longer applies to the chosen target, and the
Oracle/Caddy path is now a fallback. Voice remains disabled in production
(`VITE_VOICE_ENABLED=false`). See §0 for the release-candidate results and
`GO_LIVE_CHECKLIST.md` for current gate status.

The application is functional and its automated test baseline is healthy, but it cannot be
called production-ready while:

1. No Vercel deployment, `POST /api/health` check, environment provisioning or DNS/TLS has been
   executed.
2. Physical microphone acceptance is still `NOT TESTED` (voice is disabled, so this blocks
   re-enabling voice rather than the current release).
3. Migration `0003`/`0004` has not been applied to a production-schema copy with approval.
4. No independent, restorable backup destination has been verified.
5. Tamil speech accuracy and Tamil TTS are not production-quality (voice disabled; re-enable
   gate only).

## 2. Existing architecture (verified from the repository)

| Layer | Implementation |
|---|---|
| Frontend | React 18.3, Vite 5.4, Tailwind 3.4, Recharts 2.12, lucide-react, `@huggingface/transformers` 4.3 (browser Whisper) |
| Backend | FastAPI 0.115, SQLAlchemy 2.0 (synchronous), Pydantic v2, ReportLab, Pillow, httpx |
| Database | PostgreSQL (Supabase) in production; SQLite for local development/testing |
| Auth | PBKDF2-SHA256 (600,000 rounds) admin password, HMAC-signed JWT, server-side `admin_sessions` row validation, `require_admin` dependency |
| Voice | Deterministic intent parser plus optional LLM provider; browser-local Whisper; backend faster-whisper / whisper.cpp / Groq transcription; preview + explicit confirmation + idempotency for writes |
| Storage | Private Supabase Storage buckets via backend-only service key; invoice PDFs rendered in memory |
| Deployment | Vercel Services (static Vite `web` + Python ASGI `api`), configured in `vercel.json`; Oracle/Caddy/Docker/systemd files retained as a fallback |

## 3. Repository state

`git status --short` at audit time (the working tree has changed again; see §0 for the current
release-candidate state and `git status` before any commit):

```
 M .env.example
 M .vscode/settings.json
 D CLOUDFLARE_COMPATIBILITY.md
 D DEPLOYMENT_READINESS_REPORT.md
 D FINAL_ACCEPTANCE_REPORT.md
 D IMPLEMENTATION_STATUS.md
 D VOICE_ASSISTANT.md
 D VOICE_ASSISTANT_AUDIT_AND_SETUP.md
 M backend/main.py
 M backend/tests/test_voice_parsing.py
 M backend/tests/test_voice_providers.py
 M backend/voice_agent.py
 M backend/voice_config.py
 M backend/voice_parsing.py
 M backend/voice_providers.py
 M backend/voice_tools.py
 M frontend/.env.example
 M frontend/src/App.jsx
 M frontend/src/VoiceAssistantPanel.jsx
 M frontend/src/voice/VoiceMicButton.jsx
 M frontend/src/voice/browserSpeech.js
 M frontend/src/voice/browserSpeech.test.js
?? backend/migrations/0004_read_path_indexes.sql
?? backend/tests/test_voice_intents.py
?? frontend/src/FinanceCharts.jsx
```

Observations:

- Six tracked reports are deleted in the working tree. They were **not restored** because the
  deletion may be intentional user work. `CUSTOMER_CREATION_FIX_REPORT.md`, referenced by the
  project brief, does not exist anywhere in the tree.
- `.env` exists locally and is ignored by Git. No real `.env` file is tracked
  (`git ls-files` contains only `.env.example` and `frontend/.env.example`).
- `backend/migrations/0004_read_path_indexes.sql` and `backend/tests/test_voice_intents.py` are
  untracked but referenced by the current work.
- No commit was created during this audit.

## 4. Uncommitted change classification (Phase 1)

| Category | Files | Assessment |
|---|---|---|
| Customer-creation fix | `backend/voice_agent.py`, `backend/voice_tools.py`, `backend/main.py` (customer record helper + validation), `backend/tests/test_voice_intents.py` | Coherent; covered by focused tests |
| Microphone-denial fix | `frontend/src/voice/browserSpeech.js`, `frontend/src/voice/VoiceMicButton.jsx`, `frontend/src/voice/browserSpeech.test.js` | Coherent; regression test added; now 19/19 frontend tests |
| Other voice changes | `backend/voice_config.py`, `backend/voice_parsing.py`, `backend/voice_providers.py`, `backend/tests/test_voice_providers.py`, `backend/tests/test_voice_parsing.py`, `frontend/src/VoiceAssistantPanel.jsx`, `frontend/.env.example`, `.env.example` | whisper.cpp provider, Tamil normalization, floating-panel behavior, configuration contract |
| Unrelated application / performance changes | `frontend/src/App.jsx` (floating assistant mount, per-tab loading, dashboard summary, lazy `FinanceCharts`), `frontend/src/FinanceCharts.jsx`, `backend/main.py` (`Server-Timing`, dashboard/finance aggregates), `backend/migrations/0004_read_path_indexes.sql`, `.vscode/settings.json` | Review before bundling; not part of the customer-creation fix |
| Deletions | Six tracked `.md` reports | Do not restore or commit without owner review |

### Code-hygiene checks performed

| Check | Result |
|---|---|
| Added `print()` / `console.log()` / `debugger` in reviewed source | PASS — none added |
| Hardcoded secrets / service-role keys in source | PASS — only placeholder names in examples |
| Temporary local paths or test passwords added to source | PASS — none added |
| Secrets in tracked files | PASS — no tracked `.env`; scan found only `<...>` placeholders |
| DEBUG mode / development-only branches | PASS — `APP_ENV` enforced for serverless |
| Obvious unused imports introduced | PASS — no new unused imports found in reviewed diffs |
| `.gitignore` coverage | PASS with caveat — ignores `.env*`, databases, uploads, invoices, backups, `node_modules`, `dist`, `.runtime`, `.venv`; see §7.9 |

## 5. Test baseline (executed during this audit)

| Suite | Command | Result |
|---|---|---|
| Backend | `.venv/bin/python -m pytest -q` in `backend/` | **PASS — 144 passed at audit time; 156 passed on 2026-11-08** |
| Frontend | `npm test -- --run` in `frontend/` | **PASS — 19 passed** |
| Production build | `VITE_API_BASE_URL=https://api.example.com/api npm run build` | **PASS (build), FAIL (Pages asset limit)** |
| Migration rehearsal | `0003` + `0004` on isolated PostgreSQL 17.10 copy | **PASS — idempotent, no data change** |
| Schema / financial invariant audit | SQL checks on the rehearsal copy | **PASS — 0 violations** |

Two backend failures existed at the start of this audit:

- `test_parse_date_accepts_iso_spoken_dates_and_relative_words` — hardcoded
  `2026-11-05`; the parser rolls an unqualified past date into the next year.
- `test_tamil_sales_question_executes_real_database_query` — hardcoded
  `order_date="2026-11-05"` while asking for *today's* sales.

Both were **date-dependent test defects**, not application regressions. They were made
deterministic (pinned business date / live business date) and the full suite now passes.

## 6. Completed functionality (evidence-based)

| Area | Status | Evidence |
|---|---|---|
| Admin login/logout, session revocation | PASS | Backend tests; server-side session lookup |
| Customer CRUD, search, duplicate-phone guard | PASS | Backend tests; isolated UI E2E |
| Products, templates, embroidery rates | PASS | Backend tests and seed data |
| Orders, measurements, status, delivery dates | PASS | Backend tests; load test |
| Payments, balances, over-payment rejection | PASS | Backend tests |
| Invoice sequence, snapshots, idempotency | PASS (tested) | Migration rehearsal; backend tests |
| Invoice PDF generation | PASS | Backend tests; generated in memory |
| Finance summaries and CSV export | PASS | Backend tests; load test |
| Customer creation via voice (en/ta/tanglish) | PASS (typed/API) | 87 focused voice tests; isolated UI E2E; DB read-back |
| Preview → explicit confirmation → save | PASS (typed/API) | UI E2E; confirmation phrase matched exactly |
| Cancellation of voice preview | PASS | UI E2E; no row created |
| Microphone-denial handling | PASS | In-app browser denial test + regression test |
| Physical microphone capture | NOT TESTED | Requires the user's microphone |
| Floating assistant on every tab | PASS (code + UI) | Lazy panel mounted above all tabs; opened/closed in UI |
| Private storage helpers | PASS (code/tests) | `storage.py`; upload non-overwrite, private bucket check |
| Local backup endpoint / script | PASS (tests) | Backend tests; see `BACKUP_RESTORE_REPORT.md` |

## 7. Risks and findings

### 7.1 Superseded — Cloudflare Pages per-asset limit exceeded

> **2026-11-08:** Cloudflare Pages is no longer the target. Vercel does not impose this per-file
> limit, so this finding is retained only as history for the fallback host.

`frontend/dist/assets/ort-wasm-simd-threaded.asyncify-*.wasm` is **26,861,777 bytes
(25.61 MiB)**. Cloudflare Pages rejects individual files above **25 MiB**. The build
otherwise succeeds (8 files, ~27 MB total).

Options (must be approved before implementation):

1. Serve the ONNX Runtime WASM from a pinned public CDN and exclude it from the Pages
   upload, keeping the application code unchanged.
2. Keep only the native browser speech path for English and use the backend Whisper
   endpoint for Tamil, removing the browser Whisper bundle.
3. Pin a Transformers.js version whose non-asyncify WASM asset is below 25 MiB.

Do not deploy the current `dist/` to Cloudflare Pages; the upload will fail.

### 7.2 Deferred — physical microphone acceptance is not verified

Voice is **disabled in production** for this release. The in-app browser reports microphone
permission `denied`; denial behaviour is verified. Real capture, English/Tamil/Tanglish spoken
intent, transcription display and digit accuracy remain `NOT TESTED` and require the user before
voice is re-enabled. See `VOICE_ACCEPTANCE_REPORT.md`.

### 7.3 High — Tamil speech quality is not production-grade

Recorded whisper.cpp benchmarks (`.runtime/speech-benchmark/`):

| Model | Utterance | Transcript | Assessment |
|---|---|---|---|
| base | Tamil sales | `இன்று விருப்பனையே வழவு.` | Wrong |
| base | Tamil customer | `புதிய கஷ்டோமர் செரிக்க வேண்டும்.` | Partly wrong |
| base | Tanglish sales | `இனைக்கும் செல்லாம்.` | Wrong |
| small | Tamil sales | `இன்று விர்ப்பனை எவ்வளவு` | Understandable, misspelled |
| small | Tamil customer | `புதிய காஸ்ட்டோமர் சேர்க்க வேண்டும்` | Correct intent |
| small | Tamil payment | `இந்த உதர்க்கு 500 ரூபாய் பேய்மன்த் திரும்பு` | Digits preserved, wording wrong |
| small | Tanglish sales | `இன்னுக்கு சேல்ஸ் எவ்வளவு` | Correct |

Spoken Tamil digits remain unreliable. The typed fallback and confirmation preview must
remain mandatory. Tamil TTS is unimplemented and unverified.

### 7.4 High — migration 0003 has not touched a production-schema copy

`0003` was applied twice successfully to a restored copy of the local PostgreSQL load
database, with no row-count or invoice-sequence change. It has **not** been applied to
production or to a Supabase Preview branch. The production schema may differ from the
SQLAlchemy-created copy (for example, `admin_sessions.expires_at` is `bigint` in SQL while
the SQLAlchemy model uses `Integer`; `created_at`/`order_date` are `text`).

### 7.5 Medium — duplicate unique indexes

Both the model and `0003` create unique indexes on `orders.create_request_id` and
`transactions.idempotency_key` (`ix_*` and `ux_*`). They are redundant. Drop one only
after confirming which name exists in production; do not drop blindly.

### 7.6 Medium — SQLite invoice fallback

On non-PostgreSQL databases the first invoice-number allocation uses
`Order.count()`, not the highest existing invoice suffix. It is safe for fresh local/test
databases but can collide after deletions or partial imports. This path never runs on
PostgreSQL. Documented, not changed during this audit.

### 7.7 Medium — security hardening gaps

- No Content-Security-Policy header (XSS defense relies on React escaping).
- JWT is stored in `localStorage`; any XSS becomes session theft. CSP is the main mitigation.
- General API routes have no per-route rate limit; only login (5 failures / 15 min) and voice
  (per-process in-memory window) are limited.
- Rate limits and inflight semaphores are per process, so multiple workers multiply limits.
- `Server-Timing` is exposed on every response (minor information leak).
- `customers.phone` is not unique at the database level; duplicate prevention is
  application-level and therefore racy under concurrent writes.
- Expired admin sessions remain in the table (407 expired, unrevoked rows in the
  restored copy). Reads filter them out; periodic pruning is recommended.

### 7.8 Medium — free-tier and hosting uncertainty (Vercel + Supabase)

- **Vercel Hobby is non-commercial-use only.** A commercial deployment requires Pro
  (~US$20/month), which conflicts with the ₹0 recurring-cost target. Owner decision required.
- Vercel **Services** is a Beta feature; the config validates but has not been deployed.
- No Vercel project, environment variables, domain or DNS exists in this environment.
- Supabase Free can pause after inactivity; a ₹0 backup destination independent of the Supabase
  project is not established.
- **Serverless connection budget is unverified.** The engine defaults to `pool_size=10` +
  `max_overflow=10` **per function instance**. Supabase Free/Supavisor connection limits can be
  exhausted as Vercel scales. Set conservative `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` values and load
  test the Preview; the transaction pooler would need `prepare_threshold=0`, which is not
  configured.
- The Oracle Always Free fallback remains capacity-dependent and was never provisioned.

### 7.9 Low — repository hygiene

- `frontend/dist/` is ignored; it currently contains the oversized WASM.
- `.runtime/` contains local PostgreSQL data, load dumps and speech models; it is ignored and
  must never be committed.
- Six deleted reports and one missing report create documentation drift.
- `.vscode/settings.json` now enables `.env` loading in the integrated terminal. This is a
  local convenience change; it does not affect runtime but increases accidental secret
  exposure on a shared machine.

## 8. Production blockers (ordered)

| # | Blocker | Type | Owner |
|---|---|---|---|
| 1 | Vercel deployment + environment provisioning (Vercel project, secrets) | Infrastructure | Engineer + account access |
| 2 | Vercel plan: Hobby is non-commercial; Pro needed for a business | Commercial | Owner |
| 3 | Physical microphone acceptance (voice re-enable only) | Manual | User |
| 4 | Production-schema migration `0003`/`0004` with a verified backup | Infrastructure | Engineer + credentials |
| 5 | Independent, restorable backup destination | Infrastructure | Owner decision |
| 6 | Staging/Preview environment (DB, storage, HTTPS) | Infrastructure | Engineer + account access |
| 7 | Tamil STT accuracy / TTS (voice re-enable only) | Product | Engineer + user acceptance |
| 8 | Domain and DNS | Infrastructure | Owner |
| 9 | Explicit production approval | Governance | Owner |

## 9. Recommended execution order

1. Create the Vercel project (Services), set the production secrets, and deploy a Preview build.
2. Verify `/api/health`, same-origin `/api` routing, security headers, login and one read-only page
   on the Preview URL.
3. Resolve the Vercel plan decision (Hobby non-commercial vs Pro) with the owner.
4. Rehearse `0003` + `0004` on a Supabase Preview/staging clone and test rollback.
5. Verify Supabase buckets, storage privacy and an independent, restorable backup.
6. Complete physical microphone acceptance only if voice will be re-enabled.
7. Point the domain/DNS at Vercel, re-run post-deploy verification, then obtain production approval.

## 10. Explicitly not done

- No production database query, migration, storage operation or deployment.
- No commit, reset, clean or destructive repository action.
- No paid service, plan, domain or model API was enabled or purchased.
- No deleted report was restored or overwritten.
- No claim of production readiness is made.

## 11. Final uncommitted-change classification

Reviewed on 2026-11-07 against `HEAD = f32a2fa`. Nothing is committed. Every changed file is
assigned to exactly one logical group; files that should **not** be committed without a separate
decision are called out.

### 11.1 Group A — customer-creation voice workflow (reviewed, tested)

| File | Change |
|---|---|
| `backend/voice_agent.py` | customer intent triggers (English/Tamil/Tanglish/transliterated), live field collection, pending-order precedence fix, preview/confirm flow |
| `backend/voice_tools.py` | live `CustomerCreate` required-field validation, duplicate detection, authenticated save, DB read-back, actual saved details in reply |
| `backend/main.py` | customer helper/validation wiring used by the voice tools; plus the invoice-sequence concurrency fix |
| `backend/tests/test_voice_intents.py` (new) | 93 intent tests incl. customer E2E, multilingual triggers, pending-order regressions |
| `backend/tests/test_voice_parsing.py` | date-dependent test made deterministic |
| `backend/tests/test_voice_providers.py` | whisper.cpp provider tests |
| `backend/voice_parsing.py` | Tamil/Tanglish normalisation, language detection, business-intent synonyms |
| `backend/voice_config.py` | whisper.cpp / STT timeout configuration |
| `backend/voice_providers.py` | self-hosted whisper.cpp adapter, no silent fallback |
| `.env.example` | documents the new voice provider variables |

### 11.2 Group B — microphone-denial fix (reviewed, tested)

| File | Change |
|---|---|
| `frontend/src/voice/browserSpeech.js` | end the session cleanly on permission denial; act on `track.onended`/errors |
| `frontend/src/voice/VoiceMicButton.jsx` | surface “Microphone permission was denied. Type the command instead.” and leave the listening state |
| `frontend/src/voice/browserSpeech.test.js` | regression test for denial |
| `frontend/src/VoiceAssistantPanel.jsx` | floating-panel behaviour and language persistence |
| `frontend/.env.example` | documents the optional server Tamil mode (fixed dangling `DEPLOYMENT_GUIDE.md` reference) |

### 11.3 Group C — dashboard/finance performance (reviewed; not part of the voice fix)

| File | Change |
|---|---|
| `frontend/src/App.jsx` | lazy `FinanceCharts`, per-tab loading, dashboard summary |
| `frontend/src/FinanceCharts.jsx` (new) | extracted charts component |
| `backend/main.py` | `Server-Timing`, dashboard/finance aggregate queries (same file as Group A) |
| `backend/migrations/0004_read_path_indexes.sql` (new) | read-path indexes, manual/`CONCURRENTLY` |

These are coherent but should be reviewed and committed separately from the voice fix.

### 11.4 Group D — security and deployment documentation (reviewed)

| File | Change |
|---|---|
| `backend/requirements.txt` | `python-multipart` 0.0.9 → 0.0.33 (verified advisories fixed) |
| `deploy/Dockerfile` | health check now uses the real public `/api/health` route (was a stale comment/openapi) |
| `deploy/backend.env.example` | corrected `VOICE_STT_PROVIDER` to a valid value (`local`) |
| `deploy/oracle-always-free.md` | removed the false “within per-file limits” claim; records the 25 MiB failure |
| `*.md` (20 reports/runbooks) | audit evidence and plans |

### 11.5 Group E — local convenience, exclude from product commits

| File | Why excluded |
|---|---|
| `.vscode/settings.json` | enables `.env` loading in the integrated terminal; local convenience only, increases accidental secret exposure on a shared machine |

### 11.6 Deletions — do not commit without owner review

`CLOUDFLARE_COMPATIBILITY.md`, `DEPLOYMENT_READINESS_REPORT.md`, `FINAL_ACCEPTANCE_REPORT.md`,
`IMPLEMENTATION_STATUS.md`, `VOICE_ASSISTANT.md`, `VOICE_ASSISTANT_AUDIT_AND_SETUP.md` are deleted
in the working tree. The replacement content is in the new reports, but the deletion itself is the
owner's call.

### 11.7 Proposed commit sequence (not executed)

1. **`security: upgrade python-multipart to 0.0.33`**
   `backend/requirements.txt`
2. **`fix(voice): customer creation workflow + multilingual intents`**
   `backend/voice_agent.py`, `backend/voice_tools.py`, `backend/voice_config.py`,
   `backend/voice_parsing.py`, `backend/voice_providers.py`, `backend/tests/test_voice_intents.py`,
   `backend/tests/test_voice_parsing.py`, `backend/tests/test_voice_providers.py`, `.env.example`
3. **`fix(invoice): avoid duplicate allocation under concurrency`**
   `backend/main.py` (invoice-sequence change only; separate hunk from Group C)
4. **`fix(voice): handle microphone permission denial`**
   `frontend/src/voice/browserSpeech.js`, `frontend/src/voice/VoiceMicButton.jsx`,
   `frontend/src/voice/browserSpeech.test.js`, `frontend/src/VoiceAssistantPanel.jsx`,
   `frontend/.env.example`
5. **`perf(dashboard): lazy charts and aggregate queries`**
   `frontend/src/App.jsx`, `frontend/src/FinanceCharts.jsx`,
   `backend/migrations/0004_read_path_indexes.sql`, relevant `backend/main.py` hunks
6. **`docs: deployment readiness reports`**
   all new report `.md` files, `deploy/Dockerfile`, `deploy/backend.env.example`,
   `deploy/oracle-always-free.md`

Verification before any commit: backend **150 passed**, frontend **19 passed**, production build
passes, `pip check` clean. Commit 3 and commit 5 touch the same file (`backend/main.py`); they
must be staged by hunk, not as a whole file.

### 11.8 Owner decisions applied after the audit

- **Frontend + API hosting: Vercel.** `vercel.json` defines a `web` Vite service and an `api`
  Python 3.12 ASGI service; `/api` rewrites are ordered before the SPA catch-all. The config
  validates against the published Vercel schema (draft-04, 2026-11-08), but nothing was deployed.
- **Voice disabled in production:** `VITE_VOICE_ENABLED=false` via `frontend/.env.production`.
  The lazy voice/WASM chunks remain in `dist` but `index.html` does not preload them.
- **Lean serverless dependencies:** `backend/requirements-vercel.txt` omits `faster-whisper` and
  `pytest`; the serverless path also returns a clear `503` from `/api/backup` when storage is
  unconfigured.
- **Oracle/Caddy is now a fallback**, not the selected production host.
- No commit was created. These decisions are documented, not deployed.

### 11.9 Changes that appeared outside this audit (not mine — do not commit with this work)

These were already present in the working tree and belong to separate local work
(`PRELAUNCH_AUDIT.md`). They are **not** part of the voice/deployment change set and must not be
swept into the proposed commits:

| File | Change | Owner |
|---|---|---|
| `frontend/src/index.css` | mobile sidebar/tap-target layout | separate pre-launch work |
| `vercel.json` | Vercel Services config (web + api, rewrites, security headers) | **now the selected deployment target** (was fallback) |
| `frontend/public/robots.txt` (new) | disallow indexing of the admin app | separate pre-launch work |
| `PRELAUNCH_AUDIT.md` (new) | separate pre-launch audit | separate pre-launch work |
| `.vscode/settings.json` | editor convenience | exclude from product commits |

Note: `vercel.json` and the Oracle/Caddy path are **alternative** hosting targets. The owner has
selected Vercel; the Oracle/Caddy files remain as a fallback and are not a deployment claim.

### 11.10 Commit status

**No commit was created.** Approval is required before any commit. If approval is given, use the
sequence in §11.7 and **exclude** the six deleted reports, `.vscode/settings.json`, and every
file in §11.9.
