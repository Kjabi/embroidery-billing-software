// Pure helpers for the voice assistant UI. No browser or network access here so
// they can be tested with Node's built-in test runner.

const MONEY_FIELDS = new Set(["total_amount", "paid_amount", "balance", "payment_amount", "current_balance", "balance_after"]);

export function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "Rs. 0.00";
  return `Rs. ${number.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Keep decimals exact so the server-side amount check can match the phrase.
export function exactAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return String(Math.round(number * 100) / 100);
}

export function confirmationPhrase(pending) {
  const preview = pending?.preview || {};
  const action = pending?.action || "";
  switch (action) {
    case "record_payment":
      return `confirm payment of ${exactAmount(preview.payment_amount)} for ${preview.invoice_number || "this order"}`;
    case "create_order":
      return `confirm order for ${preview.customer || "this customer"} total ${exactAmount(preview.total_amount)}`;
    case "update_delivery_date":
      return `confirm delivery for ${preview.invoice_number || "this order"} on ${preview.new_delivery_date || ""}`.trim();
    case "update_order_status":
      return `confirm status ${preview.new_status || ""} for ${preview.invoice_number || "this order"}`.trim();
    case "update_measurements":
      return `confirm measurements for ${preview.invoice_number || "this order"}`;
    case "create_customer":
      return `confirm customer ${preview.name || ""} ${preview.phone || ""}`.trim();
    case "update_customer":
      return `confirm customer update for ${preview.customer || ""}`.trim();
    case "update_order":
      return `confirm order update for ${preview.invoice_number || "this order"}`;
    default:
      return pending?.confirmation_id ? `confirm ${pending.confirmation_id}` : "confirm this operation";
  }
}

export function pendingTitle(pending) {
  const titles = {
    create_order: "Create this order",
    record_payment: "Record this payment",
    update_delivery_date: "Change this delivery date",
    update_order_status: "Change this order status",
    update_measurements: "Update these measurements",
    create_customer: "Create this customer",
    update_customer: "Update this customer",
    update_order: "Update this order",
  };
  return titles[pending?.action] || "Review this change";
}

function measurementText(value) {
  if (value && typeof value === "object") {
    return Object.entries(value).map(([name, item]) => `${name}: ${item}`).join(", ");
  }
  return String(value || "None");
}

export function previewRows(pending) {
  const preview = pending?.preview || {};
  const rows = [];
  const add = (label, value) => {
    if (value !== undefined && value !== null && value !== "") rows.push({ label, value });
  };
  switch (pending?.action) {
    case "create_order":
      add("Customer", preview.customer);
      add("Product", preview.product);
      add("Measurements", measurementText(preview.measurements));
      add("Total", formatMoney(preview.total_amount));
      add("Paid", formatMoney(preview.paid_amount));
      add("Balance", formatMoney(preview.balance));
      add("Delivery", preview.delivery_date || "Not set");
      add("Notes", preview.description);
      break;
    case "record_payment":
      add("Invoice", preview.invoice_number);
      add("Payment", formatMoney(preview.payment_amount));
      add("Current balance", formatMoney(preview.current_balance));
      add("Balance after", formatMoney(preview.balance_after));
      break;
    case "update_delivery_date":
      add("Invoice", preview.invoice_number);
      add("Old date", preview.old_delivery_date || "Not set");
      add("New date", preview.new_delivery_date);
      break;
    case "update_order_status":
      add("Invoice", preview.invoice_number);
      add("Old status", preview.old_status);
      add("New status", preview.new_status);
      break;
    case "update_measurements":
      add("Invoice", preview.invoice_number);
      add("Measurements", measurementText(preview.changes));
      break;
    case "create_customer":
      add("Name", preview.name);
      add("Phone", preview.phone);
      add("City", preview.city);
      add("Address", preview.address);
      break;
    case "update_customer":
    case "update_order":
      add("Reference", preview.customer || preview.invoice_number);
      add("Changes", measurementText(preview.changes));
      break;
    default:
      Object.entries(preview).forEach(([key, value]) => {
        if (MONEY_FIELDS.has(key)) add(key.replace(/_/g, " "), formatMoney(value));
        else if (key !== "similar_customers") add(key.replace(/_/g, " "), String(value));
      });
  }
  return rows;
}

export function parseApiError(payload, fallback = "The voice assistant request failed.") {
  if (!payload) return fallback;
  const detail = payload.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail.map(item => item?.msg || "Invalid value").join("; ");
  }
  if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
  return fallback;
}

export function canUseMicrophone(navigatorLike = globalThis.navigator, windowLike = globalThis.window) {
  return Boolean(navigatorLike?.mediaDevices?.getUserMedia && windowLike?.MediaRecorder);
}

export function speechLanguage(text) {
  return /[\u0B80-\u0BFF]/.test(String(text || "")) ? "ta-IN" : "en-IN";
}

export function buildDraftPatch(form = {}) {
  const patch = {};
  if (form.measurements && typeof form.measurements === "object") {
    patch.measurements = Object.fromEntries(
      Object.entries(form.measurements)
        .map(([name, value]) => [name, String(value ?? "").trim()])
        .filter(([, value]) => value),
    );
  }
  for (const key of ["total_amount", "paid_amount", "extra_amount"]) {
    if (form[key] !== "" && form[key] !== null && form[key] !== undefined) {
      const number = Number(form[key]);
      if (Number.isFinite(number) && number >= 0) patch[key] = number;
    }
  }
  if (form.delivery_date) patch.delivery_date = String(form.delivery_date).trim();
  if (form.description !== undefined) patch.description = String(form.description).trim();
  return patch;
}

export function draftFromState(task, pending) {
  const draft = task?.draft || {};
  const preview = pending?.preview || {};
  return {
    customer_name: draft.customer_name || preview.customer || "",
    product_name: draft.product_name || preview.product || "",
    measurements: draft.measurements || preview.measurements || {},
    total_amount: draft.total_amount ?? preview.total_amount ?? "",
    paid_amount: draft.paid_amount ?? preview.paid_amount ?? 0,
    extra_amount: draft.extra_amount ?? 0,
    delivery_date: draft.delivery_date || preview.delivery_date || "",
    description: draft.description || preview.description || "",
    required_measurements: draft.required_measurements || [],
  };
}
