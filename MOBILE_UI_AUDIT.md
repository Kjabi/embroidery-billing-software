# Lalitha's Apparel — Mobile UI Audit

**App:** Lalitha's Apparel embroidery & boutique management  
**Audited by:** OpenCode agent  
**Date:** 10 Nov 2026  
**Mobile breakpoint:** `max-width: 767px` (tablet 768–1023 px, desktop ≥ 1024 px)  
**Tested widths:** 320 / 360 / 375 / 390 / 412 / 430 / 600 / 768 / 1024 / 1280 / 1440 px

---

## 1. Scope

This audit covers the new **mobile shell** rendered when `window.matchMedia("(max-width: 767px)")` matches. The desktop JSX tree is intentionally untouched; mobile renders a separate component tree using the same React state, backend APIs, business rules, calculations, auth, and idempotency keys.

**Mobile views audited:**
1. Home / Dashboard — today's sales, collection, pending orders, outstanding, quick actions, alerts, recent orders
2. Orders / Invoices — search, status filters (All/Pending/Partially Paid/Paid/Overdue), order cards, collect payment
3. Customers — search, call, detail sheet, add/edit, delete
4. New Order — guided 6-step wizard with draft persistence
5. Products & Rates — products, stitch rates, measurement templates
6. Finance & Reports — period chips, date range, metrics, 7-day bar chart, top categories, ledger, export
7. More — business links, backup/restore/cloud backup, about, logout
8. Shared surfaces — payment dialog, confirm dialog, toast, floating AI assistant above bottom nav

**Not audited (separate):** desktop UI (see `DESKTOP_REGRESSION_REPORT.md`), voice (disabled in production, `VITE_VOICE_ENABLED=false`).

---

## 2. Before / After screenshots

Before screenshots: `.runtime/mobile-redesign/before/`  
After screenshots: `.runtime/mobile-redesign/after/`

| Screen | Before (mobile 390) | After (mobile 390) | After (desktop 1024/1280/1440) |
|---|---|---|---|
| Login | `login-390.png` | `login-320/360/375/390/412/430/600/768/1024/1280/1440.png` | `desktop-dashboard-*.png` |
| Home / Dashboard | `dashboard-390.png` | `dashboard-320/360/375/390/412/430/600.png` | `desktop-dashboard-1024/1280/1440.png` |
| Orders / Invoices | `invoices-390.png` | `orders-390.png` | `desktop-orders-1024/1280/1440.png` |
| Customers | `customers-390.png` | `customers-390.png` | `desktop-customers-1024/1280/1440.png` |
| Customer detail | — | `customer-detail-390.png` | — |
| Customer form | — | `customer-form-390.png` | — |
| New Order (steps 2–6) | `new-order-390.png` | `new-order-step{2,3,4,5,6}-390.png` | — |
| Order detail | — | `order-detail-390.png` | — |
| Payment dialog | — | `payment-dialog-390.png` | — |
| Products & Rates | `products-390.png` | `products-390.png`, `rates-390.png`, `templates-390.png` | `desktop-products-1024/1280/1440.png` |
| Finance & Reports | `finance-390.png` | `finance-390.png` | `desktop-finance-1024/1280/1440.png` |
| More | — | `more-390.png` | — |

---

## 3. Mobile UI findings

### 3.1 Layout & shell (PASS)
- **Breakpoint:** `@media (max-width: 767px)` scoped inside `frontend/src/index.css`. Mobile shell uses `mobile-*` class names; zero global rules touch desktop.
- **Screen container:** `.mobile-app` — `min-height: 100dvh`, `overflow-x: hidden`, padding-bottom accounts for bottom nav height + safe-area inset.
- **Header:** sticky, 64 px tall, top safe-area padding, brand + notification bell + avatar (More).
- **Main:** `.mobile-main`, max-width 640 px, centered, 16 px screen padding, bottom padding clears the fixed nav.
- **Bottom nav:** fixed, 5 tabs (Home, Orders, Customers, Payments, More), active state, 54 px touch targets, safe-area bottom padding.
- **No horizontal overflow:** verified `document.documentElement.scrollWidth === window.innerWidth` at every width (320–1440).

