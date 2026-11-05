# Final Acceptance Report — Lalitha's Apparel

**Date:** 5 November 2026 (Asia/Kolkata)

**Repository:** `/Users/abisheekkj/Documents/embroidery-management`

**Code baseline:** `fae7020` plus the verification/hardening changes recorded in this report

**Scope:** end-to-end verification of the existing application and browser voice assistant, production-like concurrency testing with 100 simultaneous users, restart/recovery, backup/restore, migration `0003`, and browser workflow testing.
**Verdict:** **Application is test-verified for the tested workflows. Production deployment is NOT signed off.** No infrastructure was provisioned, no production database was touched, migration `0003` is not applied to production, and browser microphone capture plus Tamil browser TTS remain unverified.

No production data, production credentials, paid service, or destructive production action was used. All load data lived in a local PostgreSQL 17.10 development database.

---

## 1. Executive summary

| Question | Answer |
| --- | --- |
| Does the app work end to end? | **Yes for the tested workflows.** Login, dashboard, orders, new order with 9 measurements, PDF invoice, typed voice, and typed voice confirmation all passed in a real Chromium browser. |
| Does it survive 100 simultaneous users? | **Yes.** 5,298 requests at 57.5 req/s with **0 server errors**, 100/100 voice turns, and 477 orders created in the realistic run. |
| Does it degrade safely under overload? | **Yes.** 4,648 requests at 101 req/s with **0 errors**; 80 requests received the intended `429` voice rate limit and the server stayed healthy. |
| Is data consistent under concurrency? | **Yes.** 904 orders checked: 0 duplicate invoices, 0 duplicate idempotency keys, 0 overpayments, 0 ledger mismatches, 0 orphan rows. |
| Does it recover after restart? | **Yes.** Existing token, existing order, invoice sequence, and voice turns all survived a process restart. |
| Can the database be backed up and restored? | **Yes.** All six tested tables matched after restore, and the restored database accepted a new order. |
| Is migration `0003` safe on a populated database? | **Yes on the local clone.** It created the expected 3 tables/columns sets and 3 indexes and seeded the invoice counter correctly. |
| Can it go live tomorrow? | **Not without deployment credentials/infrastructure and owner approval.** See §10. |

**Go/no-go:** the code is ready to package; the release is blocked on deployment access, production migration approval, and the voice limitations in §7.

---

## 2. What changed during this verification

These changes fix genuine defects found during load, security, and edge-case testing. They are not a rewrite.

### 2.1 Correctness and security hardening (`backend/main.py`)

- ISO date validation for orders, delivery dates, transactions, and finance query dates.
- Finite, non-negative, bounded validation for money and numeric fields; `Infinity`/`NaN` now returns a clean `422`, not a `500`.
- Non-blank and length validation for customers, products, templates, rates, measurements, and transactions.
- Duplicate product/template names now return `409` instead of creating ambiguous records.
- Customer deletion cascade fixed by flushing child changes before deleting the customer.
- CSV formula-injection escaping in finance exports.
- `/api/health` readiness endpoint.
- Security headers on API responses.
- Sanitised validation errors so rejected input is serialisable.

### 2.2 Performance and load behaviour

- Removed per-row N+1 queries from customer and order listings; related rows are fetched in bulk.
- Configurable database pool: `DB_POOL_SIZE=10`, `DB_MAX_OVERFLOW=10`, `DB_POOL_TIMEOUT=5`, `pool_recycle=1800`, `pool_use_lifo=True`.
- Bounded admission control (`MAX_INFLIGHT_REQUESTS=20`, `INFLIGHT_WAIT_SECONDS=10`) returning retryable `503` with `Retry-After` under overload.
- Database-pool timeout returns retryable `503`, not an opaque `500`.
- Finance CSV/PDF exports changed from streaming to completed responses so DB sessions close promptly.
- `uvicorn` keep-alive raised from the 5-second default to 75 seconds in `deploy/Dockerfile`. The first load run produced 2 client `ReadError`s on voice POSTs because uvicorn closed an idle connection exactly as the client reused it; the final run after this change had **0 errors**.

