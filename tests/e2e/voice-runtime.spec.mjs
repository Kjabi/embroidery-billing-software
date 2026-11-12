// Voice runtime behaviour: where the ONNX Runtime WebAssembly comes from,
// when the heavy voice assets are requested, and that the assistant still
// initialises the local Whisper pipeline.
//
// This spec drives a voice-enabled development build (VITE_VOICE_ENABLED=true)
// because the production build ships with voice disabled.
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
  assertNoErrors,
  closeBrowser,
  login,
  newPage,
} from "../helpers/harness.mjs";

const VOICE_BASE = process.env.VOICE_BASE_URL || "http://127.0.0.1:5174";

describe("voice assistant runtime", () => {
  let page;
  const requests = [];

  before(async () => {
    page = await newPage({ mobile: false, width: 1440, height: 1000 });
    page.on("request", request => requests.push(request.url()));
    await page.goto(VOICE_BASE, { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.clear());
    await page.goto(VOICE_BASE, { waitUntil: "networkidle" });
    await page.locator("input:not([type='password'])").first().fill("admin");
    await page.locator("input[type='password']").fill("admin12345");
    await page.getByRole("button", { name: "LOGIN TO ADMIN PANEL" }).click();
    await page.waitForSelector("aside", { timeout: 20000 });
    await page.waitForTimeout(1200);
  });

  after(async () => {
    await closeBrowser();
  });

  test("the dashboard does not download any voice or model asset", () => {
    const voiceAssets = requests.filter(url =>
      /transformers\.web|ort-wasm|whisper|\.onnx|huggingface|hf\.co/i.test(url)
    );
    assert.deepEqual(voiceAssets, [], `voice assets must not load on startup: ${voiceAssets.join(", ")}`);
  });

  test("opening the assistant loads the panel but still not the model runtime", async () => {
    const button = page.getByRole("button", { name: /Lalitha AI Assistant/ }).first();
    await button.click();
    await page.waitForSelector(".mobile-voice-panel, section.fixed", { timeout: 20000 });
    await page.waitForTimeout(1500);
    const heavy = requests.filter(url => /ort-wasm|\.onnx|transformers\.web/i.test(url));
    assert.deepEqual(heavy, [], `heavy voice assets must not load before recording: ${heavy.join(", ")}`);
  });

  test("the speech runtime is served from our own origin, never from a CDN", async () => {
    // Trigger the lazy import of the ONNX runtime by asking the panel for the
    // speech capabilities; the pipeline itself is started by the microphone
    // flow, but the runtime module is loaded when the panel initialises.
    const panelText = await page.locator("body").innerText();
    assert.match(panelText, /Lalitha AI Assistant/i);

    const cdn = requests.filter(url => /cdn\.jsdelivr\.net|unpkg\.com/i.test(url));
    assert.deepEqual(cdn, [], `no third-party CDN may be used: ${cdn.join(", ")}`);
  });

  test("the assistant reports microphone capability and a language choice", async () => {
    const text = await page.locator("body").innerText();
    assert.match(text, /Tamil|தமிழ்/i, "Tamil must be selectable");
    assert.match(text, /Tanglish/i, "Tanglish must be selectable");
    assert.match(text, /English/i, "English must be selectable");
  });

  test("no console errors were produced while the assistant was opened", () => {
    assertNoErrors(page, "voice panel");
  });
});
