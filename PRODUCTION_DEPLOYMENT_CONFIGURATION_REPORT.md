# PRODUCTION DEPLOYMENT CONFIGURATION REPORT

**Audited:** 12 Nov 2026
**Verdict:** **BLOCKED** — no Production deployment has ever been created, and the project is not configured for a safe promotion yet. No settings, domains, aliases, DNS or env vars were changed.

---

## 1. Current facts

| Item | Observed value |
|---|---|
| Vercel project | `embroidery-management` (`prj_1Ix6az2rnzQKM8iAzfZig7LywcFK`) |
| Scope | `abirudhu-4618s-projects` |
| Root directory | `.` |
| Framework preset | `services` (Vercel's generic preset; `vercel.json` supplies the Vite build) |
| Build command | Project: *None* → `vercel.json`: `cd frontend && npm ci && npm run build` |
| Output directory | Project: *None* → `vercel.json`: `frontend/dist` |
| Node.js | 26.x |
| Region | `iad1` |
| Deployments | **1 total** — `dpl_8G17QsAwHAVu6swKA2TxVMrFZSAZ`, **target = `preview`**, status Ready, commit `c0f1df2`, 24 h old |
| Production deployments | **0** (`vercel ls --environment=production` → “No deployments found”) |
| Deployment aliases | **None confirmed** for the preview |
| Project domains | Exist per the project overview, but **not assigned to any deployment** (no production deployment to alias) |
| Git remote | `origin → https://github.com/Kjabi/embroidery-billing-software.git` |
| Deployed commit vs Git HEAD | **Identical** (`c0f1df2759…`) |

---

## 2. Why is the latest deployment Preview?

The deployment was produced with `target: preview`. That is the behaviour of a **manual/CLI deploy or a Git integration that is not assigned to a Production branch**. Because **`main` has never produced a Production deployment**, the most likely causes are one of:

1. The project was created/linked in a way that only registers Preview builds (no Production Branch assignment yet), or
2. The deployment was deliberately created as a preview (e.g. `vercel deploy` without `--prod`), or
3. The Git integration is not connected for production deploys on this project.

The Vercel CLI's `project inspect` output does not expose `productionBranch`, and the project settings API was not queried with a mutation token, so **cause (1) vs (2) vs (3) cannot be distinguished from the evidence available**. What is certain: `target=preview` and zero production deployments.

### Deployment protection
The preview is behind **Vercel Authentication**: unauthenticated HTTP requests get `302` to the auth gate. This blocks automated browser acceptance (see `LIVE_PREVIEW_ACCEPTANCE_REPORT.md`) and must be explicitly decided by the owner.

---

## 3. What is already correct

- `vercel.json` matches the repo layout (root directory `.`, `frontend/` build, `frontend/dist` output).
- `/api` and `/api/*` are rewritten to the single FastAPI function; everything else is the SPA — same-origin, so CORS is not needed.
- Security headers are live: HSTS, `nosniff`, `DENY`, `no-referrer`, `Permissions-Policy`, a strict CSP with `frame-ancestors 'none'`.
- Immutable caching for `/assets/*` and the logo.
- 4 MB upload cap under Vercel's 4.5 MB body limit.
- The deployed commit is the current `origin/main` HEAD.
- Build is reproducible: `npm ci` + `vite build`, 0 vulnerabilities.

## 4. What is wrong or missing

| # | Issue | Impact | Fix |
|---|---|---|---|
| P1 | No Production deployment exists | No public production URL resolves to this app | Approve a production deploy/promotion |
| P2 | Preview is protected by Vercel Authentication | Cannot run browser acceptance | Owner decision: disable protection for the preview only, or use a Protection Bypass token |
| P3 | Preview shares the **production** Supabase DB + buckets (see `SUPABASE_ENVIRONMENT_AUDIT.md`) | Any preview write test mutates real business data | Create a staging Supabase project and Preview-scoped env vars |
| P4 | `/assets/manifest.webmanifest` is served as `text/html` | PWA manifest may be ignored by some browsers | Add a `headers` rule mapping the file to `application/manifest+json` |
| P5 | No production-branch confirmation | A merge to `main` may not produce a production deploy | Confirm/assign `main` as the Production Branch in project settings |
| P6 | No rollback target exists | Nothing to roll back to | The first production deploy should be treated as the rollback baseline |
| P7 | Python runtime is 3.12, suite ran on 3.14.3 | Hidden runtime incompatibility risk | Install 3.12, re-run the 157 backend tests |
| P8 | No function `maxDuration` | Long cloud backups could hit the platform timeout | Measure, then set an explicit duration if needed |

---

## 5. Safe release plan (requires owner approval at each starred step)

1. **Local (done):** dependency fix, bundle/WASM fix, full local test suite, production build.
2. Create a **staging Supabase project**; copy schema migrations `0003`/`0004` there; repoint **Preview** env vars to staging. *(infra change ★)*
3. Deploy a fresh **Preview** from the current commit: `vercel deploy` (no `--prod`), or push to a non-production branch. *(★)*
4. Allow browser acceptance:
   - either disable Deployment Protection on the Preview scope only, *(setting change ★)*
   - or generate a Protection Bypass token and use it in Playwright. *(token ★)*
5. Run the full E2E suite against staging (`BASE_URL=<preview>`, `API_URL=<preview>/api`) — customers, orders, payments, invoices, uploads, reports, mobile + desktop, states.
6. Run the API suite against staging if a Python 3.12 environment can reach it.
7. Confirm `main` is the Production Branch. *(setting confirmation ★)*
8. Promote the **already-tested** deployment to production (`vercel promote <url>`), or `vercel --prod` from the tested commit. *(deployment ★)*
9. Verify the production domain: `/` 200, `/api/health` 200, admin login, one read-only workflow, security headers, asset caching.
10. Keep the previous production deployment as the rollback target (`vercel rollback`). Document the exact command and the deployment ID.
11. Re-enable Deployment Protection for future previews if it was disabled.

**Do not:** change domains/DNS, billing, production env vars, or run production migrations in this plan without a separate approval.

---

## 6. Rollback plan (once production exists)

```bash
vercel ls --environment=production                 # find the previous READY deployment
vercel promote <previous-deployment-url>           # instant alias swap, no rebuild
```
- Static assets are immutable and content-hashed, so an alias swap is instantaneous.
- The database schema is forward-only; a rollback of code that depends on a new column requires a paired DB decision. No schema change was made in this phase.
- Backups: confirm `SUPABASE_BACKUP_BUCKET` contains a recent snapshot before any future migration.

---

## 7. Verdict

**BLOCKED.** Deployment mechanics and headers are sound, but the project has never produced a production deployment, the preview is auth-gated, preview and production share data, and the production branch is unconfirmed. Nothing was changed. Steps 2–11 above are ready to execute on approval.
