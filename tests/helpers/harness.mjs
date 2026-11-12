// Shared harness for the Lalitha's Apparel end-to-end suite.
//
// The suite drives the real application against the real backend, so it
// verifies behaviour (not markup). Setup and teardown happen through the
// public API; the behaviour under test always happens through the UI.

import assert from "node:assert/strict";
import { chromium } from "playwright";

export const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:5173";
export const API_URL = process.env.API_URL || "http://127.0.0.1:8010/api";
export const ADMIN = {
  username: process.env.ADMIN_USERNAME || "admin",
  password: process.env.ADMIN_PASSWORD || "admin12345",
};

export const MOBILE_WIDTHS = [320, 360, 375, 390, 412, 430, 600];
export const DESKTOP_WIDTHS = [768, 1024, 1280, 1440];
export const ALL_WIDTHS = [...MOBILE_WIDTHS, ...DESKTOP_WIDTHS];

export const MOBILE_HEIGHT = 844;
export const DESKTOP_HEIGHT = 1000;

export const MIN_TOUCH_TARGET = 44;
export const MIN_INPUT_FONT = 16;

let browser = null;

export async function getBrowser() {
  if (!browser) browser = await chromium.launch({ headless: true });
  return browser;
}

export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/** Create a page with console/page/request error capture attached. */
export async function newPage({ mobile = true, width = 390, height = MOBILE_HEIGHT } = {}) {
  const context = await (await getBrowser()).newContext({
    viewport: { width, height },
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: mobile ? 2 : 1,
  });
  const page = await context.newPage();
  const errors = { console: [], page: [], requests: [] };
  page.on("console", message => {
    if (message.type() === "error") errors.console.push(message.text().slice(0, 300));
  });
  page.on("pageerror", error => errors.page.push(String(error).slice(0, 300)));
  page.on("requestfailed", request => {
    const failure = request.failure();
    if (failure && !request.url().includes("favicon") && !request.url().startsWith("blob:")) {
      errors.requests.push(`${request.method()} ${request.url()} :: ${failure.errorText}`);
    }
  });
  page.__errors = errors;
  return page;
}

export function assertNoErrors(page, label = "page") {
  const { console: consoleErrors, page: pageErrors, requests } = page.__errors;
  assert.deepEqual(consoleErrors, [], `${label}: console errors`);
  assert.deepEqual(pageErrors, [], `${label}: page errors`);
  assert.deepEqual(requests, [], `${label}: failed requests`);
}

/** Log in through the real login form. */
export async function login(page) {
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.locator("input:not([type='password'])").first().fill(ADMIN.username);
  await page.locator("input[type='password']").fill(ADMIN.password);
  await page.getByRole("button", { name: "LOGIN TO ADMIN PANEL" }).click();
  await page.waitForSelector(".mobile-app, aside", { timeout: 20000 });
  await page.waitForTimeout(600);
}

export async function logout(page) {
  await page.evaluate(() => localStorage.clear());
}

// ---------------------------------------------------------------------------
// API helpers (setup / teardown only - never the behaviour under test)
// ---------------------------------------------------------------------------
export async function apiToken() {
  const response = await fetch(`${API_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  if (!response.ok) throw new Error(`API login failed with ${response.status}`);
  const body = await response.json();
  return body.token;
}

export function apiClient(token) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  return {
    headers,
    async get(path) {
      const response = await fetch(`${API_URL}${path}`, { headers });
      const body = await response.json().catch(() => ({}));
      return { status: response.status, body };
    },
    async post(path, payload) {
      const response = await fetch(`${API_URL}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      return { status: response.status, body };
    },
    async put(path, payload) {
      const response = await fetch(`${API_URL}${path}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      return { status: response.status, body };
    },
    async delete(path) {
      const response = await fetch(`${API_URL}${path}`, { method: "DELETE", headers });
      const body = await response.json().catch(() => ({}));
      return { status: response.status, body };
    },
  };
}

let runCounter = 0;
export function uniqueName(prefix = "E2E") {
  runCounter += 1;
  return `${prefix} ${Date.now().toString(36)}${runCounter}`;
}

export function uniquePhone() {
  runCounter += 1;
  const digits = String(Date.now()).slice(-8);
  return `9${String(runCounter).padStart(1, "0")}${digits}`.slice(0, 10);
}

export async function seedCustomer(api, overrides = {}) {
  const payload = {
    name: uniqueName("E2E Customer"),
    phone: uniquePhone(),
    alternate_phone: "",
    address: "12 Temple Street",
    city: "Madurai",
    notes: "",
    ...overrides,
  };
  const { status, body } = await api.post("/customers", payload);
  assert.equal(status, 200, `seedCustomer failed: ${JSON.stringify(body)}`);
  return { ...body, ...payload };
}

export async function seedOrder(api, { customer_id, product_id, total_amount = 1500, paid_amount = 500, ...rest } = {}) {
  const token = await apiToken();
  const payload = {
    customer_id,
    product_id,
    order_date: rest.order_date || new Date().toISOString().slice(0, 10),
    delivery_date: rest.delivery_date || "",
    description: rest.description || "E2E seeded order",
    base_amount: total_amount,
    extra_amount: 0,
    total_amount,
    paid_amount,
    measurements: [],
    idempotency_key: `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ...rest,
  };
  const { status, body } = await api.post("/orders", payload);
  assert.equal(status, 200, `seedOrder failed: ${JSON.stringify(body)}`);
  return body;
}

export async function findProduct(api, predicate = () => true) {
  const { body } = await api.get("/products");
  const list = Array.isArray(body) ? body : (body.items || []);
  const found = list.find(predicate);
  assert.ok(found, "no product matched the predicate");
  return found;
}

export async function deleteCustomerIfExists(api, customer) {
  if (!customer?.id) return;
  await api.delete(`/customers/${customer.id}?cascade_orders=true`);
}

// ---------------------------------------------------------------------------
// UI assertions
// ---------------------------------------------------------------------------
export async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert.ok(
    metrics.scrollWidth <= metrics.innerWidth + 2,
    `${label}: horizontal overflow (scrollWidth ${metrics.scrollWidth} > innerWidth ${metrics.innerWidth})`
  );
}