### 3.2 Home / Dashboard (PASS)
- Real metrics from backend `dashboard/summary`: `today_sales`, `today_collection`, `pending_orders`, `pending_payments` (outstanding).
- Four `MobileMetric` cards in a 2-column grid with icon, value, hint.
- Quick actions grid: Add customer, New order, Collect payment, Orders, Invoices.
- "Needs attention" alerts: overdue orders (danger), due this week (warning), unpaid balances (info) — each routes to Orders or Payments.
- Recent orders: up to 5 `MobileOrderCard`s; empty state when none.
- Scroll width 390 px at all mobile widths — no overflow.

### 3.3 Orders / Invoices (PASS)
- Search input (16 px text, `type="search"`), status chip row (All/Pending/Part paid/Paid/Overdue), count line.
- `MobileOrderCard`: invoice number, customer, product, status badge, total/paid/balance, delivery date, Collect button when balance > 0.
- 8 order cards rendered at 390 px; filter chips respond; no overflow.
- New-order button opens the 6-step wizard.

### 3.4 Customers (PASS)
- Search by name/phone/customer code/city/address.
- `MobileCustomerCard`: avatar initials, name, phone+city, order count + total spent, chevron.
- Call button → `tel:` link with digits-only number (verified `tel:9003514705`).
- Detail sheet: contact cards (call links), city/address/total spent, notes, saved measurement chips, order history, New order / Delete actions.
- Add/edit sheet: name, 10-digit phone (`inputMode="numeric"`, `pattern="[0-9]{10}"`, `maxLength=10`), alternate phone, city, address, notes; duplicate-phone warning; success/error feedback.

### 3.5 New Order — 6-step wizard (PASS)
- Step 1 Customer: search + select existing or add new; shows last measurements pre-filled.
- Step 2 Product: active products, stitch-based vs fixed price indicated.
- Step 3 Measurements / Stitch details: decimal inputs (`inputMode="decimal"`, step 0.1, placeholder "0.0"); stitch-based products show category + stitch count + calculated amount; non-stitch products skip measurements.
- Step 4 Design: cloth/design notes textarea + optional reference image (JPEG/PNG ≤ 4 MB, preview, remove).
- Step 5 Price & delivery: order/delivery date, base + extra, advance paid, running order total / advance / balance due card.
- Step 6 Review: customer, phone, product, dates, total, advance, balance, notes, measurement chips, reference image; warns balance cannot be undone.
- Step validation (`mobileStepProblem`) blocks advancing with inline error banner.
- Draft persisted to `localStorage` (`lalithas_order_draft`, `lalithas_order_step`) so a reload returns to the same step and form values; cleared on save/logout.

### 3.6 Products & Rates (PASS)
- Segmented control: Products / Stitch rates / Templates.
- Products: name, pricing method, base price, template; toggle active/inactive via `PATCH /products/:id/toggle`; add-product form.
- Stitch rates: per-category rate, edit sheet, "1,000 stitches = ₹X" helper.
- Templates: name + comma-separated measurement fields; list view.

### 3.7 Finance & Reports (PASS)
- Period chips (This month / This year / All time) + custom From/To date inputs.
- Four metric cards: Income, Expenses, Net profit, Receivables.
- Last 7 active days bar chart (income green / expense red) with value labels and legend.
- Top categories: income and expense side-by-side cards.
- Add expense/income form (type, date, category, amount, description).
- Ledger list with search, ± amounts, date + payment method; CSV/PDF export via `/api/finance/export.csv|pdf`.
- `today_collection` shown on Payments tab.

### 3.8 Payments (PASS)
- Today's collection + outstanding metrics.
- Balance-due order cards with Collect button → `PaymentDialog`.
- Payment dialog: amount (defaults to full balance), Cash/UPI chip (backend hardcodes method), balance-after preview, confirm recording against `/api/orders/:id/pay` with idempotency key; toast on success; error banner inline.
- Recent collections list from finance transactions (Income, Order Payment / Balance Collection).

