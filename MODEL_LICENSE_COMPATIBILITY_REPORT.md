# Model & Dependency License Compatibility Report

**Date:** 2026-11-07
**Scope:** every model, runtime and dependency this application uses or can optionally use, and whether it is compatible with a **₹0-recurring-cost, self-hosted / free-tier deployment**
**Production services activated:** none
**Status:** **PASS for the shipped runtime**, with **one unverified model-conversion licence** and one **GPL tool that is not installed**.

> This is an engineering licence inventory, not legal advice. Any model whose repository
> does not state a licence is treated as **UNVERIFIED** and must not be shipped until the owner
> confirms it.

## 1. Speech models

| Model | Where used | Declared licence | Source of evidence | Verdict |
|---|---|---|---|---|
| `onnx-community/whisper-base` | browser default (English) | **Apache-2.0** | Hugging Face API `cardData.license` = `apache-2.0` | PASS |
| `onnx-community/whisper-small` | browser Tamil/Tanglish | **not declared by the conversion repo** | HF API `cardData.license` = `null`; README has no licence field | **UNVERIFIED** |
| `openai/whisper-base` (upstream weights) | source of the ONNX conversion | **Apache-2.0** | HF API `cardData.license` = `apache-2.0` | PASS |
| `openai/whisper-small` (upstream weights) | source of the ONNX conversion | **Apache-2.0** | HF API `cardData.license` = `apache-2.0` | PASS |
| `ggml-base.bin` | backend whisper.cpp benchmark only | derived from OpenAI Whisper (Apache-2.0 weights) | local file; conversion format is not a separate licence | PASS for self-hosted use, keep attribution |
| `ggml-small.bin` | backend whisper.cpp benchmark only | derived from OpenAI Whisper (Apache-2.0 weights) | local file | PASS for self-hosted use, keep attribution |
| AI4Bharat IndicConformer (Hindi/Tamil/etc.) | **not integrated** — considered for Tamil | MIT (per project) | AI4Bharat project | PASS if adopted; different runtime required |
| AI4Bharat IndicParler-TTS | **not integrated** — considered for Tamil TTS | Apache-2.0 (per project) | AI4Bharat project | PASS if adopted; not benchmarked |

**Action required for `onnx-community/whisper-small`:** the conversion repository does not declare
a licence. Its upstream weights (`openai/whisper-small`) are Apache-2.0, and the conversion only
changes the serialization format, but that is an engineering inference, not a recorded grant.
Before relying on Tamil/Tanglish speech in production, either:

1. obtain a written confirmation from the repository owner, **or**
2. convert `openai/whisper-small` to ONNX yourself from the declared Apache-2.0 weights, **or**
3. switch the Tamil model to a repository that declares a licence.

Until then, Tamil/Tanglish speech is **UNVERIFIED** from a licensing standpoint. Typed input is
unaffected.

## 2. Speech runtimes and tooling

| Component | Version / role | Licence | Verdict |
|---|---|---|---|
| `faster-whisper` (Python) | backend STT | MIT | PASS |
| `ctranslate2` | faster-whisper backend | MIT | PASS |
| `onnxruntime` (Python) | ONNX inference | MIT | PASS |
| `onnxruntime-web` (frontend) | browser WASM inference | MIT | PASS |
| `@huggingface/transformers` (Transformers.js) | browser Whisper | Apache-2.0 | PASS |
| `tokenizers` (HF) | tokenization | Apache-2.0 | PASS |
| `huggingface_hub` | model download | Apache-2.0 | PASS |
| `numpy` | numeric runtime | BSD-3-Clause | PASS |
| whisper.cpp | benchmark / optional backend | MIT | PASS |
| Piper TTS (considered) | local TTS | MIT | PASS if adopted |
| Coqui TTS (considered, **not installed**) | local TTS | MPL-2.0 | PASS for the library, but see GPL note |
| Ollama (optional chat) | local LLM host | MIT | PASS |
| Groq API (optional chat) | external API | proprietary service | **NOT USED**; requires a zero-cost allowance and owner approval |

**GPL note:** `espeak-ng` is **GPL-3.0** and is commonly pulled in by Coqui TTS for
phonemization. It is **not installed** in this repository (`which espeak-ng` → none). If a TTS
path is added later, linking GPL-3.0 code into the distributed frontend or bundling it with a
proprietary build would impose GPL obligations. Any TTS plan must be reviewed before shipping.

