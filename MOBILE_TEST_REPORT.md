# Lalitha's Apparel — Mobile Test Report

**App:** Lalitha's Apparel embroidery & boutique management  
**Date:** 10 Nov 2026  
**Environment:** Backend `http://127.0.0.1:8010` (SQLite, `.runtime/run-20261108/`), Frontend `http://127.0.0.1:5173` (Vite dev server), Playwright Chromium headless  
**Login:** `admin` / `admin12345`

---

## 1. Test suites executed

| Suite | Command | Result |
|---|---|---|
| Backend release hardening | `.venv/bin/python -m pytest backend/tests -q` | **157 passed**, 0 failed |
| Frontend voice unit tests | `npm test` (`src/voice/*.test.js`) | **20 passed**, 0 failed |
| Production Vite build | `npm run build` | **PASS** — `frontend/dist/` |
| Desktop Playwright audit | `.runtime/pw/ui_audit.mjs` | **23/23 PASS**; 0 console/page/request errors; 0 overflow at 1440/768/390 |
| Mobile responsive suite | `.runtime/pw/mobile_suite.mjs` | **105/105 checks PASS**; 0 console/page/failed-request errors |

---

## 2. Mobile suite — widths and checks

**Tested widths:** 320, 360, 375, 390, 412, 430, 600, 768, 1024, 1280, 1440 px  
(≤ 767 px renders mobile shell; ≥ 768 px renders desktop shell)

For every width the suite verified:
- Login screen renders; shell mode correct (mobile app vs desktop aside)
- No horizontal overflow (`document.documentElement.scrollWidth === window.innerWidth`)
- Mobile: bottom-nav buttons ≥ 44 px (actual 54×54 px at all mobile widths)
- Mobile: form inputs render at exactly 16 px font
- Mobile: all four tabs (Orders, Customers, Payments, More) load without overflow

Desktop widths additionally verified aside width = 240 px and `main margin-left = 240px`.

**Width-by-width result:** all 11 widths passed every applicable check. No horizontal overflow at any width.

---

## 3. End-to-end mobile flow (390 px iPhone)

All steps passed:

| Step | Action | Result |
|---|---|---|
| Login | admin / admin12345 | ✅ Dashboard renders in mobile shell |
| Customers list | 11 customer cards | ✅ |
| Create customer | "Mobile Check {run}", phone, city, notes | ✅ Saved; sheet closes; customer appears in list |
| Search | Filter by new customer name | ✅ Single match |
| Call link | `tel:` with digits-only number | ✅ `tel:9003514705` |
| Customer detail | Contacts, city, total spent, notes, measurements, orders | ✅ |
| Edit customer | City changed → saved | ✅ Sheet closes; update reflected |
| New order wizard | Step 1 customer → Step 2 product (Saree Falls) → Step 3 design (measurements skipped for fixed-price product) → Step 4 design notes → Step 5 price (advance ₹50 of ₹150) → Step 6 review (balance ₹100) | ✅ All 6 steps |
| Save order | POST `/api/orders` idempotency key | ✅ 200, `INV-2026-014` created |
| Order detail | Balance due ₹100; invoice actions (PDF, WhatsApp, Send PDF, Ready); Collect ₹100 | ✅ |
| Collect payment | PaymentDialog defaults to full balance ₹100; confirm | ✅ Order shows "Paid in full", balance ₹0 |
| Invoice PDF | GET `/api/orders/:id/pdf` | ✅ 200, `application/pdf`, 46,993 bytes |
| Draft persistence | Type design note, reload, returns to step with note intact; hash `#/new-order` preserved | ✅ |
| Delete order | Via order detail → confirm dialog → removed | ✅ |
| Delete customer | Via customer detail → confirm dialog → removed; list refreshes | ✅ |
| Products / Rates / Templates | Segmented tabs render at 390 px; no overflow | ✅ |
| Finance & Reports | Metrics, 7-day chart, categories, ledger, export buttons | ✅ |
| More | Backup, about, logout links render | ✅ |

---

## 4. Accessibility sample (390 px dashboard)

Playwright `a11yAudit`:
- Visible controls: 26
- Unnamed controls: 0
- Small buttons (< 44 × 44 px): 0
- Images without alt: 1 (logo — decorative, `alt=""`)
- Inputs without label element: 0

---

## 5. Console / network / errors

| Category | Count |
|---|---|
| Console errors | 0 |
| Page errors | 0 |
| Failed requests | 0 |

---

## 6. Desktop regression (from desktop audit)

| Check | Result |
|---|---|
| Desktop shell at 1024/1280/1440 | Aside 240 px, main margin-left 240 px |
| Horizontal overflow | None |
| Unnamed controls | None |
| Small buttons | None |
| Images without alt | 0 |
| Inputs without label | 0 |
| Console/page/request errors | 0 |

Desktop UI is unchanged — no global CSS regressions.

---

## 7. Screenshots captured

**Before:** `.runtime/mobile-redesign/before/` — login, dashboard, customers, new-order, invoices, finance, products at 390 px; desktop equivalents at 1440 px.

**After:** `.runtime/mobile-redesign/after/` —
- Mobile (390 px): login, dashboard, customers, customer-form, customer-detail, orders, payments, more, products, rates, templates, finance, new-order steps 2–6, order-detail, payment-dialog
- Mobile (all widths): login-320/360/375/390/412/430/600/768, dashboard-320/360/375/390/412/430/600
- Desktop (1024/1280/1440): desktop-dashboard, desktop-customers, desktop-orders, desktop-finance, desktop-products

---

## 8. Known limitations

1. **PWA has no service worker:** manifest + icons installed, but offline business writes are not supported.
2. **Serverless backup:** `/api/backup` → 503, `/api/restore` → 409 without persistent storage.
3. **Voice disabled in production:** `VITE_VOICE_ENABLED=false`; physical mic / Tamil speech not tested.
4. **Python 3.12 runtime on Vercel:** not locally tested (suite runs on Python 3.14.3).
5. **Vercel deployment:** not executed in this session (no credentials; owner plan decision re: Hobby commercial-use restriction).

---

## 9. Conclusion

All 105 mobile checks pass across 11 viewport widths, all end-to-end flows (customer CRUD, 6-step order wizard with drafts, payment collection with idempotency, invoice PDF, delete with confirmation) succeed, accessibility/touch-target/font-size requirements are met, and the desktop regression audit remains 23/23 with zero errors. The mobile implementation is ready for the owner's pre-commit review.
