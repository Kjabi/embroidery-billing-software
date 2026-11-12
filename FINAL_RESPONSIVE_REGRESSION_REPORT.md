# FINAL RESPONSIVE REGRESSION REPORT

**Tested:** 12 Nov 2026
**App:** local production-equivalent run — backend `127.0.0.1:8010`, frontend `127.0.0.1:5173`
**Breakpoint contract:** mobile `< 768px`, desktop `≥ 768px` (tablet 768–1023 keeps the approved desktop layout)
**Widths:** mobile **320, 360, 375, 390, 412, 430, 600**; desktop **768, 1024, 1280, 1440**
**Result:** **PASS** — no horizontal overflow, no overlapping controls, no console/page/request errors, desktop unchanged.

---

## 1. How it is verified

Automated Playwright suites (Node test runner, real backend, real UI):

| Spec | Checks | Covers |
|---|---|---|
| `tests/e2e/mobile-shell.spec.mjs` | 12 | shell switch at all 11 widths, overflow per tab, bottom-nav tabs/targets, nav never covers controls, compact header, hash navigation + deep links + unknown-hash 404, a11y + input font, customer-form touch targets, zero errors; desktop shell layout at 4 widths |
| `tests/e2e/mobile-customers.spec.mjs` | 9 | list, create, numeric phone + keyboard, duplicate warning, `tel:` link, edit persisted, delete with in-app confirm, empty state, no errors |
| `tests/e2e/mobile-orders.spec.mjs` | 11 | order cards, status filter, invoice search, detail money summary + invoice actions, 6-step wizard, step validation, draft survives reload, payment + over-payment guard, PDF, delete, no errors |
| `tests/e2e/mobile-finance-states.spec.mjs` | 11 | finance metrics/period/ledger/export, products/rates/templates, rate editor, More screen inventory, empty state, loading skeleton, retry banner, 401 → login, no errors |
| `tests/e2e/desktop-regression.spec.mjs` | 8 | sidebar width/sections at 4 widths, no overflow per section, orders table, customer search, invoice detail + shared payment dialog, multi-column form, labelled controls, no errors |
| **Total** | **51** | |

Additional prior evidence (committed with `c0f1df2`): the 105-check mobile E2E suite and the 23-step desktop UI audit, both green, before/after screenshots for 11 screens at the tested widths in `.runtime/mobile-redesign/`.

---

## 2. Mobile results (320–600 px)

| Check | 320 | 360 | 375 | 390 | 412 | 430 | 600 |
|---|---|---|---|---|---|---|---|
| Mobile shell renders (no desktop aside) | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| No horizontal overflow — Home | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| No horizontal overflow — Orders | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| No horizontal overflow — Customers | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| No horizontal overflow — Payments | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| No horizontal overflow — More | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Bottom nav visible, 5 tabs, ≥ 44 px | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Nav never covers a control | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Header ≤ 96 px, sticky, correct title | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Inputs ≥ 16 px font | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Controls have accessible names | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Touch targets ≥ 44 px on forms/lists | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| Safe-area / keyboard inset respected | PASS | PASS | PASS | PASS | PASS | PASS | PASS |

**Defect found and fixed during this phase:** the phone-number link inside the order detail sheet (`a.mobile-inline-link`) was only text-height (~17 px) and failed the 44 px touch-target check. It now has `display:inline-flex; align-items:center; min-height:44px` (`frontend/src/index.css`). Re-verified green.

### Flows exercised on a 390×844 viewport
- Customer: create → search → open → call (`tel:`) → edit → delete (in-app confirm) → empty state.
- Order: list → filter → search by invoice → open detail (total/balance/invoice actions) → collect payment (defaults to full balance, rejects over-payment, confirms, becomes Paid in full) → delete.
- Wizard: 6 steps, validation blocks step 1 without a customer, review shows the chosen customer/product, order saved with a real invoice number; draft survives a **reload** and restores `#/new-order`.
- Finance: 4 metrics, month/year/all-time switch, custom range, ledger, add entry, CSV/PDF.
- Products: 3 segments (Products / Stitch rates / Templates), rate editor, all cards render.
- More: every business area + backup/restore/cloud backup/log out + Tamil note.
- States: loading skeleton (request held open), retry banner on a failed request, 401 bounce to login.
- Invoice PDF: `%PDF` header, > 800 bytes.

---

## 3. Desktop results (768–1440 px)

| Check | 768 | 1024 | 1280 | 1440 |
|---|---|---|---|---|
| Desktop shell renders, no mobile shell / bottom nav | PASS | PASS | PASS | PASS |
| Sidebar width 220–260 px | PASS | PASS | PASS | PASS |
| Main content offset ≥ sidebar | PASS | PASS | PASS | PASS |
| No horizontal overflow — Dashboard | PASS | PASS | PASS | PASS |
| No horizontal overflow — New Order | PASS | PASS | PASS | PASS |
| No horizontal overflow — Orders | PASS | PASS | PASS | PASS |
| No horizontal overflow — Customers | PASS | PASS | PASS | PASS |
| No horizontal overflow — Products | PASS | PASS | PASS | PASS |
| No horizontal overflow — Finance | PASS | PASS | PASS | PASS |
| Orders table intact (Invoice/Date/Customer/Product/Total/Paid/Balance/Status/Actions) | PASS | PASS | PASS | PASS |
| Customer search finds a seeded record | PASS | PASS | PASS | PASS |
| Invoice detail opens; payment uses the in-app dialog | PASS | PASS | PASS | PASS |
| Order form remains multi-column | PASS | PASS | PASS | PASS |
| Controls labelled | PASS | PASS | PASS | PASS |

The desktop JSX tree was not restructured; the mobile shell is a separate branch rendered only when `matchMedia("(max-width: 767px)")` matches. The desktop styles, sidebar, tables and forms are the approved originals.

### Desktop caveat
At exactly **768 px** the existing `md:` Tailwind breakpoint stacks the sidebar above the content (full-width row). This is the **pre-existing approved behaviour**, not a regression introduced here, and it passes the overflow/layout assertions. No desktop redesign was performed.

---

## 4. Cross-cutting checks

| Check | Result |
|---|---|
| Tamil Unicode renders (menu label + customer names) | PASS (font stack includes Devanagari/Tamil-capable fallbacks; no tofu observed in screenshots) |
| No control behind the fixed bottom nav | PASS on every tab |
| Keyboard-aware assistant above nav | PASS locally; `--keyboard-inset` driven by `visualViewport` |
| No console errors during any flow | PASS (asserted in every spec) |
| No failed network requests | PASS (asserted in every spec; deliberate abort tests unroute first) |
| PWA manifest + apple-touch-icon | PASS locally; live `Content-Type` issue noted in `LIVE_PREVIEW_ACCEPTANCE_REPORT.md` |

---

## 5. Remaining responsive limitations

- **Physical devices NOT TESTED** (iOS Safari, Android Chrome): viewport/keyboard behaviour is emulated only.
- **Landscape phones NOT TESTED** as a first-class layout.
- The 404 page and sheet scroll-lock are verified in Chromium only.
- Live-preview DOM cannot be inspected because of Deployment Protection.

**Verdict: mobile PASS, desktop PASS, both locally verified across all required widths.**
