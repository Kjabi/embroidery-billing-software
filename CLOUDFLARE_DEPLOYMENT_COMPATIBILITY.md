# Cloudflare Deployment Compatibility Report

**Date:** 2026-11-07
**Scope:** whether the current production frontend build can be deployed to Cloudflare Pages Free, and what the zero-cost alternatives are
**Deployment performed:** no. No Cloudflare account, token or project was used.
**Status:** **FAIL for Cloudflare Pages** — one build asset exceeds the 25 MiB per-file limit.
**Owner decision (2026-11-07): Option A — self-host the frontend on Oracle/Caddy.** Cloudflare
Pages is therefore **not used**. This report is retained as the evidence for that decision.

> This report replaces the earlier `CLOUDFLARE_COMPATIBILITY.md`, which is deleted in the
> working tree. It also corrects a false statement in `deploy/oracle-always-free.md`, which
> claimed the 26.9 MB WASM file was "well within per-file limits".

## 1. Cloudflare Pages Free limits that matter

Cloudflare's documented Pages limits (as of the 2026-11-07 check) are:

| Limit | Value |
|---|---|
| Maximum file size | **25 MiB = 26,214,400 bytes** |
| Maximum files per deployment | 20,000 |
| Builds per month (Free) | 500 |
| Build timeout | 20 minutes |
| Custom domain | free on `*.pages.dev`; custom domain allowed |
| Bandwidth | free / unlimited for static assets in practice |

The per-file limit is applied to the **built artifact as uploaded**, not to its gzip or
Brotli size. A file that compresses to 6.4 MB is still rejected if it is 25.61 MiB on disk.

## 2. Measured production build

Built with:

```bash
VITE_API_BASE_URL=https://api.example.com/api npm run build
```

`frontend/dist` is **27 MB** total and contains 8 files. Measured sizes:

| Asset | Bytes | MiB | Pages 25 MiB limit |
|---|---:|---:|---|
| `ort-wasm-simd-threaded.asyncify-CxOG5pUO.wasm` | **26,861,777** | **25.61** | **FAIL — over by 647,377 B (0.62 MiB)** |
| `transformers.web-aaseFeOZ.js` | 598,684 | 0.57 | PASS |
| `FinanceCharts-BmzAC9x2.js` | 429,518 | 0.41 | PASS |
| `index-CvXpj4jn.js` | 215,241 | 0.21 | PASS |
| `VoiceAssistantPanel-DxaqWqTr.js` | 49,066 | 0.05 | PASS |
| `index-BvFvRlOh.css` | 30,682 | 0.03 | PASS |

Every application bundle is small. **Exactly one asset — the ONNX Runtime WASM binary —
is over the limit.**

For reference, the other ONNX Runtime variants present in `node_modules/onnxruntime-web/dist`:

| Variant | Bytes | MiB | Under 25 MiB |
|---|---:|---:|---|
| `ort-wasm-simd-threaded.jsep.wasm` | 28,352,885 | 27.04 | no |
| `ort-wasm-simd-threaded.asyncify.wasm` | 26,861,777 | 25.61 | **no** |
| `ort-wasm-simd-threaded.jspi.wasm` | 16,811,691 | 16.03 | yes |
| `ort-wasm-simd-threaded.wasm` (plain, SIMD + threads) | 14,264,838 | 13.60 | yes |

Only the asyncify variant is emitted by the current Vite build, because the bundled
`transformers.web` code contains a static `new URL("/assets/ort-wasm-simd-threaded.asyncify-…wasm", import.meta.url)`
reference that Vite turns into a hashed asset.

## 3. Important nuance: which WASM is actually fetched at runtime?

This changes the fix, so it is recorded precisely.

Inside the bundled `transformers.web-*.js`, the ONNX Runtime environment is initialised as:

