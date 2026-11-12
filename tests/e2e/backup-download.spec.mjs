// Backup Database: the button must produce an actual browser download of a
// valid, restorable SQLite file — not just a success message.
//
// This spec runs against the real backend and exercises the whole loop:
//   1. click "Backup database" in the mobile More screen,
//   2. click "Backup Database" in the desktop sidebar,
//   3. verify the downloaded bytes are a SQLite file containing the live data,
//   4. restore that exact downloaded file and prove the data round-trips.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { after, before, describe } from "node:test";
import {
  API_URL,
  apiClient,
  apiToken,
  closeBrowser,
  login,
  newPage,
  openMobileTab,
} from "../helpers/harness.mjs";

const execFileAsync = promisify(execFile);

describe("backup download", () => {
  let mobile;
  let desktop;
  let api;
  const downloads = [];
  const workDir = join(tmpdir(), `e2e-backup-${Date.now()}`);

  before(async () => {
    api = apiClient(await apiToken());
    mobile = await newPage({ mobile: true, width: 390, height: 844 });
    await login(mobile);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    await closeBrowser();
  });

  test("the mobile More screen downloads a backup file when clicked", async () => {
    await openMobileTab(mobile, "More");
    const button = mobile.locator(".mobile-link-list button", { hasText: "Backup database" });
    await button.waitFor({ timeout: 8000 });

    const downloadPromise = mobile.waitForEvent("download", { timeout: 30000 });
    await button.click();
    const download = await downloadPromise;
    const path = join(workDir, "mobile-backup.db");
    await download.saveAs(path);
    downloads.push({ origin: "mobile", path, filename: download.suggestedFilename() });

    assert.match(
      download.suggestedFilename(),
      /^embroidery_backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/,
      `unexpected backup filename: ${download.suggestedFilename()}`
    );

    // Success is announced only after the download has been initiated.
    await mobile.locator(".mobile-toast", { hasText: "Backup downloaded" }).waitFor({ timeout: 8000 });
  });

  test("the desktop sidebar button downloads the backup the same way", async () => {
    desktop = await newPage({ mobile: false, width: 1440, height: 1000 });
    await login(desktop);
    const button = desktop.locator("aside .sidebar-actions button", { hasText: "Backup Database" });
    await button.waitFor({ timeout: 8000 });

    const downloadPromise = desktop.waitForEvent("download", { timeout: 30000 });
    await button.click();
    const download = await downloadPromise;
    const path = join(workDir, "desktop-backup.db");
    await download.saveAs(path);
    downloads.push({ origin: "desktop", path, filename: download.suggestedFilename() });

    assert.match(
      download.suggestedFilename(),
      /^embroidery_backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/,
      `unexpected backup filename: ${download.suggestedFilename()}`
    );
    await desktop.locator(".mobile-toast", { hasText: "Backup downloaded" }).waitFor({ timeout: 8000 });
  });

  test("the downloaded file is a valid SQLite database holding the live data", async () => {
    assert.ok(downloads.length >= 1, "no download was captured");
    for (const download of downloads) {
      const bytes = await readFile(download.path);
      assert.ok(bytes.length > 4096, `backup looks too small (${bytes.length} bytes)`);
      assert.equal(bytes.subarray(0, 16).toString("latin1"), "SQLite format 3\x00");

      // If the sqlite3 CLI is available, verify integrity and required tables.
      try {
        const { stdout } = await execFileAsync("sqlite3", [download.path, "PRAGMA integrity_check;"]);
        assert.equal(stdout.trim(), "ok", `${download.origin} backup failed integrity_check`);
        const tables = await execFileAsync("sqlite3", [
          download.path,
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
        ]);
        const names = tables.stdout.split("\n").map(line => line.trim());
        for (const required of ["customers", "orders", "products", "transactions"]) {
          assert.ok(names.includes(required), `${download.origin} backup is missing table ${required}`);
        }
      } catch (error) {
        if (/ENOENT/.test(String(error))) continue; // sqlite3 CLI not installed; magic bytes already checked
        throw error;
      }
    }
  });

  test("the exact downloaded file restores the database (round trip)", async () => {
    const artifact = downloads.find(item => item.origin === "desktop") || downloads[0];
    const baseline = await listCustomerNames();
    assert.ok(baseline.size > 0, "no customers existed to prove a round trip");

    const fileBytes = await readFile(artifact.path);
    const response = await fetch(`${API_URL}/restore`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await apiToken()}` },
      body: (() => {
        const form = new FormData();
        form.append("file", new Blob([fileBytes], { type: "application/octet-stream" }), artifact.filename);
        return form;
      })(),
    });
    const result = await response.json().catch(() => ({}));
    assert.equal(response.status, 200, `restore failed: ${JSON.stringify(result)}`);
    assert.ok(result.restored_counts.customers >= baseline.size, "restore reported too few customers");

    const after = await listCustomerNames();
    for (const name of baseline) {
      assert.ok(after.has(name), `customer "${name}" was lost by the restore`);
    }
  });
  test("the app still works after the restore", async () => {
    await login(mobile);
    await openMobileTab(mobile, "Customers");
    const cards = await mobile.locator(".mobile-customer-card").count();
    assert.ok(cards > 0, "the customer directory is empty after the restore");
  });

  test("no unexpected console or page errors occurred", () => {
    const unexpected = mobile.__errors.console.filter(text =>
      !/Failed to load resource|net::ERR_FAILED|401/i.test(text)
    );
    assert.deepEqual(unexpected, [], `unexpected console errors: ${unexpected.slice(0, 3).join(" | ")}`);
    assert.deepEqual(mobile.__errors.page, [], "page errors during the backup flow");
    assert.deepEqual(mobile.__errors.requests, [], "failed requests during the backup flow");
  });

  async function listCustomerNames() {
    const { status, body } = await api.get("/customers?limit=250");
    assert.equal(status, 200);
    const items = Array.isArray(body) ? body : (body.items || []);
    return new Set(items.map(item => item.name));
  }
});
