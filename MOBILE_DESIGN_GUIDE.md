# Lalitha's Apparel — Mobile Design Guide

**App:** Lalitha's Apparel embroidery & boutique management  
**Date:** 10 Nov 2026  
**Mobile breakpoint:** `max-width: 767px` | tablet 768–1023 px | desktop ≥ 1024 px  
**Source:** `frontend/src/index.css` (mobile block) + `frontend/src/App.jsx` (mobile shell JSX)

---

## 1. Design philosophy

One codebase, two shells. The approved desktop UI is **completely untouched**: desktop renders its existing sidebar/aside + main layout with its own Tailwind classes. Mobile renders a separate JSX branch behind `matchMedia("(max-width: 767px)")` using its own `mobile-*` class names, scoped inside `@media (max-width: 767px)` in `index.css`. No global CSS regresses desktop.

**Mobile palette** (light, premium business workspace):
- Background: `#f1f5f9` (slate-50)
- Cards/surfaces: `#ffffff`
- Text primary: `#0f172a` (slate-900)
- Text secondary: `#64748b` (slate-500)
- Muted: `#94a3b8` (slate-400)
- Brand / primary: `#1768c4` (indigo-600)
- Success: `#047857` (emerald-700)
- Warning: `#b45309` (amber-700)
- Danger: `#b42332` (rose-700)

---

## 2. Grid & spacing

| Token | Value | Use |
|---|---|---|
| Screen padding | `16px` | `.mobile-main` left/right |
| Section gap | `18px` | Between `.mobile-section` blocks |
| Card gap | `10px` | Between cards in `.mobile-card-list` |
| Card padding | `14px` body / `16px` forms | `.mobile-list-card`, `.mobile-form-card` |
| Touch target | `44px` minimum (buttons) | All interactive elements |
| Input height | `48px` minimum | Text inputs, selects, textareas |
| Input font | `16px` minimum | Prevents iOS zoom on focus |
| Border radius | `12–16px` | Cards `16px`, inputs `12px`, pills `999px` |
| Safe-area | `env(safe-area-inset-*)` | Notch / home-indicator aware |

Breakpoints beyond 767 px are handled by the existing desktop CSS (`@media (max-width: 767px)` aside rules remain for tablet fallback; desktop ≥ 1024 px keeps `main { margin-left: 15rem }`).

---

## 3. Typography

- Body: Inter / system sans-serif, 14–16 px
- Screen titles (`h1`): 24–26 px, font-weight 750, letter-spacing -0.02em
- Section headings (`h2`): 18 px, font-weight 700
- Card titles: 15–16 px, font-weight 650
- Labels: 13 px, font-weight 650, color `#334155`
- Helper text: 12 px, color `#64748b`, line-height 1.5
- Metric values: 22 px (20 px at ≤359 px), font-weight 750

All labels are visible (no placeholder-only inputs). Every input has an associated `<label>` or `aria-label`.

---

## 4. Components

### 4.1 App shell
- `.mobile-app` — `min-height: 100dvh`, `overflow-x: hidden`, padding-bottom = nav height + safe-area inset.
- `.mobile-header` — sticky top, 64 px, brand + bell (with notification dot) + avatar (More).
- `.mobile-main` — centered column, max-width 640 px.

### 4.2 Bottom navigation (fixed)
Five tabs: Home, Orders, Customers, Payments, More. Active tab gets `#eff6ff` background + indigo text. 54 px touch targets, safe-area bottom.

### 4.3 Buttons
| Variant | Background | Border | Text | Use |
|---|---|---|---|---|
| Primary | `#1768c4` | `#1768c4` | `#fff` | Main actions (Save, Collect, Continue) |
| Secondary | `#fff` | `#c7d7ea` | `#1768c4` | Secondary actions |
| Ghost | transparent | `#cbd5e1` | `#475569` | Tertiary / inline |
| Danger | `#b42332` | `#b42332` | `#fff` | Destructive actions |
| Danger outline | `#fff` | `#f2b8be` | `#b42332` | Destructive, low emphasis |

All buttons: `min-height: 44px`, border-radius `14px`, disabled state at 55% opacity.