### 2.3 New regression coverage

- `backend/tests/test_release_hardening.py`: 19 edge/security cases.
- `backend/scripts/load_test_100.py`: configurable 100-user mixed-workload generator with JSON reporting.
- `frontend/vite.config.js`: production builds now fail fast if `VITE_API_BASE_URL` is missing, preventing a release that silently points at `undefined`.
- Full backend suite is now **47 passed** (was 28).

No database schema change was made by these fixes; migration `0003` remains the production schema requirement.

---

## 3. Automated test results

| Suite | Result | Evidence |
| --- | --- | --- |
| Backend `pytest` | **47 passed** | `verification/backend-tests.txt` |
| Frontend `npm test` | **17 passed** | `verification/frontend-tests.txt` |
| Frontend production build | **passed** with an explicit API URL; fails fast without it | `verification/frontend-build.txt` |
| Browser workflow smoke | **passed**, 0 console errors, 0 page errors, 0 failed requests | `verification/browser-smoke.json` |

The configured build used `VITE_API_BASE_URL=https://api.lalithas.example/api`; that string is present in the emitted bundle. A build without `VITE_API_BASE_URL` now exits with a clear error instead of producing a broken app. The build retains only the existing chunk-size warning.

---

## 4. 100-concurrent-user load test

### 4.1 Environment

| Item | Value |
| --- | --- |
| Backend | FastAPI/uvicorn, **one worker**, `APP_ENV=production` |
| Database | local PostgreSQL 17.10, `embroidery_load` |
| Client | 100 concurrent async clients, separate authenticated tokens |
| Workload | login burst, customer/order/product/template/finance reads, CSV export, PDF invoice, order create, payment, voice turn |
| Think time | 1.0–2.5 s between operations |
| Duration | 92.15 s |

This is a production-like topology, **not Supabase**. Supabase latency, connection limits, and pooler behaviour remain unverified (§10).

### 4.2 Realistic run — passed

| Metric | Result |
| --- | --- |
| Total requests | **5,298** |
| Throughput | **57.5 req/s** |
| Success | **5,298 × HTTP 200** |
| Server errors | **0** |
| Overload rejections (`503`) | **0** |
| Voice turns | **100/100 succeeded** |
| Orders created | **477** |

| Latency | Value |
| --- | --- |
| p50 | 15.85 ms |
| p95 | 52.24 ms |
| p99 | 2.21 s (dominated by the 100-login burst) |
| max | 3.76 s |

Per-operation p95:

| Operation | Count | p50 | p95 | Max |
| --- | ---: | ---: | ---: | ---: |
| Customer list | 1,121 | 14.1 ms | 36.3 ms | 162.9 ms |
| Orders list | 1,433 | 20.1 ms | 45.6 ms | 216.8 ms |
| Order create | 477 | 12.5 ms | 45.6 ms | 247.1 ms |
| Order payment | 276 | 11.5 ms | 34.9 ms | 238.3 ms |
| Finance | 582 | 12.8 ms | 38.9 ms | 166.1 ms |
| Finance CSV | 312 | 7.5 ms | 29.2 ms | 152.6 ms |
| Invoice PDF | 163 | 37.3 ms | 67.8 ms | 239.4 ms |
| Voice turn | 100 | 38.9 ms | 146.2 ms | 277.9 ms |
| Login (100 simultaneous) | 101 | 2.27 s | 3.74 s | 3.76 s |

The login burst is intentional PBKDF2 work (`600_000` rounds). A normal browser login completed in **282 ms**; the multi-second figure is 100 simultaneous password hashes competing for CPU, not a database problem.

Evidence: `verification/load-100-realistic.json`

### 4.3 Aggressive overload run — passed

100 users, 45 s, 0.02–0.08 s think time:

| Metric | Result |
| --- | --- |
| Total requests | **4,648** |
| Throughput | **101.1 req/s** |
| Success | **4,568 × HTTP 200** |
| Intended voice rate limit | **80 × HTTP 429** |
| Server errors / timeouts / `503` | **0** |
| Voice turns | 20 succeeded, 80 rate-limited |
| Orders created | 413 |
| p50 / p95 / max | 914.7 ms / 1.18 s / 4.79 s |