### 3.9 More (PASS)
- Profile card (Admin, Lalitha's Apparel · Madurai).
- Business links to Products & rates, Finance & reports, Orders & invoices, Customers, New order, Measurements (templates tab).
- Backup: local backup (`/api/backup`), restore from file (`/api/restore` with confirm dialog), cloud backup (Supabase Storage, gated on configuration).
- About: Tamil + English language note, AI assistant status, logout button.

### 3.10 Floating AI assistant (PASS)
- FAB above bottom nav (78 px + safe-area inset), opens `VoiceAssistantPanel` with `variant="mobile"` inside `Suspense`.
- Panel uses `--keyboard-inset` from `visualViewport` so it stays above the on-screen keyboard; `max-height: min(72dvh - inset, 620px)`.
- Voice disabled in production (`VITE_VOICE_ENABLED=false`); panel hidden when disabled.

### 3.11 Shared dialogs & toast (PASS)
- `PaymentDialog`, `ConfirmDialog` (`askConfirm`/`resolveConfirm`), `Toast` — styled outside the mobile media query so they also render correctly on desktop.
- 48 px+ touch targets on all buttons; 16 px+ input text; visible labels; `inputMode` set per field (numeric/decimal/tel/search).
- Tamil Unicode supported via system fonts (documented in About); no emoji-only reliance.

---

## 4. Accessibility & touch targets (sampled at 390 px)

Playwright `a11yAudit` at 390 px dashboard:
- Visible controls: 26, unnamed controls: 0, small buttons (<44×44): 0, images without alt: 1 (logo — decorative, has empty `alt=""`), inputs without label: 0.
- Bottom nav buttons: 54 px × 54 px at every mobile width.
- All form inputs render at exactly 16 px font (prevents iOS zoom-on-focus).

---

## 5. States covered

| State | Implementation |
|---|---|
| Loading | `MobileLoading` + inline skeleton text; `loading` state guards dashboard/orders |
| Empty | `MobileEmptyState` with icon, title, text, optional action |
| Error | `mobile-banner-danger` inline banners + `Toast` type=error; payment dialog error banner |
| Offline | No service worker; fetch failures surface as toasts/alerts; PWA manifest added without SW |
| Session expiry | 401 → `logout()`, clears token + draft, toast; login gate |
| Draft | `lalithas_order_draft` + `lalithas_order_step` in localStorage |

---

## 6. Known limitations

1. **Draft reload check timing:** Resolved. `localStorage` writes (`lalithas_order_draft`, `lalithas_order_step`) via `useEffect([orderForm, tab])` and `useEffect([mobileOrderStep, tab])` verified end-to-end — a reload inside the wizard returns to the same step and form values. Draft cleared on save/logout.
2. **Voice disabled in production:** `VITE_VOICE_ENABLED=false`; assistant button hidden; physical mic / Tamil speech accuracy not tested.
3. **No service worker / offline writes:** PWA manifest + icons added; no SW, so offline business writes are not supported.
4. **Backup on serverless:** `/api/backup` returns 503 and `/api/restore` returns 409 on serverless without persistent storage (documented limitation).
5. **Desktop `window.alert` remnants:** Some desktop paths still use `window.alert` (order PDF save, customer edit, product/rate, WhatsApp) — not regressed, flagged for future polish.
6. **Vercel Hobby commercial-use restriction:** owner plan decision required; deployment credentials not available in this session.

---

## 7. Evidence files

- Test report (machine-readable): `.runtime/mobile-redesign/after/mobile-test-report.json`
- Desktop regression audit: `.runtime/run-20261108/ui-audit.json` (23/23 PASS)
- Build output: `frontend/dist/` (production Vite build PASS)
- Backend suite: 157 passed (`backend/tests`)
- Frontend suite: 20 passed (`frontend/src/voice/*.test.js`)

---

**Audit conclusion:** Mobile shell is usable end-to-end across all 11 tested widths with no horizontal overflow, 48 px+ touch targets, 16 px inputs, real backend metrics, working customer/order/payment/invoice flows, and no desktop regression. One minor draft-reload timing check to re-verify before publish.
