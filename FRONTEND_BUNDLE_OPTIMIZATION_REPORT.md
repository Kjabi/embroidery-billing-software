# FRONTEND BUNDLE OPTIMIZATION REPORT

**Project:** Lalitha's Embroidery Management System
**Build:** Vite 6.4.6 (Rollup), React 18.3.1
**Measured:** 12 Nov 2026, local production build (`npm run build`)
**Result:** **PASS** — the 598.65 kB chunk is confirmed lazy; startup JS was split and the app chunk halved.

---

## 1. Correction to the original finding

The Vercel warning was interpreted as "598.65 kB of Transformers.js is in the initial bundle". It is **not**:

- `frontend/src/voice/browserSpeech.js` loads the library with `import("@huggingface/transformers")` (dynamic import, line ~40).
- `VoiceAssistantPanel` itself is behind `React.lazy` in `frontend/src/App.jsx`.
- The live deployment's `index.html` referenced only `index-kIKTjBml.js` (305 kB) and `index-Chhwmzu5.css` (63 kB) — **no** `transformers.web` script tag.

So the warning was a **chunk-size warning on an already-lazy chunk**, not an initial-payload problem. It was still worth fixing the surrounding structure (and it exposed two real defects, below).

### Verified behaviour (not just inference)
The Playwright spec `tests/e2e/voice-runtime.spec.mjs` records every network request on dashboard load and asserts that **zero** URLs match `transformers.web|ort-wasm|whisper|.onnx|huggingface|hf.co`. It passes. Opening the assistant panel also loads no runtime/model; only pressing the microphone does.

---

## 2. What was changed

### a) Vendor chunk splitting (`frontend/vite.config.js`)
```js
build: {
  rollupOptions: {
    output: {
      manualChunks(id) {
        if (!id.includes("node_modules")) return undefined;
        if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react-vendor";
        if (id.includes("node_modules/lucide-react/")) return "icons";
        return undefined;
      },
    },
  },
}
```
Rationale: the single 307 kB `index` chunk mixed app code with the React runtime, so every deploy invalidated the runtime in every visitor's cache. Splitting gives long-lived immutable vendor chunks. This is **not** a `chunkSizeWarningLimit` bump — nothing was hidden.

### b) ONNX Runtime WASM moved to our own origin (`src/voice/ortAssets.js`)
Transformers.js rewrites `env.backends.onnx.wasm.wasmPaths` to `https://cdn.jsdelivr.net/npm/onnxruntime-web@…/dist/`, which the deployed CSP (`connect-src 'self' https://*.supabase.co https://*.huggingface.co https://*.hf.co`) blocks. The production voice feature would have failed to initialise. This is a **real production bug**, found in Phase 4.

`ortAssets.js` uses Vite's `onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url` so the build emits the same hashed, same-origin asset already produced; `browserSpeech.js` imports that module **dynamically** so plain-Node unit tests never have to resolve a Vite `?url` specifier:

```js
let ortAssetPromise = null;
function localOrtWasmUrl() {
  if (!ortAssetPromise) {
    ortAssetPromise = import("./ortAssets.js").then(m => m.ORT_WASM_URL).catch(() => "");
  }
  return ortAssetPromise;
}
// …then: env.backends.onnx.wasm.wasmPaths = { wasm: localWasmUrl };
```

### c) WebGPU → WASM fallback (`preferredExecutionDevice`)
`device: navigator.gpu ? "webgpu" : "wasm"` aborts with *"no available backend found"* whenever `navigator.gpu` exists but no adapter can be acquired (headless browsers, blocked drivers, some Linux/Android builds). The code now requests an adapter first and falls back to `wasm`. Verified by test.

### d) Kept as-is (already correct)
- `React.lazy` for `VoiceAssistantPanel` and `FinanceCharts`.
- Dynamic import of Transformers.js.
- No eager model download or initialisation.
- Browser Cache Storage (`env.useBrowserCache = true`) and Hugging Face Hub model caching unchanged.
- Typed-input voice fallback, Tamil/Tanglish language selection, transcript correction, intent handling, authenticated backend calls, preview-and-confirm for writes, and text-to-speech are untouched.