The server stayed healthy and responsive. The `429`s are the configured voice limit (`120 requests / 10 minutes` per admin + IP), not failures.

Evidence: `verification/load-100-overload.json`

### 4.4 Database integrity after concurrency

Final snapshot: **904 orders**, 508 payment transactions, ₹152,400 collected.

| Check | Result |
| --- | ---: |
| Duplicate invoice numbers | **0** |
| Duplicate create-request/idempotency keys | **0** |
| Duplicate transaction idempotency keys | **0** |
| Orders missing an invoice number | **0** |
| Negative transaction amounts | **0** |
| Overpaid orders | **0** |
| Negative balances | **0** |
| Balance ≠ total − paid | **0** |
| Total ≠ base + extra | **0** |
| Ledger total ≠ paid amount | **0** |
| Orphan measurements | **0** |
| Orphan customer foreign keys | **0** |

Evidence: `verification/db-integrity.json`

---

## 5. Restart, backup/restore, and migration

### 5.1 Restart recovery — passed

Process was stopped and started again against the same database:

- `/api/health` → `200 {"status":"ok"}`
- Token issued before restart still accepted.
- Order `INV-2026-891` still present.
- Invoice numbering continued with `INV-2026-892`.
- Voice turn after restart succeeded (`200`, 20 pending orders).

Evidence: `verification/restart-recovery.json`

### 5.2 PostgreSQL backup/restore — passed

- `pg_dump -Fc` produced a 154 KB dump.
- `pg_restore` into a fresh database succeeded.
- Row counts matched exactly: customers 122, products 14, templates 7, orders 892, measurements 8,028, transactions 508.
- The application started against the restored database, logged in, confirmed 892 restored orders, and created `INV-2026-893`.

Evidence: `verification/backup-restore.json`

### 5.3 Migration `0003` on a populated clone — passed

To avoid relying on an old result, the populated dev database was cloned, then exactly the objects added by migration `0003` were removed. Pre-migration state: no `admin_sessions`, no `invoice_sequences`, 0 new order columns, 0 transaction idempotency column, max invoice `INV-2026-892`.

Applying `backend/migrations/0003_session_invoice_snapshots_and_idempotency.sql`:

- created `admin_sessions` and `invoice_sequences`;
- added both new `orders` columns and the transaction idempotency column;
- created all 3 indexes;
- seeded `invoice_sequences` to `2026 → 893`.

The real application then created `INV-2026-893`; replaying the same request returned the same order with `idempotent_replay: true` and created no duplicate.

Evidence: `verification/migration-0003.json`

**This was a local development clone, not production Supabase.**

---

## 6. Browser workflow verification (real Chromium)

The frontend was served by Vite and pointed at the production-like backend. Screenshots are in `verification/screenshots/`.

| Step | Result |
| --- | --- |
| Login page and login | Passed; token stored; no console errors |
| Dashboard | Passed; income, outstanding, attention, production sections render |
| Orders list | Passed; 100 rows rendered; invoice, customer, amounts, status, actions present |
| New order | Passed; 9 measurement fields; order `INV-2026-902` created |
| PDF invoice | Passed; endpoint returned `application/pdf`; browser-context fetch returned **47,082 bytes, `%PDF-`** |
| Typed voice query | Passed; pending-order reply rendered; no error alert |
| Multi-turn typed voice order | Passed; amount → delivery date → preview → confirm; `INV-2026-903` created |
| Confirmation phrase guard | Passed; wrong phrase and wrong amount both `422`; exact phrase created; replay did not duplicate |
| Mobile 390 × 844 | Passed; no horizontal overflow; navigation visible |

Headless Chromium cannot render the PDF viewer after navigation to a `blob:` URL, so the test verifies the popup opens plus the actual PDF response bytes and `%PDF-` magic. This is not a product defect.

Evidence: `verification/browser-smoke.json`, `verification/voice-confirmation-guard.json`

