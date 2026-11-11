// Mobile shell, navigation and responsive layout rules.
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
  ALL_WIDTHS,
  DESKTOP_HEIGHT,
  DESKTOP_WIDTHS,
  MOBILE_HEIGHT,
  MOBILE_WIDTHS,
  assertAccessibleControls,
  assertInputFontSizes,
  assertNoErrors,
  assertNoHorizontalOverflow,
  assertTouchTargets,
  closeBrowser,
  login,
  newPage,
  openMobileTab,
} from "../helpers/harness.mjs";

describe("mobile shell", () => {
  let page;

  before(async () => {
    page = await newPage({ mobile: true });
    await login(page);
  });

  after(async () => {
    await closeBrowser();
  });

  test("renders the mobile shell below 768px and the desktop shell at 768px and above", async () => {
    for (const width of ALL_WIDTHS) {
      const mobile = width <= 767;
      await page.setViewportSize({ width, height: mobile ? MOBILE_HEIGHT : DESKTOP_HEIGHT });
      await page.waitForTimeout(350);
      const shape = await page.evaluate(() => ({
        hasMobileApp: Boolean(document.querySelector(".mobile-app")),
        hasBottomNav: Boolean(document.querySelector(".mobile-bottom-nav")),
        hasDesktopAside: Boolean(document.querySelector("aside")),
        hasDesktopMain: Boolean(document.querySelector("main")),
      }));
      if (mobile) {
        assert.ok(shape.hasMobileApp, `${width}: mobile shell missing`);
        assert.ok(shape.hasBottomNav, `${width}: bottom navigation missing`);
        assert.equal(shape.hasDesktopAside, false, `${width}: desktop sidebar must not render on mobile`);
      } else {
        assert.equal(shape.hasMobileApp, false, `${width}: mobile shell must not render on desktop`);
        assert.ok(shape.hasDesktopAside, `${width}: desktop sidebar missing`);
        assert.ok(shape.hasDesktopMain, `${width}: desktop main missing`);
      }
    }
  });

  test("no horizontal overflow on any screen at any tested width", async () => {
    for (const width of MOBILE_WIDTHS) {
      await page.setViewportSize({ width, height: MOBILE_HEIGHT });
      await page.waitForTimeout(300);
      await assertNoHorizontalOverflow(page, `${width} dashboard`);
      for (const tab of ["Orders", "Customers", "Payments", "More"]) {
        await openMobileTab(page, tab);
        await assertNoHorizontalOverflow(page, `${width} ${tab}`);
      }
    }
  });

  test("bottom navigation has the five expected tabs with large enough targets", async () => {
    await page.setViewportSize({ width: 390, height: MOBILE_HEIGHT });
    await page.waitForTimeout(300);
    const labels = await page.locator(".mobile-bottom-nav button span").allInnerTexts();
    assert.deepEqual(labels.map(text => text.trim()), ["Home", "Orders", "Customers", "Payments", "More"]);
    const heights = await page.locator(".mobile-bottom-nav button").evaluateAll(
      nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height))
    );
    for (const height of heights) assert.ok(height >= 44, `bottom nav target is only ${height}px tall`);
  });

  test("the bottom navigation never covers interactive content", async () => {
    await page.setViewportSize({ width: 390, height: MOBILE_HEIGHT });
    await page.waitForTimeout(300);
    const overlap = await page.evaluate(() => {
      const nav = document.querySelector(".mobile-bottom-nav");
      if (!nav) return { ok: true, offenders: [] };
      const navRect = nav.getBoundingClientRect();
      const offenders = [];
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return !el.disabled
          && rect.width > 0
          && rect.height > 0
          && style.visibility !== "hidden"
          && style.display !== "none";
      };
      for (const el of document.querySelectorAll(".mobile-app button, .mobile-app input, .mobile-app a[href]")) {
        if (nav.contains(el) || !visible(el)) continue;
        const rect = el.getBoundingClientRect();
        const insideX = rect.left < navRect.right && rect.right > navRect.left;
        const insideY = rect.top < navRect.bottom && rect.bottom > navRect.top;
        if (insideX && insideY) {
          offenders.push((el.getAttribute("aria-label") || el.innerText || "").trim().slice(0, 40));
        }
      }
      return { ok: offenders.length === 0, offenders };
    });
    assert.equal(overlap.ok, true, `controls hidden behind the bottom nav: ${overlap.offenders.join(", ")}`);
  });

  test("the header is compact and shows the current screen", async () => {
    await page.setViewportSize({ width: 390, height: MOBILE_HEIGHT });
    await page.waitForTimeout(300);
    const header = await page.evaluate(() => {
      const el = document.querySelector(".mobile-header");
      const rect = el.getBoundingClientRect();
      return { height: Math.round(rect.height), sticky: getComputedStyle(el).position };
    });
    assert.ok(header.height <= 96, `mobile header is ${header.height}px tall`);
    assert.equal(header.sticky, "sticky");

    await openMobileTab(page, "Customers");
    const title = await page.locator(".mobile-brand small").innerText();
    assert.equal(title.trim(), "Customers");
  });

  test("navigation updates the URL hash and deep links restore the screen", async () => {
    await page.setViewportSize({ width: 390, height: MOBILE_HEIGHT });
    await openMobileTab(page, "Payments");
    assert.equal(await page.evaluate(() => window.location.hash), "#/payments");

    await openMobileTab(page, "Customers");
    assert.equal(await page.evaluate(() => window.location.hash), "#/customers");

    await page.goto(`${page.url().split("#")[0]}#/more`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const title = await page.locator(".mobile-brand small").innerText();
    assert.equal(title.trim(), "More", "a deep link must open the requested screen");
  });

  test("an unknown hash shows a helpful 404 page instead of a blank screen", async () => {
    await page.goto(`${page.url().split("#")[0]}#/not-a-real-tab`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    assert.equal(await page.locator(".not-found-code").innerText(), "404");
    assert.match(await page.locator(".not-found-card h1").innerText(), /could not find/i);
    await page.getByRole("button", { name: "Back to home" }).click();
    await page.waitForSelector(".mobile-app");
  });

  test("mobile controls are labelled and inputs use a readable font size", async () => {
    await page.setViewportSize({ width: 390, height: MOBILE_HEIGHT });
    await page.waitForTimeout(300);
    await assertAccessibleControls(page, "390 dashboard");
    await assertInputFontSizes(page, "390 dashboard");
    await openMobileTab(page, "Customers");
    await assertAccessibleControls(page, "390 customers");
    await assertTouchTargets(page, "390 customers");
  });

  test("every interactive control on the customer form meets the touch target minimum", async () => {
    await page.setViewportSize({ width: 320, height: MOBILE_HEIGHT });
    await page.waitForTimeout(300);
    await openMobileTab(page, "Customers");
    await page.locator(".mobile-screen-head .mobile-primary-button", { hasText: "Add" }).click();
    await page.waitForTimeout(400);
    await assertTouchTargets(page, "320 customer form");
    await assertInputFontSizes(page, "320 customer form");
    await assertAccessibleControls(page, "320 customer form");
    await page.getByRole("button", { name: "Close customer form" }).click();
  });

  test("the page produces no console, page or request errors", async () => {
    assertNoErrors(page, "mobile shell");
  });
});

