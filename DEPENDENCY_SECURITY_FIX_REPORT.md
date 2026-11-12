# DEPENDENCY SECURITY FIX REPORT

**Project:** Lalitha's Embroidery Management System
**Scope:** `frontend/package.json` + `frontend/package-lock.json`
**Audited:** 12 Nov 2026
**Baseline:** deployed commit `c0f1df2`
**Result:** **0 vulnerabilities (PASS)**

---

## 1. What was reported

Vercel reported *2 moderate, 1 high* on the deployed build. Re-running `npm audit` against the **committed** lockfile reproduced all three:

| Package | Severity | Installed | Direct? | Advisory |
|---|---|---|---|---|
| `vite` | **high** | 5.4.21 | yes (dev) | Path traversal in optimized-deps `.map` handling; `launch-editor` NTLMv2 hash disclosure, `escapeCmdArgs()` `%` omission, editor-flag misinterpretation, `fs.existsSync()` bypass; cross-origin script execution via custom middleware; `server.fs.allow` escape; `server.fs.deny` bypass on Windows alternate paths |
| `esbuild` | moderate | 0.21.x (via vite) | no | GHSA-67mh-4wv8-2f99 — any website can send requests to the dev server and read the response |
| `postcss-selector-parser` | moderate | 6.1.4 (via tailwind/postcss) | no | Quadratic-complexity selector parsing → CPU exhaustion |

Reference IDs: `GHSA-4w7w-66w2-5vf9`, `GHSA-v6wh-96g9-6wx3`, `GHSA-698v-4r3x-3vcv`, `GHSA-r825-w8mm-5pxw`, `GHSA-587h-7wmj-h5pm`, `GHSA-9jrq-w75r-8gcw`, `GHSA-rq7h-c2jc-7f22`, `GHSA-fx2h-pf6j-xcff`, `GHSA-67mh-4wv8-2f99`.

### Do they affect production?
- `vite`, `esbuild`, `launch-editor` are **dev/build-time only**. They are not shipped in `dist/`, so they cannot be exploited by a visitor of the deployed site. They *are* exploitable by anyone who can reach a running `vite dev` server (developer machine / CI), which is why they still matter.
- `postcss-selector-parser` runs at **build time** only (Tailwind/PostCSS). Same reasoning.

None of the three can read the database, the Supabase keys, or customer data in production.

---

## 2. Fix evaluated

`npm audit fix --force` proposed **vite 8.3.8** (a breaking major that replaces Rollup with Rolldown and requires `@vitejs/plugin-react` 6.x). That was rejected as the default because:

- it changes the bundler engine and the plugin contract in one step;
- the project's Vite config uses `loadEnv`, `defineConfig(({ command, mode }))` and a custom build guard — behaviour was not yet proven;
- the user's rules forbid blind `--force` upgrades.

### Version floor analysis
Advisory data shows **every** 5.x, 6.0–6.4.3 and 7.0–7.3.8 vite release is affected by at least one launch-editor advisory. The first fully patched lines are **vite ≥ 6.4.4** (Rollup retained) and **vite ≥ 8.3.3** (Rolldown).

### Trials (in throwaway copies, never in the repo)
| Candidate | Build | Unit tests | `npm audit` | Verdict |
|---|---|---|---|---|
| vite 8.3.8 + plugin-react 6.3.0 | PASS (Rolldown) | — | 0 | Works, but replaces the bundler and plugin major |
| **vite 6.4.6** (Rollup) | **PASS** | **51/51** | **0** | **Chosen** — smallest safe step |
| vite 6.4.6 dev server smoke | 200 + module 200 | — | 0 | PASS |

**Chosen change:** `vite ^5.4.8` → **`vite ^6.4.6`**, which also lifts `esbuild` to 0.25.12. `postcss-selector-parser` was already at the patched **6.1.6** in the working-tree lockfile (verified: `cssesc` no longer required).

Deliberately **not** changed: React 18.3.1, `@vitejs/plugin-react` 4.7.0, Tailwind 3.4, PostCSS 8.5, Recharts 2.15, `@huggingface/transformers` 4.3.2, `lucide-react` 0.446. No feature was removed to satisfy the audit.

---

## 3. Verification after the change

| Command | Result |
|---|---|
| `npm ci` | PASS (clean install from the new lockfile) |
| `npm test` | **51 passed, 0 failed** |
| `npm run build` | **PASS** (3.68 s) |
| `npm audit` | **found 0 vulnerabilities** |
| `npm ls` | no missing/invalid peers |

Installed versions after the fix:

```
vite                   6.4.6
esbuild                0.25.12
postcss-selector-parser 6.1.6
@vitejs/plugin-react   4.7.0
rollup                 4.64.9
```

`package-lock.json` is synchronized (committed entry `vite` 5.4.x replaced by 6.4.6; `esbuild` 0.21.x replaced by 0.25.12). Diff is confined to `frontend/package.json` (one line) and `frontend/package-lock.json`.

---

## 4. Remaining risk / notes

- The advisories are **dev-server** issues. Nobody can exploit them through the deployed static site; the residual exposure is a developer running `vite dev` on an untrusted network. Vite 6.4.6 also narrows `server.fs` handling.
- `npm audit` is a snapshot; new advisories can appear at any time. Re-run it in CI.
- The audit does **not** cover the Python backend. Backend dependency advisories (`starlette` via FastAPI) are tracked separately and were **not** changed here (requires FastAPI upgrade approval).
- No dependency was downgraded, removed, or suppressed. No `audit fix --force` was used.
