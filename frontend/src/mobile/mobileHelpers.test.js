import assert from "node:assert/strict";
import test from "node:test";
import {
  BOTTOM_NAV_ITEMS,
  DESKTOP_TABS,
  MAX_REFERENCE_IMAGE_BYTES,
  MOBILE_MAX_WIDTH,
  MOBILE_TABS,
  ORDER_STATUSES,
  SCREEN_TITLES,
  VALID_TABS,
  businessToday,
  customerOrders,
  filterMobileCustomers,
  filterMobileOrders,
  financeBarDays,
  financeBarMax,
  financeBarWidth,
  greetingForHour,
  isTamilText,
  mobileGreeting,
  money,
  mobileScreenTitle,
  orderDueSoon,
  orderMatchesSearch,
  orderOverdue,
  ordersWithBalance,
  readTabFromHash,
  remainingBalance,
  shortDate,
  statusLabel,
  statusTone,
  validateOrderStep,
  validatePaymentAmount,
  validateReferenceImage,
} from "./mobileHelpers.js";

const order = (overrides = {}) => ({
  id: 1,
  invoice_number: "INV-2026-001",
  customer_name: "Meena",
  customer_phone: "9876500001",
  product_name: "Normal Blouse",
  total_amount: 1000,
  paid_amount: 400,
  balance: 600,
  status: "Partially Paid",
  delivery_date: "",
  ...overrides,
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
test("readTabFromHash accepts every valid mobile and desktop tab", () => {
  for (const tab of VALID_TABS) {
    assert.equal(readTabFromHash(`#/${tab}`), tab);
    assert.equal(readTabFromHash(`#${tab}`), tab);
  }
});

test("readTabFromHash falls back to the dashboard for unknown or empty hashes", () => {
  assert.equal(readTabFromHash("#/not-a-tab"), "dashboard");
  assert.equal(readTabFromHash("#/"), "dashboard");
  assert.equal(readTabFromHash(""), "dashboard");
  assert.equal(readTabFromHash(undefined), "dashboard");
  assert.equal(readTabFromHash("#/DASHBOARD"), "dashboard", "tab matching is case sensitive");
});

test("mobile tabs extend desktop tabs with payments and more", () => {
  assert.equal(MOBILE_MAX_WIDTH, 767);
  assert.ok(MOBILE_TABS.includes("payments"));
  assert.ok(MOBILE_TABS.includes("more"));
  for (const tab of DESKTOP_TABS) assert.ok(MOBILE_TABS.includes(tab));
  assert.deepEqual(
    BOTTOM_NAV_ITEMS.map(item => item.target),
    ["dashboard", "invoices", "customers", "payments", "more"]
  );
});

test("every bottom navigation target has a screen title", () => {
  for (const { target } of BOTTOM_NAV_ITEMS) {
    assert.ok(SCREEN_TITLES[target], `missing title for ${target}`);
    assert.equal(mobileScreenTitle(target), SCREEN_TITLES[target]);
  }
  assert.equal(mobileScreenTitle("unknown-tab"), "Lalitha's Apparel");
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
test("money formats Indian grouping and keeps paise when present", () => {
  assert.equal(money(0), "₹0");
  assert.equal(money(1500), "₹1,500");
  assert.equal(money(123456.78), "₹1,23,456.78", "en-IN uses lakh grouping");
  assert.equal(money(1234.5), "₹1,234.5");
  assert.equal(money(null), "₹0");
  assert.equal(money(undefined), "₹0");
  assert.equal(money("2500"), "₹2,500");
});

test("businessToday uses the local calendar day, not UTC", () => {
  const local = new Date(2026, 10, 11, 23, 30); // 11 Nov 2026, 23:30 local
  assert.equal(businessToday(local), "2026-11-11");
  const midnight = new Date(2026, 0, 1, 0, 5);
  assert.equal(businessToday(midnight), "2026-01-01");
});

test("shortDate renders a readable date and handles missing values", () => {
  assert.equal(shortDate("2026-11-10"), "10 Nov");
  assert.equal(shortDate(""), "No date");
  assert.equal(shortDate(null), "No date");
  assert.equal(shortDate("not-a-date"), "not-a-date");
});

// ---------------------------------------------------------------------------
// Order status rules
// ---------------------------------------------------------------------------
test("orderOverdue needs a past delivery date and an unpaid balance", () => {
  assert.equal(orderOverdue(order({ delivery_date: "2020-01-01" }), "2026-11-11"), true);
  assert.equal(orderOverdue(order({ delivery_date: "2020-01-01", balance: 0 }), "2026-11-11"), false);
  assert.equal(orderOverdue(order({ delivery_date: "2030-01-01" }), "2026-11-11"), false);
  assert.equal(orderOverdue(order({ delivery_date: "2026-11-11" }), "2026-11-11"), false, "due today is not overdue");
  assert.equal(orderOverdue(order({ delivery_date: "" }), "2026-11-11"), false);
});

test("orderDueSoon covers the next seven days only and needs a balance", () => {
  assert.equal(orderDueSoon(order({ delivery_date: "2026-11-12" }), "2026-11-11"), true);
  assert.equal(orderDueSoon(order({ delivery_date: "2026-11-18" }), "2026-11-11"), true, "day 7 inclusive");
  assert.equal(orderDueSoon(order({ delivery_date: "2026-11-19" }), "2026-11-11"), false);
  assert.equal(orderDueSoon(order({ delivery_date: "2026-11-10" }), "2026-11-11"), false, "past date is overdue, not due soon");
  assert.equal(orderDueSoon(order({ delivery_date: "2026-11-12", balance: 0 }), "2026-11-11"), false);
});

test("status tone and label map the three payment statuses", () => {
  assert.match(statusTone("Paid"), /emerald/);
  assert.match(statusTone("Partially Paid"), /blue/);
  assert.match(statusTone("Pending"), /amber/);
  assert.match(statusTone(undefined), /amber/, "unknown status falls back to pending");
  assert.equal(statusLabel("Paid"), "Paid");
  assert.equal(statusLabel("Partially Paid"), "Partly paid");
  assert.equal(statusLabel("Pending"), "Payment pending");
  assert.equal(statusLabel(undefined), "Payment pending");
  assert.deepEqual(ORDER_STATUSES, ["Pending", "Partially Paid", "Paid"]);
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------
test("filterMobileOrders filters by status chip", () => {
  const orders = [
    order({ id: 1, status: "Pending" }),
    order({ id: 2, status: "Partially Paid" }),
    order({ id: 3, status: "Paid", balance: 0, paid_amount: 1000 }),
  ];
  assert.equal(filterMobileOrders(orders, { status: "ALL" }).length, 3);
  assert.equal(filterMobileOrders(orders, { status: "Pending" }).length, 1);
  assert.equal(filterMobileOrders(orders, { status: "Partially Paid" }).length, 1);
  assert.equal(filterMobileOrders(orders, { status: "Paid" }).length, 1);
});

test("filterMobileOrders OVERDUE chip only returns past-due unpaid orders", () => {
  const orders = [
    order({ id: 1, delivery_date: "2020-01-01" }),
    order({ id: 2, delivery_date: "2030-01-01" }),
    order({ id: 3, delivery_date: "2020-01-01", balance: 0 }),
  ];
  const overdue = filterMobileOrders(orders, { status: "OVERDUE" }, "2026-11-11");
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].id, 1);
});

test("filterMobileOrders searches invoice, customer, phone and product", () => {
  const orders = [order({ invoice_number: "INV-2026-009", customer_name: "Kavitha" })];
  assert.equal(filterMobileOrders(orders, { search: "inv-2026-009" }).length, 1);
  assert.equal(filterMobileOrders(orders, { search: "kavitha" }).length, 1);
  assert.equal(filterMobileOrders(orders, { search: "98765" }).length, 1);
  assert.equal(filterMobileOrders(orders, { search: "blouse" }).length, 1);
  assert.equal(filterMobileOrders(orders, { search: "nothing" }).length, 0);
});

test("orderMatchesSearch ignores case and blank terms", () => {
  assert.equal(orderMatchesSearch(order(), ""), true);
  assert.equal(orderMatchesSearch(order(), "   "), true);
  assert.equal(orderMatchesSearch(order(), "MEENA"), true);
});

test("filterMobileCustomers searches name, phone, code, city and address", () => {
  const customers = [
    { name: "Kavitha", phone: "9876500002", cust_code: "CUST-002", city: "Madurai", address: "12 Temple Street" },
    { name: "Ravi", phone: "9876500003", cust_code: "CUST-003", city: "Chennai", address: "4 Gandhi Road" },
  ];
  assert.equal(filterMobileCustomers(customers, "kavi").length, 1);
  assert.equal(filterMobileCustomers(customers, "9876500003").length, 1);
  assert.equal(filterMobileCustomers(customers, "CUST-002").length, 1);
  assert.equal(filterMobileCustomers(customers, "chennai").length, 1);
  assert.equal(filterMobileCustomers(customers, "gandhi").length, 1);
  assert.equal(filterMobileCustomers(customers, "").length, 2);
  assert.equal(filterMobileCustomers(customers, "zzz").length, 0);
});

test("ordersWithBalance and customerOrders select the right subsets", () => {
  const orders = [
    order({ id: 1, balance: 600, customer_phone: "9876500001", customer_name: "Meena" }),
    order({ id: 2, balance: 0, customer_phone: "9876500009", customer_name: "Ravi" }),
  ];
  assert.deepEqual(ordersWithBalance(orders).map(o => o.id), [1]);
  assert.deepEqual(customerOrders(orders, { phone: "9876500001", name: "Meena" }).map(o => o.id), [1]);
  assert.deepEqual(customerOrders(orders, { phone: "9876500009", name: "Ravi" }).map(o => o.id), [2]);
  assert.deepEqual(customerOrders(orders, null), []);
});

// ---------------------------------------------------------------------------
// Finance chart helpers
// ---------------------------------------------------------------------------
test("financeBarDays keeps the most recent active days", () => {
  const chart = Array.from({ length: 10 }, (_, index) => ({
    date: `2026-11-${String(index + 1).padStart(2, "0")}`,
    Income: index,
    Expense: 0,
  }));
  const days = financeBarDays(chart);
  assert.equal(days.length, 7);
  assert.equal(days[0].date, "2026-11-04");
  assert.equal(days[6].date, "2026-11-10");
  assert.deepEqual(financeBarDays([], 7), []);
});

test("financeBarMax never divides by zero and keeps the peak value", () => {
  assert.equal(financeBarMax([]), 1);
  assert.equal(financeBarMax([{ Income: 0, Expense: 0 }]), 1);
  assert.equal(financeBarMax([{ Income: 500, Expense: 200 }]), 500);
});

test("financeBarWidth always renders a visible bar", () => {
  assert.equal(financeBarWidth(50, 100), "50%");
  assert.equal(financeBarWidth(0, 100), "2%");
  assert.equal(financeBarWidth(10, 0), "100%", "a zero max is clamped to the track width");
  assert.equal(financeBarWidth(-5, 100), "2%", "negative values never render below the visible sliver");
  assert.equal(financeBarWidth(150, 100), "100%", "values above the max are clamped");
});

// ---------------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------------
test("greeting follows the business day", () => {
  assert.equal(greetingForHour(6), "Good morning");
  assert.equal(greetingForHour(11), "Good morning");
  assert.equal(greetingForHour(12), "Good afternoon");
  assert.equal(greetingForHour(16), "Good afternoon");
  assert.equal(greetingForHour(17), "Good evening");
  assert.equal(greetingForHour(23), "Good evening");
  assert.equal(mobileGreeting(new Date(2026, 10, 11, 9)), "Good morning");
});

// ---------------------------------------------------------------------------
// New order wizard validation
// ---------------------------------------------------------------------------
const baseContext = {
  orderForm: { customer_id: 5, product_id: 9, stitch_count: 1000, paid_amount: 0, measurements: {} },
  selectedProduct: { id: 9, pricing_type: "MANUAL", base_price: 500 },
  selectedTemplate: null,
  total: 500,
};

test("wizard step 1 requires a customer", () => {
  assert.equal(validateOrderStep(1, { ...baseContext, orderForm: { ...baseContext.orderForm, customer_id: "" } }),
    "Choose a customer to continue.");
  assert.equal(validateOrderStep(1, baseContext), "");
});

test("wizard step 2 requires a product", () => {
  assert.equal(validateOrderStep(2, { ...baseContext, orderForm: { ...baseContext.orderForm, product_id: "" } }),
    "Choose a product to continue.");
  assert.equal(validateOrderStep(2, baseContext), "");
});

test("wizard step 3 requires stitches for stitch based products", () => {
  const stitchBased = { ...baseContext, selectedProduct: { id: 5, pricing_type: "STITCH_BASED" } };
  assert.equal(validateOrderStep(3, { ...stitchBased, orderForm: { ...stitchBased.orderForm, stitch_count: 0 } }),
    "Enter the number of stitches.");
  assert.equal(validateOrderStep(3, stitchBased), "");
});

test("wizard step 3 lists every missing measurement field", () => {
  const withTemplate = {
    ...baseContext,
    selectedTemplate: { id: 1, name: "Blouse", fields: ["Bust", "Waist", "Shoulder"] },
  };
  const problem = validateOrderStep(3, withTemplate);
  assert.match(problem, /Enter all measurements/);
  assert.match(problem, /Bust/);
  assert.match(problem, /Waist/);
  assert.match(problem, /Shoulder/);
  const filled = { ...withTemplate, orderForm: { ...withTemplate.orderForm, measurements: { Bust: "36", Waist: "30", Shoulder: "14" } } };
  assert.equal(validateOrderStep(3, filled), "");
});

test("wizard step 3 allows products without measurements", () => {
  assert.equal(validateOrderStep(3, baseContext), "");
});

test("wizard step 5 blocks an advance larger than the order total", () => {
  assert.equal(validateOrderStep(5, { ...baseContext, orderForm: { ...baseContext.orderForm, paid_amount: 600 } }),
    "Advance paid cannot be more than the order total.");
  assert.equal(validateOrderStep(5, { ...baseContext, orderForm: { ...baseContext.orderForm, paid_amount: 500 } }), "");
  assert.equal(validateOrderStep(5, { ...baseContext, orderForm: { ...baseContext.orderForm, paid_amount: 0 } }), "");
});

test("wizard validation ignores steps that are not being checked", () => {
  assert.equal(validateOrderStep(4, { ...baseContext, orderForm: { ...baseContext.orderForm, customer_id: "" } }), "");
  assert.equal(validateOrderStep(6, baseContext), "");
});

// ---------------------------------------------------------------------------
// Payment collection
// ---------------------------------------------------------------------------
test("payment amount must be a positive number within the balance", () => {
  assert.equal(validatePaymentAmount("", 100), "Enter an amount greater than ₹0.");
  assert.equal(validatePaymentAmount("0", 100), "Enter an amount greater than ₹0.");
  assert.equal(validatePaymentAmount("-50", 100), "Enter an amount greater than ₹0.");
  assert.equal(validatePaymentAmount("abc", 100), "Enter an amount greater than ₹0.");
  assert.match(validatePaymentAmount(150, 100), /outstanding balance is ₹100/);
  assert.equal(validatePaymentAmount(100, 100), "");
  assert.equal(validatePaymentAmount("75.5", 100), "");
});

test("remainingBalance never goes negative", () => {
  assert.equal(remainingBalance(100, 40), 60);
  assert.equal(remainingBalance(100, 100), 0);
  assert.equal(remainingBalance(100, 140), 0);
});

// ---------------------------------------------------------------------------
// Reference images
// ---------------------------------------------------------------------------
test("reference images must be JPEG or PNG and under 4 MB", () => {
  assert.equal(validateReferenceImage(null), "");
  assert.equal(validateReferenceImage({ type: "image/jpeg", size: 1000 }), "");
  assert.equal(validateReferenceImage({ type: "image/png", size: MAX_REFERENCE_IMAGE_BYTES }), "");
  assert.equal(validateReferenceImage({ type: "application/pdf", size: 1000 }),
    "Only JPEG and PNG images are supported.");
  assert.equal(validateReferenceImage({ type: "image/jpeg", size: MAX_REFERENCE_IMAGE_BYTES + 1 }),
    "Reference image must be 4 MB or smaller.");
});

// ---------------------------------------------------------------------------
// Tamil
// ---------------------------------------------------------------------------
test("Tamil unicode is detected for rendering checks", () => {
  assert.equal(isTamilText("வணக்கம்"), true);
  assert.equal(isTamilText("தமிழ்"), true);
  assert.equal(isTamilText("Hello"), false);
  assert.equal(isTamilText(""), false);
});