---

## 7. Voice assistant verification

### 7.1 Browser microphone — blocked, not verified

The automated browser denies microphone permission. The UI correctly falls back to typed input. **No claim is made that `getUserMedia` capture works in this environment.** This must be tested manually in a real browser with granted permission before launch if microphone use is required.

### 7.2 Speech recognition (from the 31 October acoustic test; unchanged code path)

| Case | Result |
| --- | --- |
| English browser STT | Exact transcript; usable |
| Tamil browser STT | Word substitution; ~15 s warm for a 5.5 s clip; **not production-acceptable** |
| Mixed Tamil/English STT | Garbage or mangled; **unreliable** |

The deterministic **typed** parser accepts English, Tamil, and Tanglish text and is covered by backend tests. Spoken Tamil/mixed input should not be advertised as working.

### 7.3 Browser text-to-speech

| Case | Result |
| --- | --- |
| English `Rishi` (`en-IN`) | Audible and normal |
| Tamil `Vani` (`ta-IN`) | Silent/aborted in `speechSynthesis`; **not verified** |

No local Tamil TTS has been integrated. Do not promise spoken Tamil replies.

### 7.4 Safety behaviour

- Write actions produce a server-prepared preview.
- A bare “yes” is not accepted as confirmation.
- Wrong phrase and wrong amount are rejected with `422` and no write.
- Replaying a completed confirmation does not duplicate the order or payment.
- Conversation state is process-local, which is why production deliberately uses one uvicorn worker.

---

## 8. Security and privacy checks

| Check | Result |
| --- | --- |
| Business API routes require signed, expiring admin tokens | Verified by tests and live `401`s |
| Wrong confirmation phrase rejected | `422`; no write |
| Duplicate confirmation replay | No duplicate write |
| Cancelled pending operation | No write |
| CORS restricted to configured origins | Verified: `localhost:5180` allowed; `*` not used |
| Security headers | Present (`nosniff`, `DENY`, referrer policy, permissions policy) |
| Login throttling and password hash upgrade | Covered by tests |
| Audio/transcript retention | Browser-local by design; backend receives text only |
| Secrets in repository | `.env` ignored; deployment files contain placeholders |
| Invoice privacy | Generated in memory; no permanent PDF object in the tested path |

Residual risks:

- Login throttling, voice rate limits, and conversation state are process-local. Scaling to multiple workers requires shared state.
- The Supabase service-role key must never appear in a `VITE_` variable or frontend asset.
- The load test used one admin identity with 100 sessions. A future multi-admin rollout should re-test with distinct accounts.

---

## 9. Free-tier deployment position

Target: Cloudflare Pages Free (frontend) + Oracle Cloud Always Free ARM64 (FastAPI) + Supabase Free (PostgreSQL/Storage) + Let's Encrypt via Caddy. **Expected recurring cost: ₹0.**

| Item | Free allowance / limit | Risk |
| --- | --- | --- |
| Cloudflare Pages Free | Static hosting, build/bandwidth quotas | No paid add-ons; Pages domain |
| Oracle Ampere A1 Always Free | ~2 OCPU / 12 GB within documented monthly limits; 200 GB volume; 10 TB egress | Capacity shortages, **idle reclamation**, no SLA |
| Supabase Free | 500 MB DB, 1 GB Storage, ~5 GB egress, 2 projects | Pauses after ~7 days inactivity; no automated backups/support |
| Let's Encrypt via Caddy | Free certificates | Requires a DNS name you control |
| Hugging Face model weights | Public, browser-cached | Large first download; user bandwidth |
| Vercel Hobby / paid APIs | **not used** | Hobby is non-commercial; a paid plan would be required |

The backend image excludes optional `faster-whisper`, keeping it smaller and avoiding a native ML stack on the free host. ARM64 wheel compatibility was previously checked; **no ARM64 boot or Docker build has been executed** because the local Docker daemon is unavailable.

---

## 10. Deployment status and blockers

### 10.1 Prepared but not deployed

