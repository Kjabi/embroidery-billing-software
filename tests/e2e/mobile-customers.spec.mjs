// Mobile customer flows: create, search, call, edit, delete, and the empty and
// error states that surround them.
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
  apiClient,
  apiToken,
  assertAccessibleControls,
  assertInputFontSizes,
  assertNoErrors,
  assertNoHorizontalOverflow,
  assertTouchTargets,
  closeAnyOverlay,
  closeBrowser,
  confirmDialog,
  deleteCustomerIfExists,
  login,
  newPage,
  openMobileTab,
  seedCustomer,
  uniqueName,
  uniquePhone,
} from "../helpers/harness.mjs";

describe("mobile customer flows", () => {
  let page;
  let api;
  const created = [];

  before(async () => {
    page = await newPage({ mobile: true, width: 390, height: 844 });
    api = apiClient(await apiToken());
    await login(page);
  });

  after(async () => {
    for (const customer of created) await deleteCustomerIfExists(api, customer);
    await closeBrowser();
  });

  test("the customer list renders the seeded customers", async () => {
    await closeAnyOverlay(page);
    await openMobileTab(page, "Customers");
    const cards = await page.locator(".mobile-customer-card").count();
    assert.ok(cards > 0, "no customer cards were rendered");
    await assertNoHorizontalOverflow(page, "customers list");
  });

  test("a customer can be created from the phone", async () => {
    const name = uniqueName("Mobile E2E");
    const phone = uniquePhone();
    await openMobileTab(page, "Customers");
    await page.locator(".mobile-screen-head .mobile-primary-button", { hasText: "Add" }).click();
    await page.waitForTimeout(300);
    await page.getByLabel("Customer name").fill(name);
    await page.getByLabel(/Phone number/).fill(phone);
    await page.getByLabel("City").fill("Madurai");
    await page.getByLabel(/Special notes/).fill("created by the mobile end-to-end suite");
    await page.getByRole("button", { name: "Save customer" }).click();
    await page.waitForSelector(".mobile-sheet", { state: "detached", timeout: 15000 });
    await page.waitForTimeout(800);

    await page.getByLabel("Search customers").fill(name);
    await page.waitForTimeout(700);
    const card = page.locator(".mobile-customer-card", { hasText: name });
    await card.first().waitFor({ timeout: 8000 });
    assert.ok(await card.count() > 0, "the new customer was not listed");

    const { body } = await api.get(`/customers?q=${encodeURIComponent(name)}`);
    const list = Array.isArray(body) ? body : (body.items || []);
    created.push(list.find(customer => customer.name === name));
  });

  test("the phone field only accepts digits and the form is keyboard ready", async () => {
    await openMobileTab(page, "Customers");
    await page.locator(".mobile-screen-head .mobile-primary-button", { hasText: "Add" }).click();
    await page.waitForTimeout(300);
    const phone = page.getByLabel(/Phone number/);
    // The field has maxlength=10, so the browser truncates the raw value
    // before the React handler strips the non-digits.
    await phone.fill("98a76b5c4");
    const value = await phone.inputValue();
    assert.equal(value, "987654", `non-digits must be rejected, got "${value}"`);
    assert.equal(await phone.getAttribute("inputmode"), "numeric");
    assert.equal(await phone.getAttribute("maxlength"), "10");
    await assertInputFontSizes(page, "customer form");
    await assertAccessibleControls(page, "customer form");
    await assertTouchTargets(page, "customer form");
    await page.getByRole("button", { name: "Close customer form" }).click();
  });

  test("a duplicate phone number warns before saving", async () => {
    const existing = created[0];
    assert.ok(existing, "no customer was created in the previous step");
    await openMobileTab(page, "Customers");
    await page.locator(".mobile-screen-head .mobile-primary-button", { hasText: "Add" }).click();
    await page.waitForTimeout(300);
    await page.getByLabel("Customer name").fill(uniqueName("Duplicate"));
    await page.getByLabel(/Phone number/).fill(existing.phone);
    await page.waitForTimeout(500);
    const banner = await page.locator(".mobile-banner-warning").innerText();
    assert.match(banner, new RegExp(existing.name), `expected a duplicate warning, got "${banner}"`);
    await page.getByRole("button", { name: "Close customer form" }).click();
  });

  test("the customer sheet exposes a working telephone link", async () => {
    const existing = created[0];
    await openMobileTab(page, "Customers");
    await page.getByLabel("Search customers").fill(existing.name);
    await page.waitForTimeout(700);
    await page.locator(".mobile-customer-card", { hasText: existing.name }).first().locator(".mobile-customer-main").click();
    await page.waitForTimeout(500);
    const href = await page.locator(".mobile-contact-card").first().getAttribute("href");
    assert.equal(href, `tel:${existing.phone}`);
    await page.getByRole("button", { name: "Close customer details" }).click();
  });

  test("a customer can be edited and the change is persisted", async () => {
    const existing = created[0];
    await openMobileTab(page, "Customers");
    await page.getByLabel("Search customers").fill(existing.name);
    await page.waitForTimeout(700);
    await page.locator(".mobile-customer-card", { hasText: existing.name }).first().locator(".mobile-customer-main").click();
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Edit customer" }).click();
    await page.waitForTimeout(400);
    await page.getByLabel("City").fill("Coimbatore");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForSelector(".mobile-sheet", { state: "detached", timeout: 15000 });
    await page.waitForTimeout(800);

    const { status, body } = await api.get(`/customers?q=${encodeURIComponent(existing.name)}`);
    assert.equal(status, 200, `customer read failed with ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    const list = Array.isArray(body) ? body : (body.items || []);
    const stored = list.find(customer => customer.id === existing.id);
    assert.ok(stored, "the customer disappeared from the directory");
    assert.equal(stored.city, "Coimbatore", `the city change was not persisted (city=${stored.city})`);
  });

  test("a customer can be deleted with an in-app confirmation", async () => {
    const existing = created[0];
    await openMobileTab(page, "Customers");
    await page.getByLabel("Search customers").fill(existing.name);
    await page.waitForTimeout(700);
    await page.locator(".mobile-customer-card", { hasText: existing.name }).first().locator(".mobile-customer-main").click();
    await page.waitForTimeout(400);
    await page.locator(".mobile-sheet-actions .mobile-danger-outline-button", { hasText: "Delete" }).click();
    await confirmDialog(page, "Delete customer");
    await page.waitForSelector(".mobile-sheet", { state: "detached", timeout: 15000 });
    await page.waitForTimeout(900);

    const { body } = await api.get(`/customers?q=${encodeURIComponent(existing.name)}`);
    const list = Array.isArray(body) ? body : (body.items || []);
    assert.equal(
      list.some(customer => customer.id === existing.id),
      false,
      "the customer still exists after the delete"
    );
  });

  test("an empty search shows a helpful empty state", async () => {
    await openMobileTab(page, "Customers");
    await page.getByLabel("Search customers").fill("zzz-no-such-customer-zzz");
    await page.waitForTimeout(700);
    const empty = await page.locator(".mobile-empty").innerText();
    assert.match(empty, /No customers found/i);
    await page.getByLabel("Search customers").fill("");
  });

  test("the customer screen produced no console errors", () => {
    assertNoErrors(page, "mobile customers");
  });
});
