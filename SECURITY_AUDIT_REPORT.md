# Security Audit Report

**Date:** 2026-11-07
**Scope:** authentication, authorisation, session handling, input handling, rate limiting, browser
storage, HTTP headers, dependency advisories, secrets hygiene and storage access
**Production access:** none — source review, isolated tests and public advisory databases only
**Status:** core auth **PASS**; **one dependency advisory fixed**; **open dependency and
deployment risks remain**; production security sign-off **NOT GIVEN**.

> This report records verified facts. It does not claim the application is "secure" in general.
> Items marked **NOT TESTED** require a real deployment, a real browser threat model, or the
> owner's proxy/CDN configuration.

## 1. Verified controls

| Control | Evidence | Status |
|---|---|---|
| Every business endpoint requires auth | endpoint scan found only `GET /health`, `GET /api/health`, `POST /api/login` unauthenticated | PASS |
| JWT signature checked with constant-time compare | `hmac.compare_digest` in `decode_access_token()` | PASS |
| JWT expiry enforced | `exp < now` → 401 | PASS |
| Server-side session revocation | every request checks `admin_sessions.revoked = false` and `expires_at >= now` | PASS |
| Logout revokes the current session | `/api/logout` sets `revoked = true` | PASS |
| Password hashing | PBKDF2-SHA256, 600,000 rounds, 16-byte salt | PASS |
| Token TTL | 8 hours (configurable) | PASS |
| Login rate limit | 5 failures / 15 min per client key | PASS (see §4.4) |
| Voice rate limit | 120 turns / 10 min per admin + client key | PASS (intentional 429s under load) |
| CORS | explicit origin list; methods and headers restricted; no credentials flag | PASS |
| Security headers | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` | PASS (partial, see §4.3) |
| SQL injection | SQLAlchemy ORM; raw SQL uses bound parameters; f-strings only interpolate trusted model metadata | PASS |
| CSV formula injection | `csv_safe()` prefixes `= + - @ TAB CR` | PASS (tested) |
| Upload validation | 5 MB reference image, Pillow magic check, JPEG/PNG only; 10 MB / 60 s audio cap | PASS |
| Private object storage | buckets must be `public=false` and MIME-restricted; service-role key backend-only | PASS (source review) |
| Error messages | no tracebacks/credentials returned; validation errors sanitised | PASS |
| Production secret enforcement | empty `APP_SECRET_KEY` raises in production; empty initial admin password raises | PASS |
| Secrets in Git | no `.env` in history; no keys in tracked non-example files; `.env` ignored | PASS |
| Frontend dependency audit | `npm audit --omit=dev` → 0 vulnerabilities | PASS |
| XSS sinks | no `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function` | PASS |
| Backend tests after fixes | 150 passed; `pip check` clean | PASS |

## 2. Access-control spot checks

- All order, customer, product, finance, invoice, backup, restore and voice routes depend on
  `require_admin`.
- The health endpoints are intentionally public and run only `SELECT 1`.
- Login is public by design and rate-limited.
- `/api/restore` is disabled when `IS_SERVERLESS_DEPLOYMENT` is true; local restore still requires
  admin auth and creates a pre-restore snapshot.
- The browser never receives the Supabase service-role key; all Storage calls are backend-only.
- API docs (`/docs`, `/openapi.json`) are publicly readable by default. This is information
  disclosure only, but should be disabled or IP-restricted in production.

## 3. Dependency advisories (OSV, checked 2026-11-07)

### 3.1 FIXED — `python-multipart` 0.0.9

OSV reported **16 advisories** for the pinned version, including:

- GHSA-59g5-xgcq-4qw3 / PYSEC-2026-1851 — multipart boundary DoS (fixed 0.0.18)
- GHSA-wp53-j4wj-2cfg — arbitrary file write under non-default config (fixed 0.0.22)
- GHSA-mj87-hwqh-73pj — large preamble/epilogue DoS (fixed 0.0.26)
- GHSA-pp6c-gr5w-3c5g — unbounded part-header DoS (fixed 0.0.27)
- GHSA-5rvq-cxj2-64vf, GHSA-6jv3-5f52-599m, GHSA-vffw-93wf-4j4q — quadratic parsing /
  parameter smuggling (fixed 0.0.30)
- GHSA-v9pg-7xvm-68hf — negative Content-Length memory buffering (fixed 0.0.31)

**Action taken:** upgraded to `python-multipart==0.0.33` (current release, Python ≥3.11; venv is
3.14.3) and updated `backend/requirements.txt` with an explanatory comment. Full backend suite:
**150 passed**. `pip check`: clean. The app has multipart endpoints (invoice image, voice
transcribe, restore), so this was a real exposure for authenticated users.

### 3.2 OPEN — Starlette 0.38.6 (14 advisories)

FastAPI 0.115.0 pins `starlette>=0.37.2,<0.39.0`, so Starlette cannot be upgraded without a
FastAPI upgrade. Relevant advisories include:

| Advisory | Issue | Fixed |
|---|---|---|
| GHSA-f96h-pmfr-66vw / PYSEC-2026-1943 | multipart DoS | 0.40.0 |
| GHSA-2c2j-9gv5-cj73 / PYSEC-2026-1941 | large multipart file DoS | 0.47.2 |
| GHSA-86qp-5c8j-p5mr / PYSEC-2026-161 | missing Host header validation poisons `request.url.path` | 1.0.1 |
| GHSA-jp82-jpqv-5vv3 | request path concatenated into authority poisons `request.url.hostname` | 1.3.0 |
| GHSA-82w8-qh3p-5jfq | `request.form()` limits ignored for urlencoded forms | 1.3.1 |
| GHSA-wqp7-x3pw-xc5r | StaticFiles UNC path SSRF (Windows) | 1.1.0 |
| GHSA-x746-7m8f-x49c | arbitrary HTTP method dispatch on `HTTPEndpoint` | 1.1.0 |

**Exposure assessment (does not remove the advisories):**

- The app does not use `StaticFiles`, `HTTPEndpoint`, `request.form()` or Host-based routing, so
  the UNC/HTTPEndpoint/urlencoded findings are not directly reachable.
- It does accept multipart uploads on authenticated routes; the multipart DoS findings are
  reachable by an authenticated user (or by an attacker who can bypass auth). The new
  `python-multipart` mitigates part of the parsing layer, but the Starlette-level limits still
  need the upgrade.
- `request.client.host` is used for rate limiting; a poisoned `Host` does not change it.

**Status: FAIL / open.** A controlled FastAPI + Starlette upgrade (to a FastAPI that supports
Starlette ≥1.3.1) with the full 150-test suite and a multipart upload smoke test is required before
production. This was **not** performed in this pass because it is a framework-level change and
needs owner approval.

### 3.3 LOW — `anyio` 4.11.0 (4 advisories)

- GHSA-5p39-cfhj-2xmp: process-pool workers block on undrained stderr (fixed 4.14.2).
- GHSA-82r6-8w77-94w6: TLSStream IDNA 2003 host encoding can enable certificate spoofing
  (fixed 4.14.2).

This app does not use AnyIO process pools, and outbound TLS hostnames come from environment
configuration, not user input. Current `anyio<5` allows a bump to 4.16.0; recommended with the
Starlette upgrade, not in isolation.

### 3.4 Clean packages checked

`fastapi 0.115.0`, `Pillow 13.0.0`, `SQLAlchemy 2.0.35`, `uvicorn 0.30.6`, `reportlab 4.2.2`,
`httpx 0.28.1`, `pydantic 2.14.1`, `faster-whisper 1.2.1`, `ctranslate2 4.8.4`,
`onnxruntime 1.31.1`, `tokenizers 0.23.3`, `numpy 2.5.4`, `certifi` → **0 advisories** each.

Frontend production dependencies: **0 vulnerabilities** (`npm audit --omit=dev`).

## 4. Findings and risks

### 4.1 MEDIUM — JWT is stored in `localStorage`

`frontend/src/App.jsx` stores `emb_token` in `localStorage`. Any XSS on the origin can read it.
Mitigations already present: React escaping, no raw HTML sinks, no third-party scripts, short
8-hour TTL, server-side revocation, and logout clearing. Residual risk remains because the token
is not `HttpOnly`.

**Recommendation:** move to an `HttpOnly; Secure; SameSite=Strict` cookie with CSRF protection, or
keep the bearer token but add a strict CSP and a short access-token lifetime with refresh. This is
an architectural change; not done in this pass.

### 4.2 MEDIUM — No Content-Security-Policy

`frontend/index.html` has no CSP meta tag, and the backend does not set a CSP header. The reverse
proxy is expected to add one, but nothing enforces it. The app loads:
`self` scripts/styles, the API origin, and (for speech) `huggingface.co` model files plus
`blob:`/`worker-src` for the WASM worker.

**Recommendation:** set at the proxy, for example a policy allowing `default-src 'self'`,
`connect-src 'self' https://<api-host> https://huggingface.co https://cdn-lfs.huggingface.co`,
`worker-src 'self' blob:`, `script-src 'self'`, and no `unsafe-eval`. Test the voice panel after
applying.

