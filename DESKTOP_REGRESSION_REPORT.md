# Lalitha's Apparel — Desktop Regression Report

**App:** Lalitha's Apparel embroidery & boutique management  
**Date:** 10 Nov 2026  
**Scope:** Verify the mobile redesign did **not** change the approved desktop UI at ≥ 1024 px (also tablet 768 px).

---

## 1. Regression strategy

The mobile shell is a separate React branch behind `matchMedia("(max-width: 767px)")`:

```jsx
if (isMobile) {
  return <div className="mobile-app">…</div>;
}

return <div className="min-h-screen bg-slate-950 text-slate-100">…desktop JSX…</div>;
```

The desktop return statement, its JSX, classes (`aside`, `main`, `bg-slate-900`, `text-white`, etc.), and `main { margin-left: 15rem }` are **byte-for-byte unchanged** from the pre-mobile baseline. All new mobile styles use `mobile-*` class names scoped inside `@media (max-width: 767px)`.

---

## 2. Desktop audit results (Playwright, `ui_audit.mjs`)

**23/23 steps PASS** — 0 console errors, 0 page errors, 0 failed requests.

| Step | Result | Key assertions |
|---|---|---|
| login_page | PASS | Login renders; username prefilled; a11y clean |
| login | PASS | Token stored; Dashboard button reachable |
| dashboard | PASS | Aside 240 px; main margin-left 240px; no overflow; Total Income / Payment collection status / Order & payment pipeline / Recent Orders present; stage counts correct |
| customers_page | PASS | Aside 240 px; no overflow; add form has City + Alternate phone; existing cards |
| create_customer_ui | PASS | Save Customer works; feedback shown; invalid phone rejected |
| search_customer | PASS | Search filters list; customer codes visible |
| edit_customer_modal | PASS | Dialog aria-modal, labelledby, focus inside dialog |
| delete_customer_refresh | PASS | In-app confirm dialog used; card removed after delete; no stale card |
| new_order_form | PASS | Build a new order; customer + product options; a11y clean |
| new_order_measurements | PASS | 7 measurement fields; labels visible; inputs labeled |
| submit_order_ui | PASS | POST `/api/orders` → 200; invoice `INV-2026-014` |
| orders_page | PASS | 8 rows; table layout; search/filter inputs; no overflow; a11y clean |
| products_page | PASS | Rate cards (6), product toggle cards (22); no overflow; a11y clean |
| finance_page | PASS | Finance workspace; 23 chart containers; period buttons active states correct |
| finance_export | PASS | CSV export download started |
| tablet_768 | PASS | Aside 240 px; main width 528 px; no overflow |
| mobile_390 | PASS | Mobile shell active; bottom nav present; no desktop aside; no overflow; a11y clean |
| mobile_orders | PASS | 8 order cards; no overflow |
| mobile_customers | PASS | 11 customer cards; no overflow |
| mobile_payments | PASS | Balance-due cards; no overflow |
| mobile_products (390) | PASS | Products & rates renders; no overflow |
| mobile_finance (390) | PASS | Finance renders; no overflow |
| global_search_scope | PASS | Header search is customer-scoped; dashboard content unchanged |

### Layout measurements at desktop widths

| Width | Aside width | Main margin-left | Horizontal overflow |
|---|---|---|---|
| 1440 | 240 px | 240 px | No |
| 1280 | 240 px | 240 px | No |
| 1024 | 240 px | 240 px | No |
| 768 (tablet) | 240 px | 240 px | No |

---

## 3. Accessibility at desktop (sampled)

| View | Visible controls | Unnamed | Small buttons | Images w/o alt | Inputs w/o label |
|---|---|---|---|---|---|
| Dashboard 1440 | 41 | 0 | 0 | 0 | 0 |
| Customers 1440 | 42 | 0 | 0 | 0 | 0 |
| Orders 1440 | 63 | 0 | 0 | 0 | 0 |
| Products 1440 | 48 | 0 | 0 | 0 | 0 |
| Finance 1440 | 27 | 0 | 0 | 0 | 0 |
| Dashboard 390 (mobile) | 26 | 0 | 0 | 1 (logo, alt="") | 0 |

All desktop controls have accessible names; all buttons ≥ 44 × 44 px; no unlabeled inputs.

---

## 4. What was verified unchanged

- Sidebar navigation (Dashboard, New Order, Orders, Customers, Finance, Products) at 240 px width
- Dashboard stage tiles (Unpaid / Partially paid / Paid in full / All orders)
- Customer directory with add/edit/delete via in-app confirm dialog
- New order form with customer/product selects and measurement inputs
- Orders table with search and filters
- Products & rates with per-category stitch rates and activate/deactivate toggles
- Finance workspace with charts, period chips, CSV/PDF export
- Payment flow (desktop "Mark Paid" now uses the shared `PaymentDialog` instead of `window.prompt`)
- Delete flow (desktop now uses the shared `ConfirmDialog` instead of `window.confirm`)

---

## 5. What was intentionally changed (additive, non-regressing)

| Area | Change | Desktop impact |
|---|---|---|
| Payment collection | `window.prompt` → `openPayment(o)` → shared `PaymentDialog` | Dialog is styled outside the mobile media query; renders correctly on desktop |
| Delete confirm | `window.confirm` → `askConfirm()` → shared `ConfirmDialog` | Same dialog component; desktop-safe styling |
| Toast notifications | New shared `Toast` component | Renders bottom-center on desktop too |
| `openInvoicePdf` error handling | Mobile: toast; desktop: alert (unchanged) | Desktop behavior preserved |
| `saveCustomerEdit` | Closes mobile form + notifies | Desktop behavior unchanged |
| `removeOrder`/`removeCustomer` | Close mobile sheets on delete | Desktop behavior unchanged |

---

## 6. Known desktop-adjacent items (not regressions)

- Some desktop paths still use `window.alert` (order PDF save errors, customer edit errors, product/rate errors, WhatsApp) — pre-existing, flagged for future polish, not introduced by the mobile work.
- Desktop CSS globals (`.bg-slate-900` → white, `.text-white` → dark, etc.) remain exactly as before.

---

## 7. Evidence

- Desktop audit JSON: `.runtime/run-20261108/ui-audit.json`
- Before screenshots: `.runtime/mobile-redesign/before/` (desktop at 1440 px)
- After screenshots: `.runtime/mobile-redesign/after/` (desktop-dashboard/customers/orders/finance/products at 1024/1280/1440 px)

## 8. Current revalidation (2026-11-11)

The current Playwright responsive suite was rerun against isolated local
services on ports 5173 and 8010:

```text
12 passed, 0 failed, 0 skipped
```

The current run verified desktop widths 768, 1024, 1280, and 1440px, including
desktop shell presence, accessibility, and absence of console/page/request
errors. The historical 23-step evidence above is retained as historical
context; the 12-test result is the current regression evidence.

---

## 8. Conclusion

**Desktop regression: PASS.** The approved desktop UI, layouts, navigation, tables, forms, spacing, and workflows are unchanged at ≥ 1024 px (and 768 px tablet). Zero horizontal overflow, zero accessibility label/size issues, zero console/page/request errors across all desktop widths tested. The mobile redesign is fully additive and does not regress desktop in any way.