describe("desktop shell", () => {
  let page;

  before(async () => {
    page = await newPage({ mobile: false, width: 1440, height: DESKTOP_HEIGHT });
    await login(page);
  });

  after(async () => {
    await closeBrowser();
  });

  test("keeps the approved desktop layout at every desktop width", async () => {
    for (const width of DESKTOP_WIDTHS) {
      await page.setViewportSize({ width, height: DESKTOP_HEIGHT });
      await page.waitForTimeout(400);
      const layout = await page.evaluate(() => {
        const aside = document.querySelector("aside");
        const main = document.querySelector("main");
        return {
          asideWidth: aside ? Math.round(aside.getBoundingClientRect().width) : null,
          mainMarginLeft: main ? getComputedStyle(main).marginLeft : null,
          hasMobileApp: Boolean(document.querySelector(".mobile-app")),
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      });
      assert.equal(layout.asideWidth, 240, `${width}: sidebar width changed`);
      assert.equal(layout.mainMarginLeft, "240px", `${width}: main offset changed`);
      assert.equal(layout.hasMobileApp, false, `${width}: mobile shell leaked into desktop`);
      assert.ok(layout.scrollWidth <= layout.innerWidth + 2, `${width}: horizontal overflow on desktop`);
    }
  });

  test("desktop screens remain accessible and free of console errors", async () => {
    await page.setViewportSize({ width: 1440, height: DESKTOP_HEIGHT });
    for (const label of ["Dashboard", "Customers", "Orders", "Finance", "Products"]) {
      await page.getByRole("button", { name: label, exact: true }).first().click();
      await page.waitForTimeout(800);
      await assertAccessibleControls(page, `desktop ${label}`);
      await assertNoHorizontalOverflow(page, `desktop ${label}`);
    }
    assertNoErrors(page, "desktop shell");
  });
});