### 4.3 MEDIUM — HSTS and proxy headers are not set by the app

The app sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and a microphone-only
`Permissions-Policy`. It does **not** set `Strict-Transport-Security` (correct for the app layer,
but the proxy must), and it does not use `TrustedHostMiddleware` or `ProxyHeadersMiddleware`.

**Risk:** without proxy configuration, `request.client.host` is the proxy/CDN address. Login and
voice rate limits then become **global** (one bucket for all users), and an attacker can lock out
everyone with 5 bad logins. Host-header poisoning is also unvalidated at the app layer.

**Recommendation:** configure the proxy to pass the real client IP, set
`--proxy-headers --forwarded-allow-ips=<proxy-range>` (or an equivalent trusted-proxy setting),
add a Host allow-list, and set HSTS at the edge. Verify per-client rate limiting in staging.

### 4.4 MEDIUM — Rate limits are in-memory and per worker

`_login_attempts` and `_voice_requests` are process-local dictionaries. With multiple workers:

- limits are multiplied by the worker count,
- counters reset on restart,
- keys are only pruned when that key is checked again (slow memory growth with many source IPs).

For a single small-business instance this is acceptable; for the planned multi-worker/proxy
deployment it is not a strong control.

**Recommendation:** move counters to PostgreSQL/Redis (free tier), or enforce login throttling at
the proxy/WAF. Short term: keep one worker or document the reduced guarantee.

