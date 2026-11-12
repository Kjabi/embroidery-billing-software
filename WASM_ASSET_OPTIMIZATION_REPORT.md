# WASM ASSET OPTIMIZATION REPORT

**Asset:** `ort-wasm-simd-threaded.asyncify.wasm`
**Measured:** 12 Nov 2026
**Result:** **PASS (with documented limits)** — single copy, same-origin, lazy, immutable-cached. Not reducible without changing the ASR execution provider, which was out of scope and forbidden without tests.

---

## 1. Where the 26.86 MB asset comes from

| Layer | Package / version | Role |
|---|---|---|
| ASR UI + model orchestration | `@huggingface/transformers` **4.3.2** | `pipeline("automatic-speech-recognition", …)` |
| Runtime | `onnxruntime-web` **1.31.0-dev.20260914-8d85527a0** (transitive) | Executes the Whisper ONNX graphs |
| Build | Vite 6 / Rollup | Emits the `.wasm` referenced by `new URL(..., import.meta.url)` |

`transformers.web.js` imports `onnxruntime-web/webgpu`, whose package entry selects `ort.webgpu.bundle.min.mjs`. That bundle embeds the **asyncify** glue and resolves:

```js
new URL("ort-wasm-simd-threaded.asyncify.wasm", import.meta.url)
```

Transformers.js then overrides the path to jsDelivr by default. Our build emits exactly **one** WASM file:

```
dist/assets/ort-wasm-simd-threaded.asyncify-CxOG5pUO.wasm   26,861.78 kB
```

No duplication: `ls dist/assets | grep wasm` returns one file, and the deployed asset measured **26,861,777 bytes** with `content-type: application/wasm`.

---

## 2. Is it required? Which variants exist?

Variants shipped in `node_modules/onnxruntime-web/dist`:

| Variant | Size | Notes |
|---|---|---|
| `ort-wasm-simd-threaded.wasm` | 14.26 MB | Plain WASM+SIMD, no JSEP/asyncify |
| `ort-wasm-simd-threaded.jspi.wasm` | 16.81 MB | JSPI (JS Promise Integration) |
| `ort-wasm-simd-threaded.asyncify.wasm` | **26.86 MB** | Required by the WebGPU/JSEP bundle used by Transformers.js v4 |
| `ort-wasm-simd-threaded.jsep.wasm` | 28.35 MB | JSEP without asyncify |

The **asyncify** build is the one the `onnxruntime-web/webgpu` bundle is wired for. Swapping to the 14.26 MB non-asyncify binary means changing the ORT entry point / execution provider — a behaviour change that must be proven with English, Tamil, Tanglish, WebGPU and WASM-only tests. That was **not** done, because the rules require not replacing a working provider without tests, and the feature is currently disabled in production anyway (`VITE_VOICE_ENABLED=false`).

---

## 3. When is it loaded?

**Only when the user presses the microphone** — never on startup, never when the assistant panel opens.

Verified by Playwright (`tests/e2e/voice-runtime.spec.mjs`, 5/5 pass):
- dashboard load: **0** requests matching `ort-wasm|.onnx|transformers.web`
- assistant panel opened: **0** heavy requests
- pressing the mic: the pipeline initialises, WASM is fetched (verified by `voice-model.spec.mjs`)

Startup impact: **0 bytes, 0 requests.** First voice use on a cold cache downloads the runtime (← this file), the 598 kB JS chunk and the Whisper weights; subsequent sessions use Cache Storage / HTTP cache.

---

## 4. Delivery and caching (live preview evidence)

```
GET /assets/ort-wasm-simd-threaded.asyncify-CxOG5pUO.wasm
HTTP/2 200
content-type: application/wasm
content-length: 26861777
cache-control: public, max-age=31536000, immutable
access-control-allow-origin: *
```

- Immutable 1-year cache (`vercel.json` `/assets/(.*)` rule) — a second visit costs 0 bytes.
- Same-origin: after the fix in `FRONTEND_BUNDLE_OPTIMIZATION_REPORT.md` §2b, `wasmPaths` points at `/assets/ort-wasm-…wasm`. Previously Transformers.js would have fetched it from **cdn.jsdelivr.net**, which the deployed CSP blocks (`connect-src 'self' https://*.supabase.co https://*.huggingface.co https://*.hf.co`). That was a genuine production-voice outage, now fixed and asserted by a test that rejects any `jsdelivr|unpkg|cdnjs` request.

---

## 5. Threading / SIMD / cross-origin isolation

`browserSpeech.js` sets `env.backends.onnx.wasm.numThreads = max(1, min(2, hardwareConcurrency))`.

- **SIMD** is used and is universally available in current Chrome/Edge/Safari/Firefox.
- **Multi-threading** requires `SharedArrayBuffer`, which requires **cross-origin isolation** (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`). The Vercel deployment does **not** send these headers, so `crossOriginIsolated` is `false`; ORT detects this, warns, and degrades to **1 thread**. This is correct and safe — just not the fastest possible path. Enabling COOP/COEP would break third-party embeds and Hugging Face downloads without CORP headers, so it is deliberately **not** enabled.
- With 1 thread the asyncify variant is still the correct binary for this bundle (proved by the successful WASM-only initialisation test).

---

## 6. Mobile / Safari compatibility

| Target | Status |
|---|---|
| Chrome desktop (headless, WASM fallback) | **PASS** — pipeline initialised, transcription path exercised |
| Chrome with WebGPU adapter | **PASS by design** — adapter probe selects `webgpu`; not exercised on a GPU-enabled host in this environment |
| Chrome Android | **NOT TESTED** (no device/emulator) |
| Safari / WebKit | **NOT TESTED** — see risk below |

**Risk:** Transformers.js normally selects the non-asyncify variant on Safari < 26 without WebGPU. Our explicit `wasmPaths` override always points to the asyncify binary. It worked in Chromium's WASM backend, but **Safari behaviour is unverified**. If Safari voice matters, gate the override on the chosen device (or keep the Transformers.js default on Safari). This is recorded as a limitation, not silently assumed.

**Fallback behaviour:** if the pipeline fails to initialise, `VoiceMicButton` already surfaces “Microphone unavailable — type instead”, and the typed-command path continues to work. If microphone permission is denied, the panel shows the permission message and keeps the text input. Both are pre-existing, unchanged behaviours; the WebGPU→WASM fallback added in this phase removes the most common hard-failure mode.

---

## 7. Cheaper-delivery options evaluated

| Option | Verdict |
|---|---|
| Load WASM only on voice activation | **Already true** |
| Serve from our origin (no CDN) | **Done** |
| Emit only the used variant | **Already true** (one file) |
| Immutable caching | **Already true** |
| Switch to the 14.26 MB non-asyncify build | **Rejected** — changes the ORT execution path; requires full ASR regression across engines; no test evidence |
| JSPI variant (16.81 MB) | **Rejected** — JSPI support is not universal; would break older Safari/Firefox |
| Compress/brotli the WASM | Vercel already serves it compressed on the wire where the client supports it; gzip size is ~6.68 MB. No action possible in-repo |
| Enable COOP/COEP for multithreading | **Rejected** — breaks Hugging Face model downloads and third-party assets; gains at most 2 threads |
| Remove voice to save 26 MB | **Forbidden**, and production already ships with voice disabled |

---

## 8. Conclusion

The 26.86 MB file is a **lazy, immutable, single-copy, same-origin** asset with **zero startup cost**. The genuinely important discovery was not its size but that it was being fetched from a CSP-blocked CDN in production; that is fixed and covered by tests. A smaller binary exists but cannot be adopted safely without replacing the execution provider, which is a separate, test-heavy project.