export async function assertTouchTargets(page, label, min = MIN_TOUCH_TARGET) {
  const small = await page.evaluate((min) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    return Array.from(document.querySelectorAll("button, a[href], [role='button']"))
      .filter(visible)
      .map(el => {
        const rect = el.getBoundingClientRect();
        return {
          name: (el.getAttribute("aria-label") || el.innerText || el.textContent || "").trim().slice(0, 40),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter(box => box.height < min || box.width < min);
  }, min);
  assert.deepEqual(small, [], `${label}: touch targets smaller than ${min}px`);
}

export async function assertAccessibleControls(page, label) {
  const issues = await page.evaluate(() => {
    const accessibleName = (el) => {
      const aria = el.getAttribute("aria-label");
      if (aria && aria.trim()) return aria.trim();
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.innerText || "").join(" ").trim();
        if (text) return text;
      }
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label && label.innerText.trim()) return label.innerText.trim();
      }
      const wrapper = el.closest("label");
      if (wrapper && wrapper.innerText.trim()) return wrapper.innerText.trim();
      return (el.getAttribute("placeholder") || el.getAttribute("title") || el.innerText || el.value || "").trim();
    };
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const controls = Array.from(document.querySelectorAll("button, input, select, textarea, a[href]")).filter(visible);
    const unnamed = controls.filter(el => !accessibleName(el)).map(el => el.tagName.toLowerCase());
    const unlabeledInputs = Array.from(document.querySelectorAll("input, select, textarea"))
      .filter(visible)
      .filter(el => {
        if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) return false;
        if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return false;
        if (el.closest("label")) return false;
        return true;
      })
      .map(el => `${el.tagName.toLowerCase()}[${el.type || ""}]`);
    return { unnamed, unlabeledInputs };
  });
  assert.deepEqual(issues.unnamed, [], `${label}: controls without an accessible name`);
  assert.deepEqual(issues.unlabeledInputs, [], `${label}: inputs without a label`);
}

export async function assertInputFontSizes(page, label, min = MIN_INPUT_FONT) {
  const smallest = await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const sizes = Array.from(document.querySelectorAll("input, select, textarea"))
      .filter(visible)
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        size: parseFloat(getComputedStyle(el).fontSize),
      }));
    return sizes.length ? Math.min(...sizes.map(item => item.size)) : null;
  });
  if (smallest !== null) {
    assert.ok(smallest >= min, `${label}: smallest input font ${smallest}px is below ${min}px`);
  }
}

// ---------------------------------------------------------------------------
// Mobile navigation helpers
// ---------------------------------------------------------------------------
/** Reload the app so freshly created records are pulled into the client state. */
export async function reloadApp(page) {
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".mobile-app, aside", { timeout: 20000 });
  await page.waitForTimeout(900);
}

export async function openMobileTab(page, label) {
  await page.locator(".mobile-bottom-nav button", { hasText: label }).first().click();
  await page.waitForTimeout(700);
}

export async function openMobileSection(page, linkText) {
  await openMobileTab(page, "More");
  await page.locator(".mobile-link-list button", { hasText: linkText }).first().click();
  await page.waitForTimeout(800);
}

export async function confirmDialog(page, confirmLabel) {
  const dialog = page.locator('[role="alertdialog"]');
  await dialog.waitFor({ timeout: 8000 });
  await dialog.getByRole("button", { name: confirmLabel }).click();
}

/**
 * Close any sheet or dialog that a previous step may have left open, so one
 * failing assertion cannot cascade into unrelated tests.
 */
export async function closeAnyOverlay(page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const open = await page.locator(".mobile-sheet, .mobile-dialog, [role='alertdialog']").count();
    if (!open) return;
    const close = page.locator(
      ".mobile-sheet [aria-label^='Close'], .mobile-dialog [aria-label^='Close'], .mobile-dialog-actions button"
    ).first();
    if (await close.count()) {
      await close.click({ timeout: 3000 }).catch(() => {});
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
    await page.waitForTimeout(200);
  }
}
