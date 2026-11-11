// Pure helpers shared by the mobile shell and the desktop tree.
// Everything in this file is side-effect free so it can be unit tested
// with the built-in Node test runner (no browser required).

export const MOBILE_MAX_WIDTH = 767;

export const DESKTOP_TABS = ["dashboard", "new-order", "invoices", "customers", "products", "finance"];
export const MOBILE_TABS = [...DESKTOP_TABS, "payments", "more"];
export const VALID_TABS = [...new Set([...DESKTOP_TABS, ...MOBILE_TABS])];

export const ORDER_STATUSES = ["Pending", "Partially Paid", "Paid"];

export const readTabFromHash = (hash) => {
  const raw = String(hash || "").replace(/^#\/?/, "").trim();
  return VALID_TABS.includes(raw) ? raw : "dashboard";
};

export const money = (value) => `₹${Number(value || 0).toLocaleString("en-IN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
})}`;

// Business "today" in the device's local timezone (not UTC).
export const businessToday = (now = new Date()) => {
  const local = new Date(now.getTime());
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  return local.toISOString().slice(0, 10);
};

export const shortDate = (iso) => {
  if (!iso) return "No date";
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
};

export const orderOverdue = (order, today = businessToday()) => Boolean(
  order?.delivery_date && order.delivery_date < today && Number(order.balance) > 0
);

export const orderDueSoon = (order, today = businessToday()) => {
  if (!order?.delivery_date || Number(order.balance) <= 0) return false;
  const todayDate = new Date(`${today}T00:00:00`);
  const due = new Date(`${order.delivery_date}T00:00:00`);
  if (Number.isNaN(todayDate.getTime()) || Number.isNaN(due.getTime())) return false;
  const days = Math.round((due - todayDate) / 86400000);
  return days >= 0 && days <= 7;
};

export const statusTone = (status) => {
  if (status === "Paid") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "Partially Paid") return "bg-blue-50 text-blue-700 border-blue-200";
  return "bg-amber-50 text-amber-800 border-amber-200";
};

export const statusLabel = (status) => {
  if (status === "Partially Paid") return "Partly paid";
  if (status === "Pending") return "Payment pending";
  return status || "Payment pending";
};

export const orderMatchesSearch = (order, term) => {
  const needle = String(term || "").trim().toLowerCase();
  if (!needle) return true;
  return [
    order.invoice_number,
    order.customer_name,
    order.customer_phone,
    order.product_name,
  ]
    .filter(Boolean)
    .some(value => String(value).toLowerCase().includes(needle));
};

// Orders tab filter: status chip (ALL / Pending / Partially Paid / Paid / OVERDUE) + free text.
export const filterMobileOrders = (orders, filter = {}, today = businessToday()) => {
  const status = filter.status || "ALL";
  return (orders || []).filter(order => {
    if (status === "OVERDUE") {
      if (!orderOverdue(order, today)) return false;
    } else if (status !== "ALL" && (order.status || "Pending") !== status) {
      return false;
    }
    return orderMatchesSearch(order, filter.search);
  });
};

// Customers tab filter: name, phone, alternate phone, customer code, city, address.
export const filterMobileCustomers = (customers, query = "") => {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return customers || [];
  return (customers || []).filter(customer => [
    customer.name,
    customer.phone,
    customer.alternate_phone,
    customer.cust_code,
    customer.city,
    customer.address,
  ].filter(Boolean).some(value => String(value).toLowerCase().includes(needle)));
};

export const ordersWithBalance = (orders) => (orders || []).filter(order => Number(order.balance) > 0);

export const customerOrders = (orders, customer) => {
  if (!customer) return [];
  return (orders || []).filter(order => (
    (customer.phone && order.customer_phone === customer.phone)
    || order.customer_name === customer.name
  ));
};

// Last N days that actually carry activity, used by the mobile bar chart.
export const financeBarDays = (dailyChart = [], limit = 7) => (dailyChart || []).slice(-limit);

export const financeBarMax = (days = []) => {
  const values = days.flatMap(day => [Number(day.Income) || 0, Number(day.Expense) || 0]);
  return Math.max(1, ...values);
};

export const financeBarWidth = (value, max) => {
  const safeMax = Number(max) > 0 ? Number(max) : 1;
  const percent = ((Number(value) || 0) / safeMax) * 100;
  // Always keep a visible sliver and never overflow the track.
  return `${Math.min(100, Math.max(2, percent))}%`;
};

export const greetingForHour = (hour) => {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
};

export const mobileGreeting = (now = new Date()) => greetingForHour(now.getHours());

export const SCREEN_TITLES = {
  dashboard: "Home",
  invoices: "Orders",
  customers: "Customers",
  payments: "Payments",
  "new-order": "New order",
  products: "Products & rates",
  finance: "Finance & reports",
  more: "More",
};

export const mobileScreenTitle = (tab) => SCREEN_TITLES[tab] || "Lalitha's Apparel";

export const BOTTOM_NAV_ITEMS = [
  { target: "dashboard", label: "Home" },
  { target: "invoices", label: "Orders" },
  { target: "customers", label: "Customers" },
  { target: "payments", label: "Payments" },
  { target: "more", label: "More" },
];

// ---------------------------------------------------------------------------
// New-order wizard validation (step 1..6). Returns a human readable problem
// string, or "" when the step is complete.
// ---------------------------------------------------------------------------
export const validateOrderStep = (step, context = {}) => {
  const {
    orderForm = {},
    selectedProduct = null,
    selectedTemplate = null,
    total = 0,
  } = context;

  if (step === 1 && !orderForm.customer_id) return "Choose a customer to continue.";
  if (step === 2 && !orderForm.product_id) return "Choose a product to continue.";

  if (step === 3) {
    if (selectedProduct?.pricing_type === "STITCH_BASED") {
      if (!Number(orderForm.stitch_count) || Number(orderForm.stitch_count) <= 0) {
        return "Enter the number of stitches.";
      }
      return "";
    }
    if (selectedTemplate) {
      const missing = (selectedTemplate.fields || []).filter(
        field => !String((orderForm.measurements || {})[field] || "").trim()
      );
      if (missing.length) return `Enter all measurements: ${missing.join(", ")}.`;
    }
  }

  if (step === 5) {
    if (Number(orderForm.paid_amount || 0) > Number(total || 0) + 0.001) {
      return "Advance paid cannot be more than the order total.";
    }
  }

  return "";
};

// Payment collection validation. Returns "" when valid, else the problem.
export const validatePaymentAmount = (amount, balance) => {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return "Enter an amount greater than ₹0.";
  if (value > Number(balance || 0) + 0.001) {
    return `The outstanding balance is ${money(balance)}. Enter that amount or less.`;
  }
  return "";
};

export const remainingBalance = (balance, amount) => Math.max(0, Number(balance || 0) - Number(amount || 0));

// Reference image rules (mirrors the backend 4 MB / JPEG / PNG rule).
export const MAX_REFERENCE_IMAGE_BYTES = 4 * 1024 * 1024;
export const REFERENCE_IMAGE_TYPES = ["image/jpeg", "image/png"];

export const validateReferenceImage = (file) => {
  if (!file) return "";
  if (!REFERENCE_IMAGE_TYPES.includes(file.type)) return "Only JPEG and PNG images are supported.";
  if (file.size > MAX_REFERENCE_IMAGE_BYTES) return "Reference image must be 4 MB or smaller.";
  return "";
};

export const isTamilText = (value) => /[\u0B80-\u0BFF]/.test(String(value || ""));
