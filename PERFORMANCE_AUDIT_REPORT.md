# Performance Audit Report

**Date:** 2026-11-07
**Scope:** frontend bundle, backend request paths, database indexes, and measured load behaviour
**Production touched:** none
**Status:** backend **PASS** at 25–50 users on one worker; frontend **BLOCKED** for Cloudflare
Pages by one oversized asset.

## 1. Frontend build

Command: `VITE_API_BASE_URL=https://api.example.com/api npm run build` — **build succeeds**.

| Asset | Raw size | Gzip |
|---|---|---|
| `ort-wasm-simd-threaded.asyncify-*.wasm` | **26,861,777 B (25.61 MiB)** | n/a |
| `transformers.web-*.js` | 598,684 B | 173.6 kB |
| `FinanceCharts-*.js` (lazy) | 429,518 B | 114.3 kB |
| `index-*.js` | 215,241 B | 62.8 kB |
| `VoiceAssistantPanel-*.js` (lazy) | 49,066 B | 14.4 kB |
| `index-*.css` | 30,682 B | 6.5 kB |
| `lalithas-apparel-logo.png` | 204,989 B | n/a |
| **Total dist** | **~27 MB / 8 files** | |

Positive findings already in place:

- `App.jsx` lazy-loads the voice panel and the finance charts, so first paint does not download
  Recharts or the assistant until needed.
- Tab data loads per-tab rather than all at once.
- React 18, Vite 5 with production minification.

Critical finding:

- **Cloudflare Pages rejects individual files over 25 MiB.** The ORT asyncify WASM is 25.61 MiB,
  so `wrangler pages deploy dist` will fail. See
  `CLOUDFLARE_DEPLOYMENT_COMPATIBILITY.md` for options. **Do not deploy this `dist/`.**

## 2. Backend architecture and request cost

- FastAPI 0.115 + synchronous SQLAlchemy 2.0. Synchronous endpoints run in Starlette's thread
  pool, which is why CPU can exceed 100% on a multi-core host.
- Single Uvicorn worker in the test. Connection pool `DB_POOL_SIZE=10`,
  `DB_MAX_OVERFLOW=10`.
- Response compression is not configured in the app; a reverse proxy should gzip/brotli JSON.
- `Server-Timing` is emitted on responses (useful, minor information exposure).
- Finance endpoints aggregate in Python after loading rows; at 718 orders this is fast, but it
  will not scale indefinitely. The load test measured `finance` p95 24 ms at 50 users and
  158 ms at 100 users.
- CSV export builds the file in memory; fine at current scale.
- Invoice PDF generation is ~30–52 ms per document (in memory, no storage round-trip).
- Login uses PBKDF2-SHA256 with 600,000 rounds. This is deliberately expensive: ~0.8 s alone,
  ~1.7 s p50 and 2.1 s p95 under a 50-user login burst, ~3.1 s p50 at 100. This is the dominant
  tail-latency source and must not be tuned down without a security review.

## 3. Database performance changes

Migration `0004_read_path_indexes.sql` adds six indexes matching the hot read paths
(customer history, order-date lists, pending balances, measurements by order, finance by date,
income by date). All are `CONCURRENTLY`. The audit copy showed the expected plans improved and
no data change.

Remaining index gaps (low priority): `orders.product_id`,
`products.measurement_template_id`, `measurement_fields.template_id`.

## 4. Measured load (isolated, single worker)

Full detail in `CONCURRENCY_LOAD_TEST_REPORT.md`. Summary:

| Users | Throughput | p50 | p95 | 5xx | 409 |
|---|---|---|---|---|---|
| 25 | 25.0 rps | 15.8 ms | 49.4 ms | 0 | 0 |
| 50 | 49.6 rps | 14.4 ms | 40.5 ms | 0 | 0 |
| 100 | 95.7 rps | 32.0 ms | 629 ms | 0 | 0 |

- Zero server errors at every stage.
- 100 users saturates one worker; tail latency is dominated by login hashing.
- Memory stayed ~85–120 MB RSS; no leak observed in 30-second stages.
- 55 voice 429s at 100 users are the intentional rate limit, not failures.

## 5. Verified performance defect fixed

Concurrent order creation returned 1–4 `409`s per 25/50-user stage because two callers could be
allocated the same invoice number. Fixed in `next_invoice_number()` by advancing the locked
sequence row (`GREATEST(current + 1, EXCLUDED)`). Post-fix: 0 conflicts at 25/50/100 users and
718/718 distinct invoice numbers.

## 6. Recommendations (not yet implemented)

1. **Resolve the Cloudflare asset limit** before any Pages deployment. Options and trade-offs are
   in `CLOUDFLARE_DEPLOYMENT_COMPATIBILITY.md`.
2. **Run multiple workers/instances** behind the proxy and use a PostgreSQL pooler (Supabase
   Supavisor) for production; the current single worker is the capacity ceiling.
3. **Cache/revalidate** customer and product lists on the client; they are re-fetched often.
4. **Move finance aggregation into SQL** (`SUM`/`GROUP BY`) if order volume grows into the tens
   of thousands.
5. **Enable compression and long-lived immutable caching** for hashed assets at the CDN/proxy.
6. **Prune expired sessions** so the sessions table does not grow unbounded.
7. **Avoid logging `Server-Timing` values** if the deployment is public and timing is sensitive.
8. **Do not lower PBKDF2 rounds** for performance; instead rate-limit and keep login off the
   hot path.

## 7. Verdict

**Backend performance at small-business concurrency: PASS (measured).**
**Frontend production bundle for Cloudflare Pages: FAIL (one 25.61 MiB asset over the 25 MiB
limit).**
**Production capacity/soak testing: NOT TESTED.**

## 8. Lighthouse follow-up (2026-11-10)

The attached Lighthouse JSON was captured from `http://localhost:5173/` using
the Vite development server. Its 18.4 s LCP and 3.2 MB transfer include HMR,
React refresh, unminified source modules, and browser extension overhead; they
must not be treated as production scores.

The report still identified a real asset opportunity. The frontend logo was
204,989 bytes, so the UI now uses an optimized 15 KB WebP with explicit
dimensions, and Vercel caches hashed assets and the logo immutably. Frontend
tests and a production Vite build pass after this change.

Run the next audit against a production build preview (incognito, extensions
disabled), for example:

```bash
cd frontend
VITE_API_BASE_URL=/api npm run build
npx vite preview --host 127.0.0.1 --port 4173
npx lighthouse http://127.0.0.1:4173/ --preset=perf --output=json
```

Do not claim an LCP or Performance target until that production-mode run is
available.
