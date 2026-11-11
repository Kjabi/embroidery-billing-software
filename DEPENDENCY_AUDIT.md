# Dependency Audit

**Audit date:** 2026-11-11  
**Scope:** Frontend and backend manifests, source references, and install
reproducibility. No dependency was removed.

## Frontend

| Package | Evidence | Decision |
|---|---|---|
| `react`, `react-dom` | Application entrypoint and all React components | KEEP |
| `lucide-react` | Icons across `App.jsx` and voice components | KEEP |
| `recharts` | `FinanceCharts.jsx`; loaded as a lazy feature | KEEP |
| `@huggingface/transformers` | Browser-local speech recognition in `voice/browserSpeech.js` | KEEP |
| `vite`, `@vitejs/plugin-react` | Build configuration and Vite scripts | KEEP |
| `tailwindcss`, `postcss`, `autoprefixer` | Tailwind/PostCSS configuration and CSS build | KEEP |

`frontend/npm ci --ignore-scripts --dry-run`: **passed**.  
`frontend/npm ls --depth=0`: **passed** with the declared dependency set.

The large speech and chart bundles are feature assets, not unused
dependencies. The speech runtime is intentionally browser-loaded and cached;
removing it would remove voice functionality.

## Backend

| Dependency | Evidence | Decision |
|---|---|---|
| FastAPI / Uvicorn | `backend/main.py` application and server entrypoint | KEEP |
| SQLAlchemy / psycopg | Database models, sessions, and Supabase PostgreSQL | KEEP |
| Pydantic | API, voice, hybrid-AI, and tool contracts | KEEP |
| ReportLab / Pillow | Invoice PDF and image/reference handling | KEEP |
| `python-multipart` | Multipart upload endpoints | KEEP |
| `httpx` / `certifi` | Storage and optional remote provider integrations | KEEP |
| `pytest` | Backend test suite only | KEEP in local requirements; excluded from Vercel |
| `faster-whisper` | Optional lazy local STT provider | KEEP in local requirements; excluded from Vercel |

`av` is imported only inside an optional duration-inspection path and is
provided by the local Faster-Whisper stack; the code fails open when it is not
installed. It is not required by `requirements-vercel.txt`.

`python3 -m compileall -q backend`: **passed**.

## Runtime manifest split

`backend/requirements-vercel.txt` correctly excludes `pytest` and
`faster-whisper`, avoiding an oversized serverless bundle. It retains the
runtime dependencies needed by FastAPI, database access, storage, invoices,
uploads, and authenticated APIs.

## Findings

1. No dependency met the standard for verified-unused removal.
2. No lockfile may be removed; `frontend/package-lock.json` is required for
   reproducible Vercel installs.
3. Optional voice dependencies must remain documented even when excluded from
   a particular deployment target.
4. The Vercel backend entrypoint/configuration requires a separate deployment
   compatibility fix or a different hosting architecture; dependency
   minimization alone cannot resolve that issue.
