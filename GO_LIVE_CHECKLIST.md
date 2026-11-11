# Go-Live Checklist — Lalitha's Apparel

**Date:** 2026-11-08
**Current verdict: NOT READY FOR PRODUCTION**
**Production changes made:** none.

Legend: **PASS** = verified with evidence · **FAIL** = verified defect · **NOT TESTED** = no
evidence yet · **BLOCKED** = cannot proceed without a resource/approval · **N/A** = not applicable.

> Do not change this header to "READY" while any item in §1 is not PASS. A deployment that
> ignores these gates is an unverified gamble, not a release.

## 0. Release-candidate verification — 2026-11-08

Executed on an isolated local instance only (SQLite in `.runtime/run-20261108/`); production was
untouched.

| Check | Result |
|---|---|
| Backend suite | **PASS — 156 passed** |
| Frontend suite | **PASS — 19 passed** |
| Production build (`frontend/.env.production`) | **PASS — ~2.7 s** |
| Endpoint sweep (37 routes) | **62/62 checks PASS** (earlier 60/62 were harness-expectation errors, now corrected) |
| Playwright UI audit (1440/768/390, all tabs, real CRUD/order/export) | **PASS — 0 console/page/request errors, 0 a11y label issues, 0 overflow** |
| `vercel.json` vs published schema (draft-04) | **VALID** |
| UI heuristic score | **82/100** — see `DEPLOYMENT_READINESS_AUDIT.md` §0.2 |

Not proven by this pass: Vercel deployment, environment variables, Supabase production
connectivity, migrations in production, independent backup/restore, DNS/TLS, physical mic.

## 1. Hard blockers (all must be PASS before go-live)

| # | Gate | Status | Evidence / reason |
|---|---|---|---|
| 1 | Host accepts the production build | **PASS (config) / NOT TESTED (deploy)** | Vercel Services config validates; nothing deployed |
| 2 | Voice disabled in production, or physical mic passed | **PASS (disabled)** | `VITE_VOICE_ENABLED=false`; physical mic remains `NOT TESTED` for any future re-enable |
| 3 | Production migration `0003` applied to a verified backup | **BLOCKED** | rehearsal PASS on a copy; production untouched, needs approval |
| 4 | Real staging/Preview deployment passed | **BLOCKED** | no Vercel project or staging DB (`STAGING_DEPLOYMENT_REPORT.md`) |
| 5 | Independent, restorable backup destination verified | **FAIL** | backups are co-located; no off-host restore proven (`BACKUP_RUNBOOK.md`) |
| 6 | ARM64 image built and run on the target | **N/A for Vercel** | Vercel runs managed Python; ARM64 applies only to the Oracle/Caddy fallback |
| 7 | Framework advisories resolved | **FAIL** | Starlette 0.38.6 has open advisories; FastAPI pins it (`SECURITY_AUDIT_REPORT.md` §3.2) |
| 8 | Production credentials, DNS and TLS provisioned | **BLOCKED** | none exist in this environment |
| 9 | Owner signs off on free-tier risks | **BLOCKED** | requires an explicit business decision |
| 10 | Hosting plan permits commercial use | **BLOCKED** | Vercel Hobby is non-commercial; Pro (~US$20/mo) conflicts with ₹0 target |

## 2. Functional readiness

| Check | Status | Evidence |
|---|---|---|
| Backend test suite | **PASS** | 156 passed (2026-11-08) |
| Frontend unit tests | **PASS** | 19 passed |
| Endpoint sweep (37 routes) | **PASS (isolated)** | 62/62 checks after correcting two harness expectations |
| Playwright UI audit (desktop/tablet/mobile) | **PASS** | real CRUD, order submit, finance export; 0 errors |
| Production build completes | **PASS** | with `VITE_API_BASE_URL` set |
| Login / logout / session revocation | **PASS** | automated tests |
| Create/edit customer | **PASS** | tests + typed UI E2E |
| Create order / measurements | **PASS** | tests + load tests |
| Payments / balance / delivery | **PASS** | tests + load tests |
| PDF invoice generation | **PASS** | tests |
| Duplicate/idempotency replay | **PASS** | tests + load tests |
| Duplicate invoice number under concurrency | **PASS after fix** | `CONCURRENCY_LOAD_TEST_REPORT.md` |
| Finance CSV export + formula-injection guard | **PASS** | tests |
| Backup/restore API | **PASS (local)** | `BACKUP_RESTORE_REPORT.md` |
| Typed voice: English/Tamil/Tanglish customer creation | **PASS** | `VOICE_ACCEPTANCE_REPORT.md` |
| Typed voice intent matrix | **PASS (91/91)** | `INTENT_UNDERSTANDING_REPORT.md` |
| Physical microphone | **N/A in production (voice disabled)** | re-enable gate: `VOICE_ACCEPTANCE_REPORT.md` §7 |