| Artifact | Purpose |
| --- | --- |
| `deploy/Dockerfile` | CPython 3.12-slim production image; keep-alive 75 s; non-root user |
| `deploy/docker-compose.yml` | Backend behind Caddy; API bound to loopback only |
| `deploy/Caddyfile.example` | TLS and security headers |
| `deploy/backend.env.example` | Production environment placeholders, Supabase session pooler |
| `deploy/embroidery-backend.service` | systemd unit for Compose |
| `deploy/oracle-always-free.md` | Full zero-cost runbook and migration steps |

### 10.2 Hard blockers — cannot be completed from this machine

1. **No Cloudflare account/API token** — Pages project cannot be created or deployed.
2. **No Oracle Cloud tenancy, SSH key, or instance** — backend cannot be provisioned or started.
3. **No production Supabase credentials or verified production backup** — migration `0003` cannot be applied safely.
4. **No owner approval** for the production migration and deployment window.
5. **Real microphone permission** cannot be granted to the automated browser, so microphone capture is not verified.
6. **Tamil browser TTS** remains silent, and Tamil/mixed spoken STT remains unreliable.
7. **Docker/ARM64 build** was not executed locally (Docker daemon not running).

### 10.3 What “live tomorrow” requires

To actually release, the owner must provide or approve:

1. Cloudflare account access/token and the production Pages origin.
2. Oracle Cloud tenancy/SSH access or an equivalent Python host.
3. Production Supabase connection string, service-role key, and a verified backup.
4. Explicit approval to apply migration `0003` to production after that backup.
5. A DNS name for TLS and the final `FRONTEND_ORIGIN` value.
6. A decision on voice scope: typed voice only, or accept that microphone/Tamil TTS are not verified.

After those are available, the deployment runbook in `deploy/oracle-always-free.md` can be executed, followed by a deployed smoke test (login, order, payment, PDF, CORS, TLS, voice, restore check).

---

## 11. Status matrix

| Capability | Implemented | Tested | Deployed |
| --- | --- | --- | --- |
| Billing/order/payment/invoice app | Yes | Yes (47 backend, 17 frontend, build) | **No** |
| 100 concurrent users, realistic workload | Yes | **Yes (0 errors, 5,298 requests)** | No |
| Overload behaviour | Yes | **Yes (0 errors, 80 intended 429s)** | No |
| Data integrity under concurrency | Yes | **Yes (904 orders, all checks zero)** | No |
| Restart recovery | Yes | **Yes** | No |
| PostgreSQL backup/restore | Yes | **Yes** | No |
| Migration `0003` on populated dev clone | Yes | **Yes** | Dev only |
| Migration `0003` on production | No | No | **No** |
| Browser login/dashboard/orders/new order/PDF | Yes | **Yes (Chromium)** | No |
| Typed voice query and confirmed order | Yes | **Yes (Chromium)** | No |
| Confirmation-phrase guard and replay protection | Yes | **Yes** | No |
| Browser microphone capture | Yes | **No (permission denied)** | No |
| Browser-local English STT | Yes | Yes (prior acoustic test) | No |
| Browser-local Tamil STT | Yes | **Partial/unreliable** | No |
| Mixed Tamil/English spoken input | Yes | **No** | No |
| English browser TTS | Yes | Yes | No |
| Tamil browser TTS (`Vani`) | Yes | **No (silent/aborted)** | No |
| Cloudflare Pages frontend | Prepared | Build only | **No** |
| Oracle Always Free backend | Prepared | Wheel compatibility only | **No** |

---

## 12. Final verdict

The application survived a realistic 100-user test and an aggressive overload test without server errors, preserved data integrity, recovered cleanly from a restart, restored from a real `pg_dump`, and applied migration `0003` correctly on a populated clone. The main browser workflows and the typed voice confirmation flow passed in Chromium.

**Production is not signed off** because deployment has not happened, production migration has not been applied, and microphone/Tamil voice paths are unverified or unreliable. Nothing in this report should be read as a claim that the app is already live.

**Release decision:** code-ready, infrastructure-blocked. Do not tell real users the service is live until §10.3 is completed and a deployed smoke test passes.