## 3. Backend Python dependencies

Verified from installed package metadata / bundled licence files.

| Package | Version | Licence | Verdict |
|---|---|---|---|
| fastapi | 0.115.0 | MIT | PASS |
| starlette | 0.38.6 | BSD-3-Clause | PASS |
| uvicorn | 0.30.6 | BSD-3-Clause | PASS |
| sqlalchemy | 2.0.35 | MIT | PASS |
| pydantic | 2.x | MIT | PASS |
| python-multipart | 0.0.9 | Apache-2.0 | PASS |
| reportlab | 4.2.2 | BSD-3-Clause | PASS |
| Pillow | 13.0.0 | HPND (Pillow licence, MIT-like) — `LICENSE` file present | PASS |
| psycopg / psycopg-binary | 3.3.6 | LGPL-3.0 (per bundled `LICENSE.txt`) | PASS for dynamic linking / unmodified use |
| httpx | 0.27+ | BSD-3-Clause | PASS |
| certifi | 2026.10.18 | MPL-2.0 | PASS |
| pytest | 8.4.2 | MIT | PASS |

**psycopg (LGPL-3.0):** usable with a proprietary application as long as it is dynamically
linked and not modified. This app imports it normally; no source changes were made to psycopg.
Keep the licence notice in the dependency record.

**Pillow:** the installed distribution ships `pillow-13.0.0.dist-info/licenses/LICENSE`; the
project is HPND, MIT-compatible. Verified by file presence, not by a classifier.

## 4. Frontend dependencies

| Package | Version | Licence | Verdict |
|---|---|---|---|
| react / react-dom | 18.3.1 | MIT | PASS |
| vite | 5.4.x | MIT | PASS |
| @vitejs/plugin-react | 4.3.x | MIT | PASS |
| tailwindcss | 3.4.x | MIT | PASS |
| autoprefixer | 10.4.x | MIT | PASS |
| postcss | 8.4.x | MIT | PASS |
| recharts | 2.12.x | MIT | PASS |
| lucide-react | 0.446.x | ISC | PASS |
| @huggingface/transformers | 4.3.2 | Apache-2.0 | PASS |
| onnxruntime-web | 1.31.0-dev | MIT | PASS |

## 5. Assets and fonts

- `lalithas-apparel-logo.png` — business-owned asset; no third-party licence recorded. Confirm
  ownership before publishing.
- PDF invoices use ReportLab's built-in **Helvetica** base-14 font, which is metrically
  standard and does not require shipping a font file. No commercial font is bundled.
- No icon font is bundled; `lucide-react` is ISC and tree-shaken.

## 6. Compatibility with a ₹0 deployment

| Concern | Finding |
|---|---|
| Paid model APIs | None required. All speech paths default to local/browser inference. Groq is opt-in only. |
| Model download cost | Browser model files are fetched from Hugging Face's public CDN on first use — no charge, but requires network and browser cache; not a paid service. |
| Server model cost | `faster-whisper` downloads weights on first transcription; disk + CPU only. |
| Licence fees | None of the shipped components require a royalty. |
| GPL/AGPL contamination | No GPL/AGPL component is installed or bundled. `espeak-ng` is not present. |
| Attribution | Keep the MIT/Apache/BSD notices for bundled JS libraries in the deployment's notices file. Vite minifies but does not strip licence comments from `node_modules` unless configured to; add a `THIRD_PARTY_NOTICES` file at release. |

## 7. What remains unverified

- **`onnx-community/whisper-small` licence** — no declared licence (see §1). This is the only
  material licensing gap.
- Legal review of Apache-2.0 attribution obligations for the bundled browser model at
  distribution time.
- Whether the business owns the logo asset.
- Oracle / Cloudflare free-tier terms were not re-read for this report; the deployment plan must
  confirm that the chosen free tiers permit commercial use.
- No dependency was scanned with an automated licence scanner (e.g. `pip-licenses`); the table is
  from package metadata and bundled licence files.

## 8. Verdict

**Shipped runtime licences: PASS** (MIT/BSD/Apache-2.0/LGPL-dynamic/ISC/MPL-2.0, no GPL).
**Tamil/Tanglish browser model licence: UNVERIFIED** (`onnx-community/whisper-small`).
**Paid-licence dependency: none.**
