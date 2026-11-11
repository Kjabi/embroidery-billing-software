# Lalitha's Apparel — Mobile Navigation Structure

**App:** Lalitha's Apparel embroidery & boutique management  
**Date:** 10 Nov 2026  
**Breakpoint:** mobile `max-width: 767px`; tablet 768–1023 px; desktop ≥ 1024 px

---

## 1. Navigation model

Mobile uses a **fixed bottom tab bar** (5 tabs) plus a **header** (brand + bell + avatar/More). Desktop keeps its existing left sidebar + top header — the mobile shell is a separate React branch behind `matchMedia("(max-width: 767px)")`; desktop JSX is never rendered on phone widths.

Tab state is mirrored to the URL hash (`#/dashboard`, `#/invoices`, `#/customers`, `#/payments`, `#/more`, `#/new-order`) so refresh and deep links land on the right screen.

---

## 2. Bottom navigation (always visible on mobile)

| Tab | Label | Icon | Route | Purpose |
|---|---|---|---|---|
| 1 | Home | `Home` | `#/dashboard` | Today's sales, collection, pending orders, outstanding; quick actions; alerts; recent orders |
| 2 | Orders | `Receipt` | `#/invoices` | Search + status-filtered order cards; collect payment; new order |
| 3 | Customers | `Users` | `#/customers` | Search customers; call; detail sheet; add/edit/delete |
| 4 | Payments | `Wallet` | `#/payments` | Today's collection, outstanding, balance-due cards, recent collections |
| 5 | More | `Menu` | `#/more` | Business links, backup/restore/cloud backup, about, logout |

**Navigation behavior:**
- Active tab highlighted (`#eff6ff` background, indigo text).
- Bell shows an orange notification dot when `pending_orders > 0`.
- Tapping the active tab again does nothing (no reload).
- Hash changes (browser back/forward, deep links) update `tab` via `hashchange` listener; `tab` updates write back to hash via `replaceState`.

---

## 3. Header (sticky, top)

| Element | Action |
|---|---|
| Brand (logo + "Lalitha's Apparel" + current screen title) | Navigate to Home (`#/dashboard`) |
| Bell (`Bell` icon) | Navigate to Orders (`#/invoices`); orange dot when orders pending |
| Avatar (`A` in indigo circle) | Navigate to More (`#/more`) |

Header height 64 px with top safe-area inset; sticky with backdrop blur.

---

## 4. Screen-by-screen structure

### 4.1 Home / Dashboard (`#/dashboard`)

- **Hero:** date eyebrow, greeting ("Good morning/afternoon/evening, Admin"), subtitle.
- **Metric grid (2×2):** Today's sales, Today's collection, Pending orders, Outstanding.
- **Quick actions (5 buttons):** Add customer, New order, Collect payment, Orders, Invoices.
- **Needs attention (alerts):** Overdue orders / Due this week / Unpaid balances — each routes to Orders or Payments; hidden when empty.
- **Recent orders:** up to 5 order cards; "View all" → Orders; empty state when none.

### 4.2 Orders / Invoices (`#/invoices`)

- Header: title + "New" button → wizard step 1.
- Search box (`type="search"`, 16 px).
- Status chip row: All / Pending / Part paid / Paid / Overdue.
- Count line ("N of M order(s)").
- Order cards list; each card: open detail / Collect payment.
- Empty state when no matches.

### 4.3 Customers (`#/customers`)

- Header: title + "Add" button → add-customer sheet.
- Search box (name / phone / code / city / address).
- Count line.
- Customer cards list; tap → detail sheet; Call button → `tel:`.
- Detail sheet: contacts (call links), city/address/total spent, notes, saved measurements, order history, New order / Delete.
- Add/edit sheet: name, 10-digit phone, alternate phone, city, address, notes; duplicate-phone warning.

### 4.4 New Order (`#/new-order`) — 6-step wizard