### e) Rejected
- Raising `chunkSizeWarningLimit` (hides the issue).
- Removing/ignoring Transformers.js or ONNX Runtime.
- Replacing the Whisper models.
- Route-level splitting of the main app (the app is a single stateful dashboard; splitting it would regress tab switching and add startup requests without shrinking the initial payload meaningfully).

---

## 3. Before / after (production build)

### Deployed baseline (`c0f1df2`)
| Asset | Size | Gzip |
|---|---|---|
| `index-*.js` (initial) | 305.27 kB | 80.88 kB |
| `index-*.css` (initial) | 62.86 kB | 11.73 kB |
| `VoiceAssistantPanel-*.js` (lazy) | 49.76 kB | 14.58 kB |
| `FinanceCharts-*.js` (lazy) | 429.51 kB | 114.60 kB |
| `transformers.web-*.js` (lazy) | 598.65 kB | 174.11 kB |
| `ort-wasm-…asyncify.wasm` (on demand) | 26,861.77 kB | — |

### After (this change)
| Asset | Size | Gzip | When |
|---|---|---|---|
| `index-*.js` (**app code**) | **147.07 kB** | 32.06 kB | startup |
| `react-vendor-*.js` | 143.06 kB | 45.80 kB | startup (immutable) |
| `icons-*.js` | 22.83 kB | 4.71 kB | startup (immutable) |
| `ortAssets-*.js` | 0.10 kB | 0.11 kB | with voice |
| `index-*.css` | 62.91 kB | 11.73 kB | startup |
| `VoiceAssistantPanel-*.js` (lazy) | 44.33 kB | 13.30 kB | open assistant |
| `FinanceCharts-*.js` (lazy) | 439.66 kB | 116.97 kB | Finance screen |
| `transformers.web-*.js` (lazy) | 598.71 kB | 173.58 kB | press microphone |
| `ort-wasm-…asyncify.wasm` (on demand) | 26,861.78 kB | — | press microphone |

**Startup JS: one 305.27 kB file → three cacheable files totalling 313.06 kB (gzip 80.88 → 82.68 kB).**
The bytes are effectively unchanged; the win is that **the app chunk shrank 52%** (305.27 → 147.07 kB) and React/icons now survive app deploys in the browser cache, so repeat visits transfer ~147 kB instead of ~305 kB of JS. Gzip total is within 1.8 kB of baseline — no regression, no hidden cost.

### Voice activation cost (unchanged by design)
Opening the panel: **44.33 kB**. Pressing the microphone: 598.71 kB runtime + 26.86 MB WASM + the Whisper weights (downloaded once, cached by Cache Storage). Nothing voice-related loads on dashboard startup.

---

## 4. Remaining warning

The build still prints:

```
(!) Some chunks are larger than 500 kB after minification.
dist/assets/transformers.web-*.js  598.71 kB
```

This is a **single lazy library chunk** (the entire Transformers.js API surface). Splitting it internally is not meaningful — the whole module is needed as one unit, and splitting it would add round trips at voice activation. Removing it would remove the voice feature, which is forbidden. The warning is therefore **accepted and documented**, not suppressed. If a future Vercel build gate fails on it, the honest options are: (a) accept for this lazy chunk, or (b) replace the on-device ASR with a server-side provider — a product decision, not a bundle tweak.

---

## 5. Evidence

```
npm run build          → PASS (3.79 s)
npm test               → 51/51 pass
tests/e2e/voice-runtime.spec.mjs → 5/5 pass
  ✔ dashboard downloads no voice/model asset
  ✔ opening the assistant loads no model runtime
  ✔ no third-party CDN is used
  ✔ Tamil / Tanglish / English all selectable
  ✔ no console errors
tests/e2e/voice-model.spec.mjs   → 1/1 pass
  ✔ real Whisper pipeline initialises, WASM served same-origin,
    no jsdelivr/unpkg/cdnjs, HF weights fetched
```