## 3. Security readiness

| Check | Status | Evidence |
|---|---|---|
| All business endpoints require auth | **PASS** | endpoint scan |
| JWT signature/expiry + server-side revocation | **PASS** | tests |
| PBKDF2 600k rounds | **PASS** | code review |
| Login + voice rate limiting | **PASS (single worker)** | code review; proxy behaviour NOT TESTED |
| CORS allow-list | **PASS (config)** | cross-origin NOT TESTED |
| Upload validation (size/type) | **PASS** | code review + tests |
| SQL injection / CSV injection | **PASS** | tests |
| Secrets not in Git | **PASS** | history and tracked-file scan |
| Frontend dependency audit | **PASS** | 0 vulnerabilities |
| `python-multipart` advisories | **PASS (fixed)** | upgraded to 0.0.33, 150 tests |
| Starlette/FastAPI advisories | **FAIL** | open; needs framework upgrade approval |
| JWT in `localStorage` | **RISK** | documented, not fixed |
| CSP / HSTS / security headers | **PASS (config) / NOT TESTED (deployed)** | `vercel.json` sets HSTS, CSP, frame/referrer/permissions headers |
| Proxy-aware client IPs | **NOT TESTED** | Vercel proxy behaviour unverified |
| RLS / tenant isolation on Supabase | **NOT TESTED** | no project access |
| `/docs` and `/openapi.json` exposure | **OPEN** | disable in production or verify the rewrite hides them |

## 4. Data readiness

| Check | Status | Evidence |
|---|---|---|
| Schema/financial invariants on rehearsal copy | **PASS** | 0 violations except 407 expired sessions |
| Migrations `0003`+`0004` idempotent | **PASS** | applied twice, exit 0 |
| `0004` indexes present | **PASS** | verified |
| PostgreSQL logical dump → restore | **PASS** | counts identical |
| SQLite backup/restore | **PASS** | mutation rolled back |
| Live Supabase bucket privacy/MIME | **NOT TESTED** | source review only |
| Orphan-object reconciliation | **MISSING** | not implemented |
| Legacy local PDFs/drawings retired | **NOT DONE** | needs owner approval |
| Broken storage migration script | **FAIL** | references non-existent `new_object_key` / `DRAWING_DIR` |

## 5. Performance readiness

| Check | Status | Evidence |
|---|---|---|
| 25 concurrent users | **PASS** | 0 errors/conflicts, p95 49 ms |
| 50 concurrent users | **PASS** | 0 errors/conflicts, p95 41 ms |
| 100 concurrent users | **PASS with caveat** | 0 errors; p99 4.1 s dominated by PBKDF2 login |
| Invoice allocation race | **PASS after fix** | 0 duplicates over 718 invoices |
| Idempotency under load | **PASS** | 0 duplicate keys |
| Real-host (ARM64) performance | **NOT TESTED** | no host |

## 6. Voice readiness

**Production decision: voice is disabled** (`VITE_VOICE_ENABLED=false`). The rows below are
therefore not go-live gates for this deployment; they are the re-enable checklist.

| Check | Status | Evidence |
|---|---|---|
| English/Tamil/Tanglish triggers (typed) | **PASS** | 91/91 matrix |
| Live field collection + state retention | **PASS** | tests |
| Duplicate detection | **PASS** | tests |
| Exact confirmation required | **PASS** | tests |
| DB read-back returns real saved details | **PASS** | tests + UI E2E |
| Cancellation writes nothing | **PASS** | tests + UI E2E |
| Mic denial handled cleanly | **PASS** | unit test + browser |
| Voice panel hidden in production | **PASS (design)** | `VITE_VOICE_ENABLED=false`; deployment not verified |
| Physical mic capture | **DEFERRED / NOT TESTED** | required before re-enable |
| Tamil/Tanglish speech accuracy | **DEFERRED / partial** | benchmark says `small` only partial |
| Spoken Tamil digits | **DEFERRED / unreliable** | benchmark |
| Browser-local Whisper end-to-end | **DEFERRED / NOT TESTED** | model download |
| Tamil TTS | **DEFERRED / NOT TESTED** | no verified local voice |

## 7. Deployment / hosting readiness

