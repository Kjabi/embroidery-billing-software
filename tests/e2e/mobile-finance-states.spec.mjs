// Mobile finance, products, the More screen, and the loading / empty / error
// / session-expiry states.
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
  assertAccessibleControls,
  assertInputFontSizes,
  assertNoErrors,
  assertNoHorizontalOverflow,
  assertTouchTargets,
  closeAnyOverlay,
  closeBrowser,
  login,
  newPage,
  openMobileSection,
  openMobileTab,
} from "../helpers/harness.mjs";

describe("mobile finance, products and the More screen", () => {
  let page;

  before(async () => {
    page = await newPage({ mobile: true, width: 390, height: 844 });
    await login(page);
  });

  after(async () => {
    await closeBrowser();
  });

  test("finance shows the money metrics, a period switch and the ledger", async () => {
    await openMobileSection(page, "Finance & reports");
    await page.waitForTimeout(900);
    const metrics = await page.locator(".mobile-metric").count();
    assert.equal(metrics, 4, `expected four finance metrics, found ${metrics}`);
    const chips = await page.locator(".mobile-chip").allInnerTexts();
    assert.deepEqual(chips.map(text => text.trim()), ["This month", "This year", "All time"]);
    await page.locator(".mobile-chip").filter({ hasText: /^This month$/ }).click();
    await page.waitForTimeout(900);
    await page.locator(".mobile-chip").filter({ hasText: /^All time$/ }).click();
    await page.waitForTimeout(900);
    assert.ok(await page.locator(".mobile-date-row input").count() >= 2, "the custom date range is missing");
    await assertNoHorizontalOverflow(page, "finance");
    await assertAccessibleControls(page, "finance");
  });

  test("finance can record an income or expense entry", async () => {
    await openMobileSection(page, "Finance & reports");
    await page.waitForTimeout(700);
    await page.locator(".mobile-link-button", { hasText: "Add entry" }).click();
    await page.waitForTimeout(400);
    await page.getByLabel("Category").fill("E2E thread");
    await page.getByLabel(/Amount/).fill("12.50");
    await page.getByLabel(/Description/).fill("mobile end-to-end entry");
    await page.getByRole("button", { name: "Save entry" }).click();
    await page.waitForTimeout(1500);
    const ledger = await page.locator(".mobile-card-list").innerText();
    assert.match(ledger, /E2E thread/i, "the new ledger entry is not listed");
  });

  test("the ledger offers CSV and PDF export", async () => {
    await openMobileSection(page, "Finance & reports");
    await page.waitForTimeout(700);
    const buttons = await page.locator(".mobile-button-row button").allInnerTexts();
    assert.deepEqual(buttons.map(text => text.trim()), ["CSV", "PDF"]);
  });

  test("products, stitch rates and measurement templates are all reachable", async () => {
    await openMobileSection(page, "Products & rates");
    await page.waitForTimeout(900);
    const tabs = await page.locator(".mobile-segmented button").allInnerTexts();
    assert.deepEqual(tabs.map(text => text.trim()), ["Products", "Stitch rates", "Templates"]);
    assert.ok(await page.locator(".mobile-list-card").count() > 0, "no products are listed");

    await page.locator(".mobile-segmented button", { hasText: "Stitch rates" }).click();
    await page.waitForTimeout(600);
    assert.ok(await page.locator(".mobile-list-card").count() > 0, "no stitch rates are listed");

    await page.locator(".mobile-segmented button", { hasText: "Templates" }).click();
    await page.waitForTimeout(600);
    assert.ok(await page.locator(".mobile-list-card").count() > 0, "no measurement templates are listed");
    await assertNoHorizontalOverflow(page, "products");
  });

  test("a stitch rate can be edited from the phone", async () => {
    await openMobileSection(page, "Products & rates");
    await page.waitForTimeout(700);
    await page.locator(".mobile-segmented button", { hasText: "Stitch rates" }).click();
    await page.waitForTimeout(600);
    await page.locator(".mobile-ghost-button", { hasText: "Edit rate" }).first().click();
    await page.waitForTimeout(500);
    const field = page.getByLabel(/Rate per stitch/);
    assert.ok(await field.count() > 0, "the rate editor did not open");
    await assertInputFontSizes(page, "rate editor");
    await page.getByRole("button", { name: "Close rate editor" }).click();
    await closeAnyOverlay(page);
  });

  test("the More screen exposes every business area and the backup tools", async () => {
    await openMobileTab(page, "More");
    await page.waitForTimeout(700);
    const text = await page.locator(".mobile-screen").innerText();
    for (const label of [
      "Products & rates", "Finance & reports", "Orders & invoices",
      "Customers", "New order", "Measurements",
      "Backup database", "Restore from file", "Cloud backup", "Log out",
    ]) {
      assert.ok(text.includes(label), `the More screen is missing "${label}"`);
    }
    assert.match(text, /தமிழ்/, "the Tamil language note is missing");
    await assertTouchTargets(page, "more screen");
    await assertAccessibleControls(page, "more screen");
  });

  test("an empty search result shows the empty state", async () => {
    await openMobileTab(page, "Customers");
    await page.getByLabel("Search customers").fill("zzz-nothing-matches-zzz");
    await page.waitForTimeout(800);
    const empty = await page.locator(".mobile-empty").innerText();
    assert.match(empty, /No customers found/i);
    await page.getByLabel("Search customers").fill("");
    await page.waitForTimeout(400);
  });

  test("a loading state is shown while the data is still in flight", async () => {
    // Hold the orders request open until the test releases it. A plain
    // setTimeout inside the handler can outlive the test and then touch an
    // already-handled route, so the gate is explicit and always released.
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/api/orders*", async route => {
      await gate;
      // The reload may cancel the request before it is released; that is
      // expected and must not surface as an unhandled rejection.
      await route.continue().catch(() => {});
    });
    // A genuine reload of the orders tab has no cached rows, so the skeleton
    // is shown. (A hash change alone is a same-document navigation and keeps
    // the already loaded rows on screen, which is the intended behaviour.)
    await page.goto(`${page.url().split("#")[0]}#/invoices`, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    const loading = await page.locator(".mobile-loading").count();
    release();
    await page.waitForTimeout(1500);
    await page.unroute("**/api/orders*");
    assert.ok(loading > 0, "no loading indicator was shown while the request was pending");
  });

  test("a failed request shows a recoverable error banner", async () => {
    await page.route("**/api/customers*", route => route.abort("failed"));
    await openMobileTab(page, "Customers");
    await page.waitForTimeout(1500);
    const banner = await page.locator(".mobile-banner-warning").innerText();
    assert.match(banner, /could not be loaded/i);
    assert.ok(await page.locator(".mobile-banner-warning button", { hasText: "Retry" }).count() > 0, "no retry action is offered");
    await page.unroute("**/api/customers*");
    await page.waitForTimeout(800);
  });

  test("an expired session returns the admin to the login screen", async () => {
    await page.route("**/api/**", route =>
      route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ detail: "Invalid or expired session" }) })
    );
    await page.evaluate(() => { window.location.hash = "#/dashboard"; });
    await page.waitForTimeout(2000);
    const hasLogin = await page.locator("input#login-username").count();
    assert.equal(hasLogin, 1, "the app did not return to the login screen after a 401");
    await page.unroute("**/api/**");
    // Restore a usable session for the remaining checks.
    await login(page);
  });

  test("these screens produced no unexpected console errors", () => {
    // The aborted-request test deliberately makes the app log a diagnostic.
    const unexpected = page.__errors.console.filter(text =>
      !/Failed to load resource|net::ERR_FAILED|401|Could not load application data/i.test(text)
    );
    assert.deepEqual(unexpected, [], `unexpected console errors: ${unexpected.slice(0, 4).join(" | ")}`);
  });
});
