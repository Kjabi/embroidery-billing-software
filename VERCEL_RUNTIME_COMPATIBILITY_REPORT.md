# Vercel Runtime Compatibility Report

**Date:** 2026-11-11  
**Result:** Frontend PASS; API BLOCKED

- Vite production build succeeds.
- `backend/requirements-vercel.txt` excludes test-only and local
  Faster-Whisper dependencies.
- FastAPI imports successfully locally.
- Supabase PostgreSQL and Storage are configurable through backend-only
  environment variables.

The deployment was tested against a real Vercel Preview. The frontend returned
HTTP 200 with the configured security headers. The API route reached the
Python Function but returned HTTP 500 because the project has no configured
environment variables. Vercel initially rejected the old `services` runtime;
the deployment now uses `api/index.py`, file-based Python routing, and
`api/requirements.txt`.

SQLite/local files are not durable serverless persistence, and voice
conversation state is process-local.

After Preview-only Supabase variables are configured, re-run health,
authentication, customer/order workflows, payments, invoices, uploads, and
voice routes before production.