| Check | Status |
|---|---|
| Vercel Services config (`vercel.json`) | **PASS (schema-validated)** — web Vite + api Python 3.12 |
| Vercel upload exclusions (`.vercelignore`) | **PASS (config)** — excludes secrets/local state, keeps `frontend/.env.production` |
| Vercel request/response body cap | **PASS (mitigated)** — image upload limited to 4 MB; PDFs generated from them stay near the 4.5 MB response cap and must be spot-checked |
| Vercel files committed | **FAIL** — `vercel.json` edits and new Vercel files are uncommitted; CLI deploy works, Git deploy does not |
| Vercel serverless dependency set | **PASS (config)** — `requirements-vercel.txt` excludes `faster-whisper`/`pytest` |
| Python 3.12 runtime compatibility | **NOT TESTED** — local suite ran on Python 3.14.3 |
| Vercel serverless guards (`/api/backup` 503, `/api/restore` 409) | **PASS (tests)** |
| Production frontend env (`frontend/.env.production`) | **PASS** — `VITE_API_BASE_URL=/api`, voice disabled; not ignored by Git |
| Actual Vercel deployment / Preview URL | **NOT PERFORMED** |
| Vercel environment variables | **BLOCKED** — no project/token |
| Vercel Hobby commercial-use eligibility | **FAIL / owner decision** — Pro required for business use |
| Vercel Services feature maturity | **BETA** — schema valid, runtime unverified |
| Supabase production connectivity from Vercel | **NOT TESTED** |
| Supabase connection budget (serverless pool) | **NOT TESTED** — defaults to 10+10 per instance; tune `DB_POOL_SIZE`/`DB_MAX_OVERFLOW` before load |
| DNS/TLS | **BLOCKED** |
| Rollback plan | **PASS (documented), NOT TESTED** |
| Production runbook | **PASS (documented), NOT EXECUTED** |
| Oracle/Caddy fallback | **PASS (config), NOT TESTED** |

## 8. Cost and licensing

| Check | Status |
|---|---|
| Recurring cost target ₹0 | **CONFLICT** — Vercel Hobby is non-commercial; Pro ~US$20/mo |
| Paid API / model dependency | **NONE enabled** |
| Shipped dependency licences | **PASS** (no GPL/AGPL) |
| `onnx-community/whisper-small` licence | **UNVERIFIED** (voice disabled) |
| Free-tier terms re-checked on go-live day | **NOT DONE** |
| Logo ownership confirmed | **NOT DONE** |

## 9. Owner decisions

| # | Decision | Status |
|---|---|---|
| 1 | Hosting strategy | **DECIDED: Vercel (Services)**; Oracle/Caddy is fallback |
| 2 | Voice in production | **DECIDED: disabled (`VITE_VOICE_ENABLED=false`)** |
| 3 | FastAPI + Starlette (+ AnyIO) upgrade | **PENDING** — clears open advisories |
| 4 | Production migration `0003`/`0004` | **PENDING** — needs verified backup + approval |
| 5 | Staging/Preview resources (DB/buckets/domain) | **PENDING** |
| 6 | Free-tier risks (capacity, reclamation, Supabase pause, no SLA) | **PENDING** |
| 7 | Physical microphone / Tamil TTS | **DEFERRED** — required before re-enabling voice |
| 8 | Commit approval | **DECIDED: no commits yet** |
| 9 | Missing backup archive + independent backup destination | **PENDING** |
| 10 | Logo/asset ownership and Tamil model licence | **PENDING** |
| 11 | Vercel plan for commercial use (Pro) vs ₹0 target | **PENDING — blocking** |

## 10. Sign-off

| Role | Name | Decision | Date |
|---|---|---|---|
| Owner | — | **NOT APPROVED** | — |
| Engineering | — | **NOT READY** | — |
| Security | — | **NOT SIGNED OFF** | — |

## 11. Verdict

**Current label: NOT READY FOR PRODUCTION.**

The application is functionally complete for normal use on an isolated instance (156 backend tests,
19 frontend tests, 37 routes swept, full UI audit clean), and the Vercel configuration is valid.
Production readiness is still blocked by gates that require credentials, money or owner approval:

1. deploy to Vercel (Preview first) and verify `/api/health`, `/api` routing, headers, login and
   the Supabase connection;
2. resolve the Vercel plan conflict (Hobby is non-commercial; Pro costs money);
3. upgrade FastAPI/Starlette (+ AnyIO) and re-run the suite;
4. stand up staging and complete `STAGING_DEPLOYMENT_REPORT.md` §5;
5. establish an independent backup and restore it once;
6. apply `0003`/`0004` to production after a verified backup and explicit approval;
7. point DNS/TLS at the host and re-run this checklist.

Do not re-enable voice until `VOICE_ACCEPTANCE_REPORT.md` §7 passes with a real microphone.

The UI heuristic score is **82/100**; the remaining friction and missing elements are listed in
`DEPLOYMENT_READINESS_AUDIT.md` §0.3 (payment modal, app-managed confirmations, order
production/delivery status, tab deep links, pagination).
