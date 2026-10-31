import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDraftPatch,
  canUseMicrophone,
  confirmationPhrase,
  draftFromState,
  exactAmount,
  formatMoney,
  parseApiError,
  pendingTitle,
  previewRows,
  speechLanguage,
} from "./voiceLogic.js";

test("formatMoney uses Indian formatting and two decimals", () => {
  assert.equal(formatMoney(1234567.5), "Rs. 12,34,567.50");
  assert.equal(formatMoney("bad"), "Rs. 0.00");
});

test("exactAmount keeps paise and strips trailing zeros", () => {
  assert.equal(exactAmount(500), "500");
  assert.equal(exactAmount("500.50"), "500.5");
  assert.equal(exactAmount(500.506), "500.51");
  assert.equal(exactAmount(undefined), "0");
});

test("confirmation phrases match the server-side phrase format", () => {
  assert.equal(
    confirmationPhrase({
      action: "record_payment",
      confirmation_id: "abc",
      preview: { payment_amount: 500, invoice_number: "INV-2026-001" },
    }),
    "confirm payment of 500 for INV-2026-001",
  );
  assert.equal(
    confirmationPhrase({
      action: "create_order",
      confirmation_id: "abc",
      preview: { customer: "Priya", total_amount: 1250.5 },
    }),
    "confirm order for Priya total 1250.5",
  );
  assert.equal(
    confirmationPhrase({
      action: "update_delivery_date",
      confirmation_id: "abc",
      preview: { invoice_number: "INV-2026-001", new_delivery_date: "2026-11-05" },
    }),
    "confirm delivery for INV-2026-001 on 2026-11-05",
  );
  assert.equal(
    confirmationPhrase({ action: "unknown", confirmation_id: "abc" }),
    "confirm abc",
  );
});

test("pendingTitle falls back safely", () => {
  assert.equal(pendingTitle({ action: "create_order" }), "Create this order");
  assert.equal(pendingTitle({ action: "other" }), "Review this change");
});

test("previewRows hides empty values and formats money", () => {
  const rows = previewRows({
    action: "record_payment",
    preview: {
      invoice_number: "INV-2026-002",
      payment_amount: 250,
      current_balance: 1000,
      balance_after: 750,
    },
  });
  assert.deepEqual(rows, [
    { label: "Invoice", value: "INV-2026-002" },
    { label: "Payment", value: "Rs. 250.00" },
    { label: "Current balance", value: "Rs. 1,000.00" },
    { label: "Balance after", value: "Rs. 750.00" },
  ]);

  const orderRows = previewRows({
    action: "create_order",
    preview: {
      customer: "Priya",
      product: "Blouse",
      measurements: { bust: "36 in", waist: "30 in" },
      total_amount: 1000,
      paid_amount: 200,
      balance: 800,
      delivery_date: null,
    },
  });
  assert.equal(orderRows.find(row => row.label === "Delivery").value, "Not set");
  assert.equal(
    orderRows.find(row => row.label === "Measurements").value,
    "bust: 36 in, waist: 30 in",
  );
  assert.equal(orderRows.find(row => row.label === "Notes"), undefined);
});

test("parseApiError handles FastAPI detail shapes", () => {
  assert.equal(parseApiError({ detail: "Not found" }), "Not found");
  assert.equal(
    parseApiError({ detail: [{ msg: "field required" }, { msg: "too long" }] }),
    "field required; too long",
  );
  assert.equal(parseApiError({ error: "Rejected" }), "Rejected");
  assert.equal(parseApiError({}, "fallback"), "fallback");
  assert.equal(parseApiError(null, "fallback"), "fallback");
});

test("canUseMicrophone detects browser support", () => {
  const navigatorLike = { mediaDevices: { getUserMedia() {} } };
  assert.equal(canUseMicrophone(navigatorLike, { MediaRecorder() {} }), true);
  assert.equal(canUseMicrophone(navigatorLike, {}), false);
  assert.equal(canUseMicrophone({}, { MediaRecorder() {} }), false);
  assert.equal(canUseMicrophone(undefined, undefined), false);
});

test("speechLanguage chooses Tamil for Tamil script", () => {
  assert.equal(speechLanguage("இன்று விற்பனை என்ன?"), "ta-IN");
  assert.equal(speechLanguage("How much was collected today?"), "en-IN");
  assert.equal(speechLanguage(""), "en-IN");
});

test("buildDraftPatch trims, filters empty measurements, and validates amounts", () => {
  const patch = buildDraftPatch({
    measurements: { bust: " 36 in ", waist: "   ", sleeve: 10 },
    total_amount: "1200.5",
    paid_amount: "",
    extra_amount: -5,
    delivery_date: " 2026-11-05 ",
    description: "  Customer will collect  ",
  });
  assert.deepEqual(patch, {
    measurements: { bust: "36 in", sleeve: "10" },
    total_amount: 1200.5,
    delivery_date: "2026-11-05",
    description: "Customer will collect",
  });
});

test("draftFromState prefers the live draft and falls back to the preview", () => {
  const draft = draftFromState(
    { draft: { customer_name: "Live", total_amount: 900, measurements: { bust: "36 in" } } },
    { preview: { customer: "Preview", total_amount: 1200, delivery_date: "2026-11-05" } },
  );
  assert.equal(draft.customer_name, "Live");
  assert.equal(draft.total_amount, 900);
  assert.equal(draft.delivery_date, "2026-11-05");
  assert.deepEqual(draft.measurements, { bust: "36 in" });

  assert.equal(draftFromState(null, null).customer_name, "");
  assert.equal(draftFromState(null, null).paid_amount, 0);
});
