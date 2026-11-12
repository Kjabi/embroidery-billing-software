// Vite-only asset resolution for the ONNX Runtime Web WebAssembly binary.
//
// This module is imported dynamically by `browserSpeech.js` right before the
// speech pipeline is created, so:
//   * the production build resolves the `?url` import to the hashed,
//     same-origin asset that Vite already emits;
//   * plain-Node unit tests (which never start the voice runtime) do not have
//     to understand Vite's `?url` specifier.
//
// Keeping the WebAssembly on our own origin means the assistant does not need
// a third-party CDN at runtime, and the deployed Content-Security-Policy can
// stay strict.

import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";

export const ORT_WASM_URL = ortWasmUrl;