### 4.5 LOW — Username enumeration by timing

`login()` skips PBKDF2 when the username does not exist (`verify_password` only runs if `admin` is
truthy). A missing user returns faster than a wrong password. The 5-failure limit and generic 401
reduce the practical impact.

**Recommendation:** always run a dummy PBKDF2 verification when the user is missing.

### 4.6 LOW — Password policy is weak at setup

`ADMIN_INITIAL_PASSWORD` is only checked for non-emptiness; `LoginReq.password` has `min_length=1`.
`hash_password` is strong, but a one-character password would still be accepted at first setup.

**Recommendation:** require ≥12 characters (and a passphrase check) when creating the initial
admin, and document rotation.

### 4.7 LOW — Expired sessions accumulate

The audit copy had **407 expired, unrevoked** sessions. Login deletes expired rows, but a system
that is not logged into for a long time accumulates them; `require_admin` still rejects them.
This is hygiene, not an auth bypass.

**Recommendation:** scheduled `DELETE FROM admin_sessions WHERE revoked OR expires_at < now()`.

### 4.8 LOW — Legacy unsalted SHA-256 password path

`verify_password()` accepts a non-PBKDF2 hash by comparing an unsalted SHA-256. All observed
hashes (local and rehearsal) are PBKDF2, and a legacy hash is rehashed on successful login. The
fallback exists only for migration.

**Recommendation:** after confirming no production row uses it, delete the fallback and force a
password reset for any remaining legacy hash.

### 4.9 LOW — Duplicate unique indexes

`ix_orders_create_request_id` + `ux_orders_create_request_id` and
`ix_transactions_idempotency_key` + `ux_transactions_idempotency_key` are redundant. This is a
performance/hygiene issue, not a vulnerability. Do not drop without checking production names.

### 4.10 LOW — `Server-Timing` header

Every response exposes `Server-Timing: app;dur=…`. This is useful for operations but leaks a small
amount of timing information. Remove it from public responses if not needed.

### 4.11 LOW — Public API docs

`/docs` and `/openapi.json` are enabled. Disable in production or restrict by IP.

## 5. What was not tested

- **RLS / tenant isolation** on Supabase (no project access).
- **TLS configuration, HSTS, WAF, DDoS protection, CDN rules** (no deployment).
- **Cloudflare/Vercel proxy header behaviour** and whether rate limiting is per real client.
- **Secret rotation** and access to the Supabase service-role key.
- **Backup encryption** at the destination.
- **Full transitive CVE scan** — only the listed packages were queried via OSV; no `pip-audit`
  (not installed) or lockfile SBOM scan was run.
- **Penetration test / fuzzing** of the API, multipart parser or voice endpoints.
- **XSS/CSRF/cookie** testing in a real browser with a CSP applied.
- **Physical microphone permission abuse** (covered as a functional test, not a security test).

## 6. Priority actions

1. **Upgrade FastAPI + Starlette** (and AnyIO) to clear the open framework advisories; re-run the
   full suite and multipart upload smoke tests.
2. **Add a strict CSP** and move the token to an `HttpOnly` cookie (or accept the residual risk
   explicitly).
3. **Make rate limiting proxy-aware** and trust only the documented proxy range; verify per-client
   limits in staging.
4. **Enforce a minimum admin password length** at setup and remove the legacy SHA-256 fallback
   after verification.
5. **Prune expired sessions** on a schedule.
6. **Disable `/docs` and `/openapi.json`** in production.
7. **Resolve duplicate unique indexes** after checking production index names.
8. Keep `python-multipart==0.0.33` (fixed in this pass) and pin the upgraded framework versions.

## 7. Verdict

- **Core authentication/authorisation and input handling: PASS.**
- **`python-multipart` advisories: FIXED (0.0.33), 150 tests pass.**
- **Starlette/FastAPI advisories: OPEN (FAIL) — requires a controlled framework upgrade.**
- **Browser token storage / CSP / proxy-aware rate limiting: OPEN risks, documented.**
- **Production security sign-off: NOT GIVEN.**
