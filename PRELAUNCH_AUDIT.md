# Pre-launch Audit

Audit date: 2026-11-07. Scope: local repository and local browser smoke tests.
No production data, Storage object, payment, email, DNS, or deployment action
was performed.

## Launch checklist

| Task | Status | Evidence | Fix or remaining action |
|---|---|---|---|
| Mobile layout | PASS (local login; authenticated UI needs backend session) | Chromium at 320, 375, 414, 768, 1024, 1440px; no horizontal overflow; viewport meta present; login target 48px | Added mobile sidebar/static layout and 44px navigation targets in `frontend/src/index.css` |
| Responsive screenshots | PASS (local evidence) | `.runtime/prelaunch-screenshots/lalitha-{320,375,414,768,1024,1440}.png` | Authenticated-page screenshots require a test admin session |
| Links/content | PASS (static scope) | No public contact form or external social links found; WhatsApp links normalize Indian 10-digit numbers to `91...`; image alts present in inspected UI | Crawl production routes after deployment |
| Contact form | BLOCKED / NOT IMPLEMENTED | No contact endpoint or contact form exists in the repository | Add an authenticated or dedicated form, spam control, delivery provider, and endpoint tests if required |
| Lighthouse | BLOCKED | Lighthouse CLI unavailable; production URL not supplied | Run mobile/desktop Lighthouse against deployed URL and record LCP, CLS, TBT |
| Local frontend performance | PASS WITH WARNING | Vite build passed; finance 429.51kB and Transformers 598.65kB chunks remain | Further split chart/speech bundles; do not claim Lighthouse target yet |
| Security headers | PASS locally / CONFIGURED for Vercel | FastAPI returns `nosniff`, `DENY`, `no-referrer`, Permissions-Policy; Vercel config now adds HSTS and CSP | Verify deployed response headers and CSP compatibility |
| Secret exposure | PASS static scan | No service-role key or backend secret value found in frontend source/bundle; backend-only values stay in root env | Recheck deployed bundle after each build |
| CORS | PASS by code inspection | `FRONTEND_ORIGIN` allowlist is used; wildcard is not configured | Verify production origin exactly matches environment configuration |
| Browser compatibility | PARTIAL | Chromium passed at 375px; Firefox/WebKit executables are not installed locally | Install pinned Playwright browsers and run full matrix |
| WhatsApp | PASS by code inspection | `wa.me/{country-code}{number}` and encoded message are generated | Manually verify on iOS, Android, desktop with a test number |
| Email/DNS | BLOCKED | No email provider, SPF/DKIM/DMARC integration, or contact delivery path found | Configure provider and verify DNS plus Gmail/Outlook delivery |
| Payments | PASS by local tests / production sandbox BLOCKED | Existing order/payment idempotency keys and unique transaction index are present; backend security tests cover duplicate/idempotent behavior | Execute only against payment sandbox and verify provider/webhook requirements if introduced |
| Invoice allocation | PASS by code/tests | Existing invoice allocation repair and concurrency-safe sequence logic are covered by backend tests | Confirm production migration/state before launch |
| SEO/analytics | BLOCKED / NOT APPLICABLE TO ADMIN APP | Title and favicon exist; no GA, sitemap, LocalBusiness schema, or public marketing pages | Keep admin app `robots.txt` disallow-all; add public SEO only if a public site is introduced |
| Backups/recovery | BLOCKED production verification | Local backup/cloud-backup code and deployment documentation exist; no production GitHub/Supabase access available | Trigger GitHub backup manually, verify manifest/checksums, and execute staging restore drill |

## Before/after Lighthouse

| Metric | Before | After |
|---|---:|---:|
| Performance | Not measured | Not measured (CLI/deployed URL unavailable) |
| LCP | Not measured | Not measured |
| CLS | Not measured | Not measured |
| TBT | Not measured | Not measured |

The Vite production build passes but is not a Lighthouse substitute.

## Files changed

- `frontend/src/index.css` — mobile sidebar no longer remains fixed at desktop
  width; navigation gets usable mobile tap targets.
- `vercel.json` — adds HSTS, CSP, frame, referrer, content-type, and
  permissions headers for the web service.
- `frontend/public/robots.txt` — prevents indexing of the authenticated admin
  application.
- `PRELAUNCH_AUDIT.md` — records evidence, fixes, and blocked checks.

## Prioritized blockers

### Critical

None proven by local inspection.

### High

1. Production HTTPS certificate, redirect, Vercel headers, CORS origin, and
   Supabase private-bucket behavior are not verified against the deployed URL.
2. Backup scheduling and staging restore have not been executed in this audit.
3. There is no contact/email workflow, so contact-form acceptance criteria are
   not applicable until that feature is defined.

### Medium

1. Lighthouse metrics are unavailable; large finance and speech chunks remain.
2. Firefox and WebKit browser binaries are unavailable locally.
3. Email DNS/provider delivery and payment-provider sandbox/webhook checks are
   not configured or verifiable from this repository.

## Final verdict

**NO-GO for an evidence-based production launch sign-off.**

The local frontend tests, build, responsive Chromium smoke checks, backend
security headers, and existing payment idempotency protections pass. Production
HTTPS/DNS, backups/recovery, cross-browser coverage, Lighthouse targets, and
email/payment-provider verification remain unproven.