```js
if (!env.wasm.wasmPaths) {
  const base = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${versions.web}/dist/`;
  let suffix = ".asyncify";
  if (IS_SAFARI_BELOW_26 && !IS_WEBGPU_AVAILABLE) suffix = "";
  env.wasm.wasmPaths = {
    mjs:  `${base}ort-wasm-simd-threaded${suffix}.mjs`,
    wasm: `${base}ort-wasm-simd-threaded${suffix}.wasm`,
  };
}
```

`frontend/src/voice/browserSpeech.js` sets only `numThreads`; it does **not** set
`wasmPaths`. So the code path intends to load the WASM from the **jsDelivr CDN**, not from
the emitted local file. The local 26.86 MB file is a bundler side-effect that still has to
be uploaded and therefore still trips the Pages limit.

**NOT TESTED:** the actual network request in a real browser session. Loading the model
requires a user gesture (record) and a working microphone, which the automated browser
denies. This report therefore states the code-level behaviour and does not claim the
runtime fetch has been observed.

## 4. Options (none applied — owner decision required)

All options keep ₹0 recurring cost. They differ in architecture risk.

### Option A — Serve the frontend from the existing Oracle host (Caddy)

Serve `frontend/dist` from Caddy on the Oracle VM next to the API.

- **Pro:** no Cloudflare asset limit at all; one origin (simpler CORS); Caddy already
  provides TLS; no code change.
- **Con:** loses Cloudflare's global CDN (acceptable for one shop in Tamil Nadu);
  Oracle idle-reclamation and 10 TB/month egress still apply; the frontend now shares the
  VM's uptime with the API.
- **Code change:** none. Caddy adds a `file_server` for `/srv/app`.
- **Status:** viable, but not built or tested here (Docker daemon unavailable).

### Option B — Edge-host the WASM, keep Pages for the app (set `wasmPaths`)

Point `env.backends.onnx.wasm.wasmPaths` at a CDN/external URL and stop emitting the local
WASM into `dist`.

- **Pro:** keeps Cloudflare Pages + CDN for the app; explicit and testable; keeps the
  25 MiB rule satisfied because Pages no longer hosts the WASM.
- **Con:** adds a **runtime third-party dependency** (jsDelivr) or a second origin; the
  first speech attempt fails if that host is unreachable; needs a CSP update
  (`connect-src`/`script-src`).
- **Sub-options:**
  - B1: jsDelivr (zero cost, public, no SLA).
  - B2: Cloudflare R2 bucket with a custom domain (egress free, but needs a domain; the
    free `r2.dev` endpoint is rate-limited and documented as non-production).
  - B3: Oracle/Caddy static path (self-hosted, no third party; CORS headers required).
- **Code change:** set `wasmPaths` and exclude the local `.wasm` from the bundle. Small,
  but it changes runtime behaviour and must be browser-tested with a real microphone.
- **Status:** recommended direction, but **NOT IMPLEMENTED and NOT TESTED**.

### Option C — Force the plain `ort-wasm-simd-threaded.wasm` (14.26 MB)

- **Pro:** under the limit with no external host.
- **Con:** the asyncify build exists because some model operators need async WebAssembly.
  Forcing the plain build may break loading or inference. This is an assumption, not a
  tested fact.
- **Status:** **NOT TESTED — not recommended** without a full speech test.

### Option D — Use the JSPI variant (16.81 MB)

- **Pro:** under the limit.
- **Con:** JSPI (JavaScript Promise Integration) requires recent browsers (Chrome 137+,
  Edge, and only Safari 26+ / no WebGPU fallback). It would silently exclude older
  Android/desktop browsers used in a shop.
- **Status:** **NOT TESTED — not recommended** for broad compatibility.

### Option E — Remove browser speech recognition

Keep typed input and the optional server-side transcription endpoint.

- **Pro:** smallest bundle, no WASM, guaranteed Pages compatibility.
- **Con:** removes the local/private speech feature and changes the product. Requires an
  explicit owner decision.
- **Status:** fallback only.

## 5. Other Pages checks

| Check | Result |
|---|---|
| File count (8) vs 20,000 | PASS |
| App bundle sizes | PASS |
| `VITE_API_BASE_URL` required at build | PASS (build fails without it) |
| Secrets in build output | PASS — only public `VITE_` values; no service-role key |
| SPA rewrite (`/(.*)` → `index.html`) | provided by `vercel.json`; Pages needs a `_redirects` file or SPA setting — **not present** |
| `wrangler.toml` correctness | `pages_build_output_dir = "frontend/dist"` is set; the legacy `[site]` block is obsolete for Pages and should be removed |
| Custom domain / DNS | none configured |
| Build command in Pages | not configured; must be `cd frontend && npm ci && npm run build` with `VITE_API_BASE_URL` |

## 6. Verdict and decision

- **Current build on Cloudflare Pages Free: FAIL.**
  `ort-wasm-simd-threaded.asyncify-*.wasm` is 25.61 MiB, above the 25 MiB per-file limit.
- **Application bundles: PASS.**
- **Pages deployment: NOT PERFORMED and NOT PLANNED.** The owner selected Option A.
- **Decision implemented:** `deploy/Caddyfile.example` now serves the SPA from `/srv/app`
  and proxies `/api/*`; `deploy/docker-compose.yml` mounts `frontend/dist` read-only.
  The production build uses `VITE_API_BASE_URL=/api` and `VITE_VOICE_ENABLED=false`.
- **Still NOT TESTED:** an actual Oracle/Caddy deployment, TLS issuance, and a browser
  load of the self-hosted SPA. See `ORACLE_ALWAYS_FREE_REPORT.md` and
  `STAGING_DEPLOYMENT_REPORT.md`.
- **Voice:** disabled in this deployment. The 26.86 MB WASM remains in `dist` as a lazy
  chunk but is never fetched while the panel is hidden. Re-enable only after the physical
  microphone matrix passes.
