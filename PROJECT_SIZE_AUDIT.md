# Project Size Audit

**Audit date:** 2026-11-11  
**Scope:** Read-only Phase 1 inventory of `embroidery-management`  
**Changes made:** No files deleted, staged, committed, pushed, or deployed.

## Repository and workspace size

| Area | Measured size | Classification | Recommendation |
|---|---:|---|---|
| Entire working directory | ~1.7 GiB | Includes local dependencies, runtime state, build output, and source | Do not use as the Git/deployment size |
| `.runtime/` | ~805 MiB | Generated local verification, model/browser/runtime state, logs, PDFs, and database-cluster state | Keep out of Git and Vercel; remove only with explicit cleanup approval |
| `frontend/node_modules/` | ~590 MiB | Reproducible npm install | Keep local or remove/reinstall after approval; already ignored |
| `.venv/` | ~314 MiB | Reproducible Python environment | Keep local or remove/recreate after approval; already ignored |
| `frontend/dist/` | ~27 MiB | Reproducible production build | Keep only for local verification; already ignored |
| `tests/node_modules/` | ~18 MiB | Reproducible Playwright test dependency | Add an ignore rule; removal is safe only after confirming no active test process uses it |
| `.git/` | ~10 MiB Git objects | Existing repository history and metadata | Preserve |
| Tracked files | 91 files | Existing Git baseline | Preserve history and inspect changes before staging |

The application source and configuration are small relative to local tooling.
The reported working-directory total must not be presented as the deployable
repository size because it includes ignored dependencies and verification
state.

## Largest observed files

| File | Size | Classification | Recommendation |
|---|---:|---|---|
| `frontend/dist/assets/ort-wasm-simd-threaded.asyncify-*.wasm` | 25.62 MiB | Generated browser speech runtime asset | Keep generated locally; verify Vercel asset limits and voice loading separately |
| `frontend/dist/assets/transformers.web-*.js` | 584.65 KiB | Generated browser speech bundle | Keep generated locally; do not commit |
| `frontend/dist/assets/FinanceCharts-*.js` | 419.45 KiB | Generated lazy bundle | Keep generated locally; do not commit |
| `frontend/src/App.jsx` | 217.10 KiB | Essential application source | Keep |
| `backend/invoices/INV-2026-001.pdf` | 211.52 KiB | Local generated invoice/business record | Never delete as routine cleanup; keep out of Git and use persistent storage in production |
| `backend/invoices/INV-2026-002.pdf` | 210.40 KiB | Local generated invoice/business record | Never delete as routine cleanup; keep out of Git and use persistent storage in production |
| `frontend/public/lalithas-apparel-logo.png` | 200.18 KiB | Public asset; possible duplicate of WebP | Verify references and visual fallback use before proposing removal |
| `backend/data/embroidery.db` | 140.00 KiB | Local SQLite business database | Never delete; exclude from Git and do not use as Vercel production persistence |

Additional Python bytecode and test screenshots are generated or verification
artifacts and are already covered by existing ignore patterns or tracked
verification policy; they require classification before cleanup.

## Structure inventory

| Area | Current role | Finding |
|---|---|---|
| `frontend/src/` | React/Vite application, voice UI, mobile UI, charts | Existing structure is coherent; no blind move recommended |
| `frontend/public/` | Browser-delivered assets and robots/manifest files | Required runtime assets are present |
| `backend/main.py` | FastAPI app, models, routes, authentication, invoices, middleware | Deliberately monolithic; do not split during cleanup |
| `backend/voice_*.py`, `backend/hybrid_ai.py` | Voice state, parsing, tools, providers, schemas, retrieval | Active runtime source |
| `backend/migrations/` | SQL migration files | Keep; do not apply production migrations without approval |
| `backend/tests/` | Backend regression and workflow tests | Keep |
| `tests/` | Playwright end-to-end harness | Keep; its `node_modules/` is reproducible and currently not ignored |
| `verification/` | Prior test evidence and screenshots | Preserve until evidence-retention policy is agreed |
| `deploy/` | Docker/Caddy/Oracle deployment examples | Keep as alternative deployment documentation |
| Root Markdown reports | Prior audit and deployment evidence | Preserve during this audit; consolidate only with explicit scope |

## Runtime and model findings

- Frontend voice uses `@huggingface/transformers`; model/runtime assets are
  downloaded and cached in the browser rather than stored in source.
- Backend `faster-whisper` is optional and lazily imported in the full local
  requirements. `requirements-vercel.txt` intentionally excludes it.
- The application has SQLite/local-file fallbacks for local development, while
  production is expected to use Supabase PostgreSQL and persistent Supabase
  Storage.
- Voice conversation state is process-local. This is safe only with a
  single process or a shared state store; Vercel serverless instance reuse
  cannot be treated as durable session storage.

## Git and sensitive-file findings

- Current branch: `main`.
- No Git remote is configured in this checkout.
- Existing history is present and must be preserved.
- No `.env` or private-key path is tracked by `git ls-files`; only sanitized
  environment examples are tracked.
- `.env`, local databases, backups, invoices, `.runtime/`, Python caches,
  frontend dependencies, and frontend build output are ignored.
- `tests/node_modules/`, `verification/`, `.DS_Store`, generic `*.log`, and
  generic `*.db` are not all covered by current ignore rules. `verification/`
  is currently tracked/retained evidence, so it must not be excluded blindly.

## Phase 1 recommendations

1. Add a narrow `tests/node_modules/` ignore rule before any Git staging.
2. Do not delete business records under `backend/data/`, `backend/invoices/`,
   `backend/backups/`, or `.runtime/` without explicit approval and a resolved
   retention decision.
3. Verify whether the public PNG logo has any active references before
   proposing removal; the WebP is already used by the frontend UI.
4. Keep both dependency manifests and lockfiles until dependency usage and
   Vercel install behavior have been verified.
5. Treat Vercel backend compatibility as **not yet proven**, especially for
   process-local voice state and any local filesystem fallback.