### 4.4 Metric cards (`.mobile-metric`)
2-column grid. Icon + label (12 px) + value (22 px) + optional hint (11 px). Border `1px solid #e2e8f0`, radius 16 px, white surface.

### 4.5 Order card (`.mobile-order-card`)
Invoice chip, customer name (16 px bold), product, status pill (Paid/Partly paid/Payment pending), total/paid/balance row, delivery date + overdue flag, Collect button when balance > 0.

### 4.6 Customer card (`.mobile-customer-card`)
Avatar initials (42 px circle), name, phone + city, order count + total spent, chevron; separate Call button (`tel:` link).

### 4.7 Forms
Single-column. `.mobile-field`: label (13 px) + input (48 px min-height, 16 px font). Date inputs use `type="date"`. Numeric fields use `inputMode="decimal"`/`numeric`; phone uses `inputMode="numeric"` with `pattern="[0-9]{10}"` and `maxLength=10`. Textareas: min-height 96 px, resizable.

### 4.8 Wizard (6-step order)
Progress dots + step labels (Customer → Product → Measurements/Stitch details → Design → Price → Review). Per-step validation banner. Back / Continue / Save order. Cancel exits to dashboard.

### 4.9 Sheets (slide-up, bottom-anchored)
`.mobile-sheet-backdrop` + `.mobile-sheet` (radius 20 px top, `max-height: 92dvh`, safe-area bottom). Used for customer detail, customer form, order detail, rate edit. Close via X / back arrow / backdrop.

### 4.10 Dialogs (centered)
`PaymentDialog` (amount, Cash/UPI chip, balance-after preview, confirm) and `ConfirmDialog` (title, message, cancel/confirm). Backdrop, 480 px max-width, scrollable.

### 4.11 Toast
Bottom-center, `#0f172a` / error `#991b1b`, 4.5 s auto-dismiss, keyboard-aware via `--keyboard-inset`.

### 4.12 Empty & loading states
`MobileEmptyState` (icon, title, text, optional action) and `MobileLoading` (spinner + label).

---

## 5. Interaction rules

- **Touch targets:** ≥ 44 × 44 px on every button, verified at 320/360/375/390/412/430/600 px.
- **Input font:** exactly 16 px on all form fields to prevent iOS double-tap zoom.
- **Keyboards:** `inputMode="numeric"` for phones/amounts, `decimal` for money/measurements, `search` for searches, `tel` with `pattern` for 10-digit phones.
- **Search:** debounced by React re-render; status chip row filters client-side.
- **Hash routing:** tab state mirrored to URL hash (`#/dashboard`, `#/invoices`, …) for refresh/deep-link support.
- **Keyboard awareness:** `visualViewport` sets `--keyboard-inset`; floating assistant, toast, and dialog bottoms shift up when the on-screen keyboard opens.
- **Safe areas:** `env(safe-area-inset-top/bottom)` on header, nav, toast, sheets, dialogs.
- **Reduced motion:** `@media (prefers-reduced-motion: reduce)` disables sheet entrance and spinner animations.

---

## 6. Desktop preservation

No CSS rule inside `@media (max-width: 767px)` targets `.aside`, `main`, `main button`, `.bg-slate-900`, `.text-white`, or any desktop class. Desktop uses `min-h-screen bg-slate-950` + aside sidebar; mobile uses `.mobile-app` + `.mobile-main`. At 768–1023 px (tablet) the existing desktop aside rules still apply; mobile shell does not render.

Verified at 1024 / 1280 / 1440 px: aside width 240 px, `main margin-left: 240px`, zero horizontal overflow, zero unnamed controls, zero small buttons (see `DESKTOP_REGRESSION_REPORT.md`).

---

## 7. Files

- `frontend/src/index.css` — mobile design system (lines ~336–2120), scoped `@media (max-width: 767px)` + shared dialog primitives outside the query.
- `frontend/src/App.jsx` — mobile shell JSX branch (`if (isMobile)`) and shared dialog/toast components.
- `frontend/public/manifest.webmanifest` + `icon-192.png` / `icon-512.png` / `apple-touch-icon.png` — PWA installability (no service worker).
- `frontend/index.html` — viewport `width=device-width, initial-scale=1.0, viewport-fit=cover`, theme-color `#1768c4`, apple-mobile-web-app tags.
