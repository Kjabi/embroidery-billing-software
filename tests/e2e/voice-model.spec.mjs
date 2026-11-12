// Deep voice test: initialise the real Whisper pipeline in the browser so the
// ONNX Runtime WebAssembly binary and the model weights are actually fetched.
// This proves where the runtime comes from (our own origin vs a CDN) and that
// the assistant can initialise end to end.
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { chromium } from "playwright";

const VOICE_BASE = process.env.VOICE_BASE_URL || "http://127.0.0.1:5174";
const MODEL_TIMEOUT = Number(process.env.VOICE_MODEL_TIMEOUT || 420000);

describe("voice model initialisation", () => {
  let browser;
  let page;
  const requests = [];
  const failures = [];

  before(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      permissions: ["microphone"],
    });
    page = await context.newPage();
    page.on("request", request => requests.push(request.url()));
    page.on("requestfailed", request => failures.push(`${request.url()} :: ${request.failure()?.errorText}`));

    await page.goto(VOICE_BASE, { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.clear());
    await page.goto(VOICE_BASE, { waitUntil: "networkidle" });
    await page.locator("input:not([type='password'])").first().fill("admin");
    await page.locator("input[type='password']").fill("admin12345");
    await page.getByRole("button", { name: "LOGIN TO ADMIN PANEL" }).click();
    await page.waitForSelector("aside", { timeout: 20000 });
    await page.waitForTimeout(800);
  });

  after(async () => {
    if (browser) await browser.close();
  });

  test("the Whisper pipeline initialises and the runtime comes from our own origin", async () => {
    const result = await page.evaluate(async () => {
      const phases = [];
      try {
        const module = await import("/src/voice/browserSpeech.js");
        const pipeline = await module.loadLocalWhisper(
          event => phases.push(`${event.phase}:${event.percent ?? ""}`),
          "en"
        );
        return { ok: true, phases, hasPipeline: Boolean(pipeline) };
      } catch (error) {
        return { ok: false, error: String(error), phases };
      }
    }).catch(error => ({ ok: false, error: `evaluate failed: ${error}` }));

    assert.equal(result.ok, true, `pipeline failed to initialise: ${result.error}`);
    assert.equal(result.hasPipeline, true, "no pipeline was created");

    const wasm = requests.filter(url => /ort-wasm.*\.wasm/i.test(url));
    assert.ok(wasm.length > 0, "the ONNX Runtime WebAssembly binary was never requested");
    for (const url of wasm) {
      assert.ok(url.startsWith(VOICE_BASE) || url.startsWith("/"), `runtime must be same-origin: ${url}`);
    }

    // The ONNX Runtime binary must never come from a third-party code CDN.
    // The Whisper weights legitimately come from the Hugging Face hub (and its
    // own `*.hf.co` storage CDN), which the deployed CSP allows.
    const runtimeCdn = requests.filter(url =>
      /jsdelivr|unpkg\.com|cdnjs|cdn\.jsdelivr/i.test(url)
    );
    assert.deepEqual(runtimeCdn, [], `a runtime CDN was used: ${runtimeCdn.join(", ")}`);

    const model = requests.filter(url => /huggingface\.co|hf\.co/i.test(url));
    assert.ok(model.length > 0, "no model weight request was observed");
  });
});
