# LIVE PREVIEW ACCEPTANCE REPORT

**Preview:** https://embroidery-management-4fz8lgeu1-abirudhu-4618s-projects.vercel.app
**Deployment:** `dpl_8G17QsAwHAVu6swKA2TxVMrFZSAZ` · target `preview` · commit `c0f1df2`
**Tested:** 12 Nov 2026, via authenticated `vercel curl` (CLI 65.14.0)
**Verdict:** **BLOCKED** — transport, security and auth gates verified; business workflows **not** executed, by design and by protection.

---

## 1. Why browser acceptance could not run

1. **Deployment Protection (Vercel Authentication)** returns `HTTP 302` to the auth gate for every unauthenticated request, including `/api/*`. A normal browser/Playwright session cannot reach the app.
2. **The preview shares the production Supabase database and buckets** (`APP_ENV`, `SUPABASE_DATABASE_URL` and storage keys are scoped to Preview *and* Production). Even with protection bypassed, customer/order/payment/upload tests would write **real business records**, which the brief explicitly forbids.

Authenticated `vercel curl` bypasses the gate, so read-only transport checks were performed. **No write was issued to the production database.** Only `GET`/`HEAD` requests were made.

---

## 2. Checklist results

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Application loads | **PASS** | `GET /` → 200, serves built `index.html` with PWA manifest, `viewport-fit=cover`, theme-color |
| 2 | Admin login | **BLOCKED** | Requires a write (session row) against the production DB. Not performed. |
| 3 | Logout | **BLOCKED** | Requires an authenticated session |
| 4 | Session expiration | **NOT TESTED live** | Covered locally: 401 → login screen (E2E) |
| 5 | Dashboard | **PASS (transport)** | `/api/dashboard/summary` → **401** without a token, as required |
| 6 | Customer search | **PASS (auth gate)** | `/api/customers` → **401** without a token |
| 7 | Customer creation | **BLOCKED** | Production data plane |
| 8 | Customer editing | **BLOCKED** | Production data plane |
| 9 | Product management | **BLOCKED** | Production data plane |
| 10 | Measurements | **BLOCKED** | Production data plane |
| 11 | Order creation | **BLOCKED** | Production data plane |
| 12 | Payment recording | **BLOCKED** | Production data plane |
| 13 | Partial payment | **BLOCKED** | Production data plane |
| 14 | Balance calculation | **NOT TESTED live** | Locally verified: seeded ₹3,000/₹1,000 → `₹2,000` balance; ₹1,800/₹300 → collects ₹1,500 |
| 15 | Invoice generation | **NOT TESTED live** | Locally verified: `%PDF` header, > 800 bytes |
| 16 | Invoice retrieval | **NOT TESTED live** | Same |
| 17 | Reference image upload | **NOT TESTED live** | Covered locally; 4 MB cap + regression test |
| 18 | Reports | **BLOCKED** | Production data plane |
| 19 | Voice assistant activation | **NOT TESTED live** | Production build sets `VITE_VOICE_ENABLED=false`; verified locally on a voice-enabled build |
| 20 | Microphone permissions | **NOT TESTED live** | Requires browser |
| 21 | Tamil/English voice | **NOT TESTED live** | Local voice tests confirm language selection; no live mic |
| 22 | Mobile navigation | **NOT TESTED live** | Verified locally at 320–1440 px |
| 23 | Desktop navigation | **NOT TESTED live** | Verified locally |
| 24 | Error and loading states | **NOT TESTED live** | Verified locally (loading skeleton, retry banner, 401 bounce) |

---

## 3. What *was* verified on the live deployment

### Application shell
```
GET /            → 200 text/html
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#1768c4">
```

### API and auth
```
GET /api/health             → 200 {"status":"ok"}
GET /api/customers          → 401
GET /api/dashboard/summary  → 401
```
The FastAPI function is live and the admin gate rejects unauthenticated reads.

### Assets
```
GET /assets/index-kIKTjBml.js   → 200 305,428 bytes  application/javascript
GET /assets/index-Chhwmzu5.css  → 200  62,858 bytes  text/css
GET /assets/ort-wasm-…wasm      → 200 26,861,777 bytes application/wasm
                                     cache-control: public, max-age=31536000, immutable
```
(These are the **deployed** hashes; the current local build produces new hashes and smaller chunks — see `FRONTEND_BUNDLE_OPTIMIZATION_REPORT.md`.)

### Security headers on `/`
```
strict-transport-security: max-age=31536000; includeSubDomains
x-content-type-options: nosniff
x-frame-options: DENY
referrer-policy: no-referrer
permissions-policy: microphone=(self), camera=(), geolocation=()
content-security-policy: default-src 'self'; base-uri 'self'; object-src 'none';
  frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self' data:;
  connect-src 'self' https://*.supabase.co https://*.huggingface.co https://*.hf.co;
  worker-src 'self' blob:
```

### Defect found live
```
GET /assets/manifest.webmanifest → 200  application/…  →  text/html
```
Vercel does not map `.webmanifest`. Content-Type should be `application/manifest+json`. **Not fixed in this phase** (it is a `vercel.json` header rule and every config change is a deployment); recommended fix is in `PRODUCTION_DEPLOYMENT_CONFIGURATION_REPORT.md` §4 P4.

---

## 4. Console / network / runtime logs

- `vercel inspect --logs` shows a clean build: 2398 modules, 7.50 s, no warnings other than the known lazy-chunk size note.
- No runtime exceptions were observed in the deployment log for the read-only requests performed.
- Browser console/network could not be inspected on the preview because no browser session can reach it.

---

## 5. What is required to complete this phase

1. A **staging** Supabase project + Preview-scoped env vars (so writes are safe).
2. A way for automated tests to reach the preview: temporarily disable Deployment Protection for previews, **or** create a Protection Bypass token.
3. Seed data in the staging DB.
4. Then re-run `tests/e2e/*.spec.mjs` with `BASE_URL` and `API_URL` pointed at the preview.

Until those exist, the live workflow acceptance is **BLOCKED**, not passed. Local end-to-end evidence is in `FINAL_SECURITY_PERFORMANCE_REPORT.md` and `FINAL_RESPONSIVE_REGRESSION_REPORT.md`.
