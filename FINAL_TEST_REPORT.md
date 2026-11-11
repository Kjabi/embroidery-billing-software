# Final Test Report

**Date:** 2026-11-11  
**Environment:** Local isolated test services; no production data access

| Area | Result | Evidence |
|---|---|---|
| Frontend unit tests | PASS | 51 passed |
| Frontend production build | PASS | `VITE_API_BASE_URL=/api npm run build` |
| Backend tests | PASS | 157 passed |
| Backend imports | PASS | `main`, `voice_agent`, `voice_tools`, `hybrid_ai`, `voice_providers` |
| Git whitespace check | PASS | `git diff --check` |
| Desktop E2E | PASS in aligned-service run | Desktop shell checks passed before the final server lifecycle interruption |
| Mobile E2E | BLOCKED | Requires frontend port 5173 and backend port 8010 to remain running for the full suite; final rerun received `ERR_CONNECTION_REFUSED` |
| Supabase integration | NOT RUN | No production database or records were accessed |
| Vercel deployment | NOT RUN | No deployment approval or authenticated Vercel CLI |

## Warnings

- Python tests emit existing deprecation warnings for `datetime.utcnow()` and
  Starlette coroutine detection. These did not fail tests.
- Vite reports large lazy speech/chart chunks; they are feature assets and were
  not removed.

## Final status

The source is locally validated and cleaned non-destructively, but production
readiness is not certified. Vercel backend compatibility and production
integration remain blockers documented in
[VERCEL_DEPLOYMENT_REPORT.md](./VERCEL_DEPLOYMENT_REPORT.md).
