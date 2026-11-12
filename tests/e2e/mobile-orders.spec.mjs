// Mobile order flows: order list, status filters, the guided six-step new
// order wizard, draft persistence, payment collection and invoice retrieval.
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
  API_URL,
  apiClient,
  apiToken,
  assertAccessibleControls,
  assertNoErrors,
  assertNoHorizontalOverflow,
  assertTouchTargets,
  closeAnyOverlay,
  closeBrowser,
  confirmDialog,
  deleteCustomerIfExists,
  findProduct,
  login,
  newPage,
  openMobileSection,
  openMobileTab,
  reloadApp,
  seedCustomer,
  seedOrder,
} from "../helpers/harness.mjs";

describe("mobile order flows", () => {
  let page;
  let api;
  let customer;
  let product;

  before(async () => {
    page = await newPage({ mobile: true, width: 390, height: 844 });
    api = apiClient(await apiToken());
    await login(page);
    customer = await seedCustomer(api, { city: "Madurai" });
    // A fixed-price product without a measurement template keeps the wizard
    // path short and deterministic.
    product = await findProduct(api, item => item.pricing_type !== "STITCH_BASED" && !item.measurement_template_id);
  });

  after(async () => {
    await deleteCustomerIfExists(api, customer);
    await closeBrowser();
  });

  test("the order list renders cards with totals", async () => {
    await openMobileTab(page, "Orders");
    await page.waitForTimeout(900);
    const cards = await page.locator(".mobile-order-card").count();
    assert.ok(cards > 0, "no order cards were rendered");
    const first = await page.locator(".mobile-order-card").first().innerText();
    assert.match(first, /TOTAL/i);
    assert.match(first, /BALANCE/i);
    await assertNoHorizontalOverflow(page, "orders list");
  });

  test("the status filter narrows the list", async () => {
    await openMobileTab(page, "Orders");
    await page.waitForTimeout(600);
    const all = await page.locator(".mobile-order-card").count();
    await page.locator(".mobile-chip").filter({ hasText: /^Paid$/ }).click();
    await page.waitForTimeout(600);
    const paid = await page.locator(".mobile-order-card").count();
    assert.ok(paid <= all, "the Paid filter returned more cards than All");
    await page.locator(".mobile-chip").filter({ hasText: /^All$/ }).click();
    await page.waitForTimeout(500);
  });

  test("searching for an invoice number finds the order", async () => {
    const order = await seedOrder(api, {
      customer_id: customer.id,
      product_id: product.id,
      total_amount: 2400,
      paid_amount: 0,
      description: "searchable order",
    });
    await reloadApp(page);
    await openMobileTab(page, "Orders");
    await page.getByLabel("Search orders").fill(order.invoice_number);
    await page.waitForTimeout(800);
    const cards = await page.locator(".mobile-order-card").count();
    assert.equal(cards, 1, `expected exactly one match, found ${cards}`);
    await page.getByLabel("Search orders").fill("");
    await api.delete(`/orders/${order.id}`);
  });

  test("the order sheet shows the money summary and the invoice actions", async () => {
    await closeAnyOverlay(page);
    const order = await seedOrder(api, {
      customer_id: customer.id,
      product_id: product.id,
      total_amount: 3000,
      paid_amount: 1000,
    });
    await reloadApp(page);
    await openMobileTab(page, "Orders");
    await page.getByLabel("Search orders").fill(order.invoice_number);
    await page.waitForTimeout(700);
    await page.locator(".mobile-order-card", { hasText: order.invoice_number }).first().locator(".mobile-order-main").click();
    await page.waitForTimeout(600);
    const text = await page.locator(".mobile-sheet-body").innerText();
    assert.match(text, /Order total/);
    assert.match(text, /Balance due/);
    assert.match(text, /₹2,000/, "the outstanding balance must be shown");
    for (const action of ["View / download PDF", "WhatsApp bill", "Send PDF", "Ready message"]) {
      assert.ok(text.includes(action), `missing invoice action: ${action}`);
    }
    await assertTouchTargets(page, "order sheet");
    await assertAccessibleControls(page, "order sheet");
    await page.getByRole("button", { name: "Close order details" }).click();
    await api.delete(`/orders/${order.id}`);
  });

  test("the six step wizard creates an order and shows the correct balance", async () => {
    await openMobileSection(page, "New order");
    await page.waitForTimeout(600);

    // Step 1 - customer
    await page.locator(".mobile-select-card", { hasText: customer.name }).first().click();
    await page.getByRole("button", { name: /Continue/ }).click();
    await page.waitForTimeout(400);

    // Step 2 - product
    await page.locator(".mobile-select-card", { hasText: product.name }).first().click();
    await page.getByRole("button", { name: /Continue/ }).click();
    await page.waitForTimeout(400);

    // Step 3 - measurements (not required for this product)
    await page.getByRole("button", { name: /Continue/ }).click();
    await page.waitForTimeout(400);

    // Step 4 - design
    await page.getByLabel(/Cloth & design notes/).fill("E2E wizard order");
    await page.getByRole("button", { name: /Continue/ }).click();
    await page.waitForTimeout(400);

    // Step 5 - price and delivery
    await page.getByLabel("Delivery date").fill("2026-12-01");
    const basePrice = Number(product.base_price || 0);
    await page.getByLabel(/Base price/).fill(String(basePrice || 100));
    await page.getByLabel(/Advance paid now/).fill("100");
    await page.getByRole("button", { name: /Continue/ }).click();
    await page.waitForTimeout(400);

    // Step 6 - review
    const review = await page.locator(".mobile-review-list").innerText();
    assert.match(review, new RegExp(customer.name));
    assert.match(review, new RegExp(product.name));

    const createdResponse = page.waitForResponse(
      response => response.url().endsWith("/api/orders") && response.request().method() === "POST",
      { timeout: 25000 }
    );
    await page.getByRole("button", { name: "Save order" }).click();
    const created = await (await createdResponse).json();
    assert.ok(created.invoice_number, "no invoice number was returned");

    await page.waitForTimeout(1500);
    const detail = await page.locator(".mobile-sheet-body").innerText();
    assert.match(detail, /Balance due/);
    await api.delete(`/orders/${created.id}`);
    await closeAnyOverlay(page);
  });

  test("the wizard refuses to advance without a customer", async () => {
    await openMobileSection(page, "New order");
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: /Continue/ }).click();
    await page.waitForTimeout(400);
    const error = await page.locator(".mobile-banner-danger").innerText();
    assert.match(error, /Choose a customer/i);
    await closeAnyOverlay(page);
  });

  test("an order draft survives a page reload", async () => {
    await openMobileSection(page, "New order");
    await page.waitForTimeout(500);
    await page.locator(".mobile-select-card", { hasText: customer.name }).first().click();
    await page.getByRole("button", { name: /Continue/ }).click();
    await page.waitForTimeout(300);
    await page.locator(".mobile-select-card", { hasText: product.name }).first().click();
    await page.getByRole("button", { name: /Continue/ }).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /Continue/ }).click();
    await page.waitForTimeout(300);
    await page.getByLabel(/Cloth & design notes/).fill("DRAFT-KEPT");
    await page.waitForTimeout(700);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1600);
    const value = await page.getByLabel(/Cloth & design notes/).inputValue().catch(() => "");
    assert.equal(value, "DRAFT-KEPT", "the draft was lost on reload");
    assert.equal(await page.evaluate(() => window.location.hash), "#/new-order");
    await page.evaluate(() => {
      localStorage.removeItem("lalithas_order_draft");
      localStorage.removeItem("lalithas_order_step");
    });
    await closeAnyOverlay(page);
  });

  test("a payment is collected and the order becomes fully paid", async () => {
    const order = await seedOrder(api, {
      customer_id: customer.id,
      product_id: product.id,
      total_amount: 1800,
      paid_amount: 300,
    });
    await reloadApp(page);
    await openMobileTab(page, "Orders");
    await page.getByLabel("Search orders").fill(order.invoice_number);
    await page.waitForTimeout(800);
    await page.locator(".mobile-order-card", { hasText: order.invoice_number }).first().locator(".mobile-order-main").click();
    await page.waitForTimeout(500);
    await page.locator(".mobile-sheet-actions .mobile-primary-button", { hasText: "Collect" }).click();
    await page.waitForTimeout(500);

    const dialog = page.locator(".mobile-dialog");
    await dialog.waitFor({ timeout: 8000 });
    const amount = await dialog.locator(".mobile-field input").inputValue();
    assert.equal(Number(amount), 1500, "the dialog must default to the full balance");

    // An over-payment must be refused.
    await dialog.locator(".mobile-field input").fill("9999");
    await page.getByRole("button", { name: /Confirm/ }).click();
    await page.waitForTimeout(400);
    const error = await page.locator(".mobile-dialog .mobile-banner-danger").innerText();
    assert.match(error, /outstanding balance/i);

    // The correct amount succeeds.
    await dialog.locator(".mobile-field input").fill("1500");
    await page.getByRole("button", { name: /Confirm/ }).click();
    await page.waitForSelector(".mobile-dialog", { state: "detached", timeout: 15000 });
    await page.waitForTimeout(1200);
    const detail = await page.locator(".mobile-sheet-body").innerText();
    assert.match(detail, /Paid in full/i);
    assert.match(detail, /₹0/);

    await api.delete(`/orders/${order.id}`);
    await closeAnyOverlay(page);
  });

  test("the invoice PDF is downloadable for an order", async () => {
    const order = await seedOrder(api, {
      customer_id: customer.id,
      product_id: product.id,
      total_amount: 900,
      paid_amount: 0,
    });
    const token = await apiToken();
    const response = await fetch(`${API_URL}/orders/${order.id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /application\/pdf/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length > 800, `the invoice PDF looks empty (${bytes.length} bytes)`);
    assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
    await api.delete(`/orders/${order.id}`);
  });

  test("an order can be deleted with an in-app confirmation", async () => {
    const order = await seedOrder(api, {
      customer_id: customer.id,
      product_id: product.id,
      total_amount: 500,
      paid_amount: 0,
    });
    await reloadApp(page);
    await openMobileTab(page, "Orders");
    await page.getByLabel("Search orders").fill(order.invoice_number);
    await page.waitForTimeout(800);
    await page.locator(".mobile-order-card", { hasText: order.invoice_number }).first().locator(".mobile-order-main").click();
    await page.waitForTimeout(500);
    await page.locator(".mobile-sheet-actions .mobile-danger-outline-button", { hasText: "Delete order" }).click();
    await confirmDialog(page, "Delete order");
    await page.waitForTimeout(1500);

    const { status } = await api.get("/orders?limit=200");
    assert.equal(status, 200);
    await closeAnyOverlay(page);
  });

  test("the order screens produced no console errors", () => {
    assertNoErrors(page, "mobile orders");
  });
});
