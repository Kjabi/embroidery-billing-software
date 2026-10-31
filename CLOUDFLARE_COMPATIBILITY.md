# Cloudflare deployment compatibility

Updated: 2026-10-31 (Asia/Kolkata)

This is a static compatibility assessment of the existing repository. Nothing
was deployed to Cloudflare and no Cloudflare runtime test was executed. Claims
below are limited to what can be proven from the project files and the runtime
constraints documented by Cloudflare.

## What is already viable: Pages (frontend)

The React/Vite frontend builds to static assets and can be served from
Cloudflare Pages Free:

```bash
cd frontend
npm install
npm run build          # -> frontend/dist
npx wrangler pages deploy frontend/dist
```

`wrangler.toml` already points `pages_build_output_dir` at `frontend/dist`.
Set `VITE_API_BASE_URL` to the deployed backend origin at build time, and add the
Pages origin (for example `https://<project>.pages.dev`) to the backend
`FRONTEND_ORIGIN` allowlist. No speech model, database, or secret belongs in the
Pages bundle. The browser downloads Whisper weights from Hugging Face on first
use and caches them locally.

## Why the FastAPI backend is not deployable as-is

The backend is a synchronous FastAPI + SQLAlchemy application with native and
filesystem dependencies:

| Dependency / behavior | File | Cloudflare Python Workers issue |
| --- | --- | --- |
| `psycopg[binary]` | `backend/requirements.txt`, `backend/main.py` | Native libpq/C extension. Python Workers run in a Pyodide/WASM sandbox without arbitrary native extensions. |
| Synchronous SQLAlchemy engine | `backend/main.py` | Blocking DB calls in a Worker; async SQLAlchemy is not supported by the current runtime contract. |
| SQLite fallback and local `data/` directory | `backend/main.py` | Workers have no durable local filesystem. The local fallback is only suitable for local development. |
| `sqlite3`, `tempfile`, backup/restore paths | `backend/main.py` | Backup and restore assume a persistent local disk; Cloudflare needs R2 (or an external store) for durable files. |
| `Pillow` | `backend/main.py` | Native imaging extension; not available in the Worker sandbox as used here. |
| `reportlab` PDF generation | `backend/main.py` | Pure Python, but depends on Pillow/ImageReader and in-memory image handling; CPU/memory limits are unverified. |
| `faster-whisper` + `av` | `backend/requirements.txt`, `backend/voice_providers.py` | Native audio/ML stack. Optional for the browser path, but cannot be installed in Workers. |
| `threading`, process-local locks/caches | `backend/main.py`, `backend/voice_state.py`, `backend/voice_providers.py` | Workers are isolate-based; no shared in-memory state across requests/instances. |
| `httpx` to Supabase Storage | `backend/storage.py` | HTTPS calls are compatible in principle, but must be validated with secrets and size limits. |
| Hyperdrive / PostgreSQL | n/a | Hyperdrive needs a documented Worker-compatible driver. The current `psycopg`/SQLAlchemy path is not one. |

FastAPI itself has an ASGI integration for Cloudflare Python Workers, but
successful ASGI routing does not make the database, imaging, PDF, or local-file
layers compatible.

## Smallest viable migrations (not implemented)

1. **Keep the backend on a persistent Python host** (current local/self-hosted
   model) and use Pages only for the frontend. This preserves every existing
   API contract and business rule. A commercial Vercel Hobby deployment is not
   an acceptable production target for this client. The prepared zero-cost
   path is documented in [`deploy/oracle-always-free.md`](deploy/oracle-always-free.md)
   (Oracle Always Free ARM64 + Caddy + existing Supabase), including the
   artifacts in `deploy/`. It has not been deployed.
2. **Port the data layer to Supabase REST/PostgREST via `httpx`** in a Python
   Worker. This removes the native driver but requires rewriting SQLAlchemy
   queries and losing the current transaction/idempotency guarantees unless
   replaced carefully.
3. **Move the API to a JavaScript/TypeScript Worker with Hyperdrive + `pg`**.
   This preserves Cloudflare-native database access but is a full API rewrite,
   not a deployment tweak.

None of these were performed. They are listed so the cost of the Cloudflare
Python Workers path is explicit rather than implied.

## Vercel

`vercel.json` is preserved. Vercel Hobby is restricted to personal,
non-commercial use and is **not** a valid production target for this commercial
client. A Vercel deployment would require an appropriate paid plan.

## Required environment variables for a future Pages deployment

Frontend (build time, public values only):

```dotenv
VITE_API_BASE_URL=https://<backend-origin>/api
VITE_VOICE_ENABLED=true
# optional model overrides
VITE_VOICE_MODEL_EN=onnx-community/whisper-base
VITE_VOICE_MODEL_TA=onnx-community/whisper-small
VITE_VOICE_MODEL_TANGLISH=onnx-community/whisper-small
VITE_VOICE_MODEL_DTYPE=q4
```

Backend (never placed in the frontend): `SUPABASE_DATABASE_URL`,
`APP_SECRET_KEY`, `APP_ENV=production`, `FRONTEND_ORIGIN=https://<project>.pages.dev`,
the Supabase Storage values, and optional provider keys.

## Status

- Pages frontend deployment path: **viable and build-verified locally**.
- Cloudflare Python Workers backend: **not compatible without a data-layer
  rewrite; blocked, not attempted**.
- Free Python-host alternative: **prepared and locally validated, not
  deployed**. See `deploy/oracle-always-free.md`.
- Source of truth for production remains PostgreSQL/Supabase with the existing
  FastAPI process until the compatibility blockers are resolved.
