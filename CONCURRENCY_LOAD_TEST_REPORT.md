# Concurrency & Load Test Report

**Date:** 2026-11-07
**Environment:** isolated backend `127.0.0.1:8010`, single Uvicorn worker, isolated
PostgreSQL 17.10 at `127.0.0.1:55433` (database `perf_20261107`)
**Harness:** `backend/scripts/load_test_100.py`
**Production touched:** none
**Status:** **PASS** after a verified invoice-allocation fix; single-host capacity ceiling noted.

## 1. Method

Each stage logged in a burst of N users, then ran mixed authenticated traffic for ~30 s with
think time 0.5–1.5 s. Operations: list customers/orders/products/templates, finance summary,
finance CSV, order create, balance payment, invoice PDF, voice turn, plus setup customers.
One idempotency-replay probe ran at the end of each stage. CPU/RSS were sampled from the server
PID every 2 s.

Stages were run twice:

- **Before the fix:** 5, 10, 25, 50 users.
- **After the fix:** 25, 50, 100 users.

## 2. Defect found: duplicate invoice allocation under concurrency

The pre-fix 25- and 50-user stages returned `409 Invoice or order request conflicts with an
existing record`:

| Stage | 200 | 409 | Orders created |
|---|---|---|---|
| 25 users (pre-fix) | 195 | 1 | 75 |
| 50 users (pre-fix) | 312 | 4 | 124 |

Cause: `next_invoice_number()` used
`GREATEST(invoice_sequences.next_number, EXCLUDED.next_number)`. `EXCLUDED.next_number` is
computed from the statement snapshot, so two concurrent first-time callers could compute the same
value and be handed the same invoice number. The unique index on `orders.invoice_number` then
rejected the loser with a 409.

Fix: `GREATEST(invoice_sequences.next_number + 1, EXCLUDED.next_number)`. The locked row is always
advanced by one, while the `EXCLUDED` term still allows the post-import resync to jump the
sequence ahead of existing orders. Full backend suite: **150 passed**.

## 3. Post-fix results

### 3.1 Throughput, errors and resources

| Users | Requests | Throughput | 200 | 409 | Server 5xx | 503 | Max CPU | Max RSS |
|---|---|---|---|---|---|---|---|---|
| 25 | 783 | 25.0 rps | 783 | 0 | 0 | 0 | 668% | 115 MB |
| 50 | 1,546 | 49.6 rps | 1,546 | 0 | 0 | 0 | 767% | 120 MB |
| 100 | 3,009 | 95.7 rps | 2,954 | 0 | 0 | 0 | 475% | 120 MB |

At 100 users there were **55 HTTP 429** responses, all from the intentional voice rate limit
(`VOICE_MAX_REQUESTS_PER_WINDOW=120` per 10 minutes per admin/IP). They are not errors; the load
script counts them separately as `voice_turns_rate_limited`.

### 3.2 Latency (all requests)

| Users | p50 | p95 | p99 | max | mean |
|---|---|---|---|---|---|
| 25 | 15.8 ms | 49.4 ms | 870 ms | 1,047 ms | 45 ms |
| 50 | 14.4 ms | 40.5 ms | 1,844 ms | 2,162 ms | 63 ms |
| 100 | 32.0 ms | 629 ms | 4,117 ms | 5,345 ms | 168 ms |

The p99/max spikes are dominated by the login burst (PBKDF2-SHA256, 600,000 rounds) and by the
single worker saturating at 100 users. Non-login operations stayed fast.

### 3.3 Per-operation latency at 50 and 100 users (ms)

| Operation | 50 p50 / p95 / p99 | 100 p50 / p95 / p99 |
|---|---|---|
| customers_list | 11.1 / 28.8 / 38.5 | 27.4 / 137.6 / 703.5 |
| orders_list | 19.3 / 38.8 / 54.6 | 37.2 / 191.9 / 759.1 |
| finance | 11.1 / 24.5 / 30.1 | 27.1 / 157.6 / 624.3 |
| finance_csv | 7.4 / 21.8 / 31.5 | 22.1 / 127.1 / 834.7 |
| order_create | 12.5 / 34.7 / 42.9 | 34.3 / 247.6 / 689.0 |
| order_pay | 9.8 / 28.5 / 58.5 | 24.5 / 128.4 / 192.5 |
| invoice_pdf | 33.4 / 51.8 / 52.3 | 51.2 / 130.8 / 150.8 |
| voice_turn | 11.9 / 29.7 / 36.8 | 58.0 / 1,096 / 1,426 |
| login | 1,671 / 2,146 / 2,162 | 3,148 / 5,332 / 5,342 |

### 3.4 Idempotency and data integrity

Every stage's idempotency probe returned `200`, the **same order id**, and
`idempotent_replay: true`; order count did not change.

Final database checks after all stages:

| Check | Result |
|---|---|
| Orders | 718 |
| Distinct invoice numbers | 718 |
| Null invoice numbers | 0 |
| Duplicate invoice numbers | 0 |
| Duplicate `create_request_id` | 0 |
| Duplicate transaction `idempotency_key` | 0 |
| Balance mismatches | 0 |
| Invoice suffix range | 1–718 (contiguous) |

## 4. Interpretation

- At 25 and 50 users the single instance is healthy: p95 under 50 ms and zero errors.
- At 100 users the single worker saturates; median stays low but tail latency rises sharply and
  the login burst consumes most of the wait. This is a **capacity ceiling**, not a correctness
  failure.
- Login is the expensive operation by design (PBKDF2 600k rounds). It should be rate-limited and
  not used as a throughput benchmark.
- Memory is small and stable (~85–120 MB RSS); no leak was observed in 30-second stages.
- CPU above 100% is expected because FastAPI runs synchronous endpoints in a thread pool and the
  PostgreSQL driver uses threads.

## 5. Limitations (honest)

- 30-second stages, one host, local PostgreSQL, synthetic data. **Not a production benchmark.**
- Single Uvicorn worker. A production deployment behind a proxy should use multiple workers or
  multiple instances, with a shared PostgreSQL connection pooler.
- 100 users is the largest stage; behaviour beyond that is untested.
- The voice rate limit intentionally sheds load at 100 users; that is expected, not a bug.
- No network latency, TLS, Supabase pooler or Cloudflare hop was included.
- No sustained soak test (hours) was run.

## 6. Verdict

**Concurrency correctness: PASS.** Invoice numbers, idempotency keys and balances remained unique
and consistent under 25/50/100 concurrent users after the fix.
**Capacity at 100 users on one worker: limited by login hashing and single-process CPU; plan for
multiple workers/pooler and caching before claiming production throughput.**
