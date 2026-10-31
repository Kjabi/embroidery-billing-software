import assert from "node:assert/strict";
import test from "node:test";
import {
  modelDisplayName,
  modelOptions,
  resampleTo16k,
  rms,
  speechCapabilities,
  speechLanguage,
  TARGET_SAMPLE_RATE,
} from "./browserSpeech.js";

test("resampleTo16k halves a 32 kHz signal", () => {
  const source = new Float32Array(3200).fill(0.5);
  const output = resampleTo16k(source, 32000);
  assert.equal(output.length, 1600);
  assert.ok(output.every(value => Math.abs(value - 0.5) < 1e-6));
});

test("resampleTo16k keeps already-16 kHz audio untouched", () => {
  const source = new Float32Array([0.1, -0.2, 0.3]);
  const output = resampleTo16k(source, TARGET_SAMPLE_RATE);
  assert.equal(output.length, 3);
  assert.ok(Math.abs(output[1] + 0.2) < 1e-6);
});

test("rms reports silence and a known amplitude", () => {
  assert.equal(rms(new Float32Array([0, 0, 0])), 0);
  const value = rms(new Float32Array([0.5, -0.5, 0.5, -0.5]));
  assert.ok(Math.abs(value - 0.5) < 1e-6);
});

test("modelDisplayName is a safe short label", () => {
  assert.equal(modelDisplayName("onnx-community/whisper-base"), "whisper-base");
  assert.equal(modelDisplayName(""), "whisper-base");
});

test("speechLanguage defaults safely to English", () => {
  assert.equal(speechLanguage("unknown").code, "en");
  assert.equal(speechLanguage("ta").code, "ta");
  assert.equal(speechLanguage("mixed").code, "ta");
  assert.equal(speechLanguage("mixed").mixed, true);
});

test("Tamil and Tanglish select the multilingual small model", () => {
  assert.equal(modelOptions("en").model, "onnx-community/whisper-base");
  assert.equal(modelOptions("en").language, "en");
  assert.equal(modelOptions("ta").model, "onnx-community/whisper-small");
  assert.equal(modelOptions("ta").language, "ta");
  assert.equal(modelOptions("mixed").model, "onnx-community/whisper-small");
  assert.equal(modelOptions("mixed").language, "ta");
});

test("speechCapabilities fails closed outside a browser", () => {
  const capability = speechCapabilities();
  assert.equal(capability.supported, false);
  assert.ok(capability.reasons.length > 0);
});
