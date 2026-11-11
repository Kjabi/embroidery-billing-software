# Vercel Deployment Compatibility Report

**Audit date:** 2026-11-11  
**Status:** **BLOCKED for a production deployment claim**

## Verified

- Frontend Vite production build passes with `VITE_API_BASE_URL=/api`.
- `frontend/.env.production` disables the browser voice panel for hosted
  builds, avoiding the large browser speech model on the initial hosted app.
- `frontend/package-lock.json` is present and `npm ci --ignore-scripts
  --dry-run` passes.
- `backend/requirements-vercel.txt` is a lean runtime manifest and excludes
  local Faster-Whisper and test-only packages.
- Supabase PostgreSQL and Supabase Storage configuration variables are
  documented in `.env.example`.
- Local SQLite, invoices, backups, and uploads are excluded from Git and
  should not be used as Vercel production persistence.

## Blocker: current Vercel configuration is not proven valid

The current [vercel.json](./vercel.json) uses top-level `services` entries with
`root`, `entrypoint`, and separate frontend/backend service definitions.
Vercel's documented static configuration exposes properties such as
`framework`, `buildCommand`, `outputDirectory`, `rewrites`, `headers`, and
`functions`; its Python runtime expects a supported Python entrypoint (normally
an `api/` function or an entrypoint configured through `pyproject.toml`).

Therefore a successful local frontend build does **not** prove that this
single repository configuration will deploy both `frontend/` and
`backend/main.py` as one Vercel project. Do not deploy production using this
configuration without a Vercel preview validation.

## Runtime architecture risks

- FastAPI writes temporary/local files for SQLite fallback, backup uploads, and
  restore handling. Vercel's filesystem is not durable; production must use
  Supabase PostgreSQL and private Supabase Storage.
- Voice conversation state is process-local. Serverless instance reuse is not
  durable, so multi-instance voice workflows require a shared state store or a
  single-instance deployment with accepted limitations.
- Invoice generation may use local temporary files during request handling and
  must not rely on local persistence after the request.
- Serverless request duration, memory, and package-size limits must be tested
  with the real Vercel plan and production dependency install.

## Recommended deployment architecture

### Option A — safest without rewriting the application

Deploy the Vite frontend to Vercel as its own project and deploy the FastAPI
backend to a persistent Python host (or a separately validated Vercel Python
project). Configure the frontend's `VITE_API_BASE_URL` to the authenticated
backend URL and configure `FRONTEND_ORIGIN` exactly to the deployed frontend
origin.

### Option B — single Vercel project

Create a supported Vercel Python entrypoint under the repository's supported
API layout, preserve imports and environment handling, then validate every API
route in a Preview deployment. This is an application integration change and
must be tested before production.

## Required preview checks

1. Deploy a Vercel Preview only after setting backend environment variables.
2. Confirm `/api/health`, login, customer creation, order creation, payments,
   invoice download, and authenticated voice routes.
3. Confirm Supabase PostgreSQL is selected and SQLite is not used.
4. Confirm invoice/reference files are stored in private Supabase Storage.
5. Inspect response headers, CORS, error logs, function duration, and memory.
6. Test a second request after a cold start and concurrent authenticated
   requests.

## Verdict

**Frontend: locally deployable.**  
**Backend: not yet proven compatible with the checked-in Vercel configuration.**  
**Whole application: NO-GO for production until a Preview deployment validates
the API architecture or the backend is deployed on a compatible persistent
Python host.**
