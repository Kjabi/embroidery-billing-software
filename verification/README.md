# Verification evidence

Generated on 5 November 2026 against the existing application. This directory contains machine-readable results, not hand-written claims.

| File | What it proves |
| --- | --- |
| `backend-tests.txt` | Backend suite: 50 passed |
| `frontend-tests.txt` | Frontend voice-logic suite: 17 passed |
| `frontend-build.txt` | Production build with an explicit `VITE_API_BASE_URL` |
| `load-100-realistic.json` | 100 concurrent users, realistic think time, 0 errors |
| `load-100-overload.json` | 100 concurrent users, near-zero think time, graceful 429s only |
| `db-integrity.json` | Duplicate/overpayment/ledger/orphan checks after load |
| `restart-recovery.json` | Token, data, invoice sequence, and voice survive restart |
| `backup-restore.json` | `pg_dump`/`pg_restore` row-count match and writable restore |
| `migration-0003.json` | Migration applied to a pre-0003 populated clone, then real app write |
| `sequence-repair-health.json` | Id-sequence repair after an explicit-id import; both health paths return 200 |
| `browser-smoke.json` | Real Chromium login/dashboard/orders/new order/PDF/voice/mobile |
| `voice-confirmation-guard.json` | Wrong phrase rejected, exact phrase accepted, replay not duplicated |
| `screenshots/` | Final browser screenshots (JPEG) |

## Reproduce the backend and frontend suites

```bash
cd backend && ../.venv/bin/python -m pytest -q
cd ../frontend && npm test
VITE_API_BASE_URL=https://api.example.com/api npm run build
```

## Reproduce the load test

The load test needs a running backend and an isolated PostgreSQL database. It never targets production.

```bash
cd backend
../.venv/bin/python scripts/load_test_100.py \
  --users 100 --duration 90 --think-min 1.0 --think-max 2.5 \
  --report ../verification/load-100-realistic.json
```

Overload variant:

```bash
../.venv/bin/python scripts/load_test_100.py \
  --users 100 --duration 45 --think-min 0.02 --think-max 0.08 \
  --report ../verification/load-100-overload.json
```

`--server-pid` samples CPU/RSS for a local server. The script exits non-zero on unexpected transport errors or server errors.

## Environment note

The load and browser evidence was produced with:

- FastAPI/uvicorn, one worker, `APP_ENV=production`
- local PostgreSQL 17.10 on `127.0.0.1:55433`
- backend on `127.0.0.1:8010`
- Vite frontend on `localhost:5180`

It is production-like, but **not** Supabase and **not** a deployed host. See `FINAL_ACCEPTANCE_REPORT.md` for the deployment blockers.
