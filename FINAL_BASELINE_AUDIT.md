# Final Baseline Audit

**Date:** 2026-11-11  
**Scope:** Current repository and isolated local validation

## Architecture

- React 18/Vite 5 frontend under `frontend/`.
- FastAPI/SQLAlchemy backend under `backend/`.
- Supabase PostgreSQL and private Supabase Storage are the intended production
  services; SQLite/local files are development fallbacks.
- Voice parsing, tools, state, schemas, and hybrid-AI foundation are active
  backend modules.
- Mobile and desktop shells share application state but use separate layouts.

## Git state

- Branch: `main`.
- Existing history preserved.
- Working tree contains substantial pre-existing and current uncommitted work.
- No remote is configured in this checkout; the supplied GitHub repository was
  reachable read-only earlier.
- No `.env`, private key, database, node_modules, or build output is tracked by
  `git ls-files`.
- No commit, push, deployment, or production migration was performed.

## Fresh validation

- Frontend tests: 51 passed.
- Frontend production build: passed.
- Backend tests: 157 passed.
- Backend imports: passed.
- Responsive E2E: 12 passed (10 mobile-shell tests and 2 desktop-shell tests).
- `git diff --check`: passed.

## Current blockers

1. The checked-in Vercel configuration does not yet prove that the FastAPI
   service is deployed as a supported Python Function.
2. Supabase production connectivity, private buckets, and production CORS were
   not tested.
3. Production backup execution and independent disaster recovery were not
   tested.
4. No production Preview deployment was created.

## Local test isolation

The E2E run used an isolated SQLite data directory under `.runtime/`, a local
backend on port 8010, and a frontend on port 5173. No production records were
used or modified.
