// Desktop regression: the approved desktop UI must be unchanged by the mobile
// redesign. These checks pin the layout, navigation, tables and forms at the
// four desktop widths and verify that no mobile-only shell leaks through.
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
  DESKTOP_HEIGHT,
  DESKTOP_WIDTHS,
  apiClient,
  apiToken,
  assertAccessibleControls,
  assertNoErrors,
  assertNoHorizontalOverflow,
  closeAnyOverlay,
  closeBrowser,
  deleteCustomerIfExists,
  findProduct,
  login,
  newPage,
  seedCustomer,
  seedOrder,
} from "../helpers/harness.mjs";

const DESKTOP_NAV = ["Dashboard", "New Order", "Orders", "Customers", "Products", "Finance"];
const DESKTOP_ONLY_WIDTHS = [1024, 1280, 1440];

describe("desktop regression", () => {
  let page;
  let api;
  let customer;
  let product;

  before(async () => {
    page = await newPage({ mobile: false, width: 1440, height: DESKTOP_HEIGHT });
    api = apiClient(await apiToken());
    await login(page);
    customer = await seedCustomer(api, { city: "Coimbatore" });
    product = await findProduct(api, item => item.pricing_type !== "STITCH_BASED" && !item.measurement_template_id);
  });

  after(async () => {
    await deleteCustomerIfExists(api, customer);
    await closeBrowser();
  });

  test("the desktop sidebar keeps its approved width and sections", async () => {
    for (const width of DESKTOP_WIDTHS) {
      await page.setViewportSize({ width, height: DESKTOP_HEIGHT });
      await page.waitForTimeout(350);
      const layout = await page.evaluate(() => ({
        asideWidth: Math.round(document.querySelector("aside").getBoundingClientRect().width),
        mainLeft: Math.round(document.querySelector("main").getBoundingClientRect().left),
        mobileShell: Boolean(document.querySelector(".mobile-app")),
        bottomNav: Boolean(document.querySelector(".mobile-bottom-nav")),
      }));
      assert.ok(layout.asideWidth >= 220 && layout.asideWidth <= 260, `${width}: sidebar is ${layout.asideWidth}px`);
      assert.ok(layout.mainLeft >= layout.asideWidth - 8, `${width}: main content starts at ${layout.mainLeft}px`);
      assert.equal(layout.mobileShell, false, `${width}: the mobile shell leaked onto desktop`);
      assert.equal(layout.bottomNav, false, `${width}: the mobile bottom nav leaked onto desktop`);
    }
    const labels = await page.locator("aside nav button").allInnerTexts();
    assert.deepEqual(labels.map(text => text.trim()), DESKTOP_NAV);
  });

  test("no horizontal overflow on any desktop section", async () => {
    for (const width of DESKTOP_WIDTHS) {
      await page.setViewportSize({ width, height: DESKTOP_HEIGHT });
      await page.waitForTimeout(300);
      for (const section of DESKTOP_NAV) {
        await page.locator("aside nav button").filter({ hasText: section }).first().click();
        await page.waitForTimeout(500);
        await assertNoHorizontalOverflow(page, `${width} ${section}`);
      }
    }
  });

  test("the orders table still renders as a table with money columns", async () => {
    await page.setViewportSize({ width: 1440, height: DESKTOP_HEIGHT });
    await page.locator("aside nav button").filter({ hasText: "Orders" }).first().click();
    await page.waitForTimeout(900);
    const table = page.locator("main table").first();
    assert.ok(await table.count() > 0, "the desktop orders table disappeared");
    // The table headers are rendered uppercase by CSS, so compare case-insensitively.
    const header = (await table.locator("thead").innerText()).toLowerCase();
    for (const column of ["invoice", "date", "customer", "total", "paid", "balance", "status"]) {
      assert.ok(header.includes(column), `the orders table lost the "${column}" column`);
    }
    const rows = await table.locator("tbody tr").count();
    assert.ok(rows > 0, "the orders table rendered no rows");
  });

  test("the customers table and its search still work on desktop", async () => {
    await page.locator("aside nav button").filter({ hasText: "Customers" }).first().click();
    await page.waitForTimeout(800);
    const search = page.locator("main input[placeholder*='Search' i]").first();
    assert.ok(await search.count() > 0, "the desktop customer search disappeared");
    await search.fill(customer.name);
    await page.waitForTimeout(700);
    const body = await page.locator("main").innerText();
    assert.ok(body.includes(customer.name), "the desktop search did not find the seeded customer");
    await search.fill("");
    await page.waitForTimeout(500);
  });

  test("a desktop order opens the invoice detail and the payment dialog", async () => {
    const order = await seedOrder(api, {
      customer_id: customer.id,
      product_id: product.id,
      total_amount: 2600,
      paid_amount: 600,
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    await page.locator("aside nav button").filter({ hasText: "Orders" }).first().click();
    await page.waitForTimeout(800);

    const row = page.locator("main table tbody tr", { hasText: order.invoice_number }).first();
    await row.waitFor({ timeout: 10000 });
    await row.getByRole("button", { name: /view|open|details/i }).first().click().catch(async () => {
      await row.click();
    });
    await page.waitForTimeout(900);

    const detail = await page.locator('[role="dialog"], .mobile-sheet, main').first().innerText();
    assert.match(detail, new RegExp(order.invoice_number), "the invoice number is missing from the desktop detail");

    // The desktop collect-payment flow must use the shared in-app dialog, not
    // window.prompt.
    const collect = page.getByRole("button", { name: /collect payment|record payment|collect/i }).first();
    if (await collect.count()) {
      await collect.click();
      await page.waitForTimeout(600);
      const dialog = page.locator('[role="dialog"], [role="alertdialog"], .mobile-dialog').first();
      assert.ok(await dialog.count() > 0, "collecting a payment opened no in-app dialog");
      await closeAnyOverlay(page);
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(400);
      await closeAnyOverlay(page);
    }
    await closeAnyOverlay(page);
    await api.delete(`/orders/${order.id}`);
  });

  test("the desktop forms keep their multi-column layout", async () => {
    await closeAnyOverlay(page);
    await page.setViewportSize({ width: 1440, height: DESKTOP_HEIGHT });
    await page.locator("aside nav button").filter({ hasText: "New Order" }).first().click();
    await page.waitForTimeout(800);
    const columns = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("main input, main select, main textarea"));
      const columns = new Set(inputs.map(el => Math.round(el.getBoundingClientRect().left / 40)));
      return { inputs: inputs.length, columns: columns.size };
    });
    assert.ok(columns.inputs > 6, `the desktop order form only shows ${columns.inputs} fields`);
    assert.ok(columns.columns >= 2, "the desktop order form collapsed into a single column");
  });

  test("desktop controls stay labelled", async () => {
    await closeAnyOverlay(page);
    await page.locator("aside nav button").filter({ hasText: "Dashboard" }).first().click();
    await page.waitForTimeout(700);
    await assertAccessibleControls(page, "1440 dashboard");
  });

  test("desktop produces no console, page or request errors", () => {
    assertNoErrors(page, "desktop regression");
  });
});