1. **Customer** — search/select existing or add new; last measurements pre-filled.
2. **Product** — choose active product; stitch-based vs fixed price shown.
3. **Measurements / Stitch details** — decimal inputs per template field, or stitch count + category for stitch-based.
4. **Design** — cloth/design notes textarea + optional reference image (JPEG/PNG ≤ 4 MB).
5. **Price & delivery** — dates, base/extra, advance paid; running total/advance/balance card.
6. **Review** — summary + confirmation; "Save order" creates the order via `/api/orders` with idempotency key.

Draft (`customer_id`, `product_id`, dates, amounts, measurements, step number) persisted to `localStorage`; survives reload; cleared on save or logout.

### 4.5 Products & Rates (`#/products`)

Segmented control: **Products** / **Stitch rates** / **Templates**.
- Products: list with toggle active/inactive; add-product form.
- Stitch rates: per-category rate + edit sheet.
- Templates: name + comma-separated fields; list view.

### 4.6 Finance & Reports (`#/finance`)

Period chips (This month / This year / All time) + custom From/To date inputs.
- Metric grid: Income, Expenses, Net profit, Receivables.
- 7-day bar chart (income / expense).
- Top categories (income / expense cards).
- Add expense/income form.
- Ledger list with search + CSV/PDF export.

### 4.7 Payments (`#/payments`)

- Metric grid: Today's collection, Outstanding.
- Balance-due order cards with Collect → `PaymentDialog`.
- Recent collections list (Income / Order Payment / Balance Collection).

### 4.8 More (`#/more`)

- Profile card: Admin, Lalitha's Apparel · Madurai.
- **Business:** Products & rates, Finance & reports, Orders & invoices, Customers, New order, Measurements (opens Products → Templates tab).
- **Backup:** Backup database, Restore from file, Cloud backup (gated on Supabase Storage config).
- **About:** Application, Business, AI assistant (disabled in production), Languages (English · தமிழ்).
- **Logout** (danger outline, full-width).

---

## 5. Overlays (non-nav)

| Overlay | Trigger | Dismiss |
|---|---|---|
| Customer detail sheet | Tap customer card | Back arrow / backdrop |
| Customer add/edit sheet | Add button / Edit in detail | Back arrow / backdrop / save |
| Order detail sheet | Tap order card | Back arrow / backdrop |
| Rate edit sheet | Edit rate in Products | X button / backdrop |
| Payment dialog | Collect payment | Close X / Cancel / Confirm |
| Confirm dialog | Delete order / customer / restore | Cancel / Confirm |
| Toast | Success / error actions | Auto 4.5 s |
| AI assistant panel | Assistant FAB (above nav) | Close X |

---

## 6. Floating AI assistant

- FAB (54 × 54 px, indigo) fixed **above** the bottom nav (`bottom: 78px + safe-area`).
- Opens `VoiceAssistantPanel` with `variant="mobile"` inside `Suspense`.
- Panel bottom adjusts with `--keyboard-inset` when the on-screen keyboard opens.
- Hidden when `VITE_VOICE_ENABLED=false` (production default).

---

## 7. Back navigation & deep links

- Browser back/forward and direct hash URLs (`/#/customers`, `#/new-order`) work via `readTabFromHash()` + `hashchange` listener.
- No browser `history.pushState` is used for tabs (hash-only) to avoid full-page reloads on refresh.
- "Cancel" in the wizard returns to Home (`#/dashboard`).

---

## 8. What is NOT in mobile navigation

- No hamburger menu, no side drawer, no top tab strip — the bottom bar is the single navigation primitive.
- No separate mobile app or m-dot site; same origin, same build.
- No production/delivery status (order statuses are payment-based: Pending / Partially Paid / Paid).
- No voice recording in production build (assistant panel present but voice disabled via feature flag).

---

## 9. Files

- `frontend/src/App.jsx` — `MOBILE_TABS`, `VALID_TABS`, `readTabFromHash()`, `setTab()`, mobile shell JSX, bottom nav, header.
- `frontend/src/index.css` — `.mobile-bottom-nav`, `.mobile-header`, `.mobile-sheet`, `.mobile-dialog`, `.mobile-toast` inside `@media (max-width: 767px)`.
- `frontend/src/VoiceAssistantPanel.jsx` — `variant="mobile"` branch.
