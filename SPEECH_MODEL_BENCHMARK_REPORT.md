# Speech Model Benchmark Report

**Date:** 2026-11-07
**Scope:** local Whisper speech-to-text quality, latency and memory for English, Tamil and Tanglish
**Hardware:** Apple MacBook Air M1 (`MacBookAir10,1`), 8 GB RAM, 8 cores, macOS 26.1;
whisper.cpp with the embedded Metal backend, 4 threads
**Models:** `ggml-base.bin` (142 MB) and `ggml-small.bin` (465 MB)
**Audio:** short synthetic test clips (1.3–3.1 s, 16 kHz mono WAV) in
`.runtime/speech-benchmark/audio/`
**Paid services used:** none
**Status:** English **PASS**; Tamil/Tanglish **PARTIAL**; spoken Tamil digits **FAIL/UNRELIABLE**.

## 1. Why this benchmark exists

The application offers three speech paths:

1. browser-local Whisper via Transformers.js (no audio leaves the browser),
2. backend faster-whisper / whisper.cpp (`VOICE_STT_PROVIDER`),
3. an optional Groq provider (requires an external API key; not exercised).

The browser bundle is currently blocked by a Cloudflare asset limit
(`PERFORMANCE_AUDIT_REPORT.md`). This report establishes what quality and cost to expect from a
local Whisper deployment so the owner can choose a real speech strategy rather than assume one.

## 2. Transcript quality

| Clip | Reference intent | `base` transcript | `small` transcript | Assessment |
|---|---|---|---|---|
| English sales | "what are today's sales?" | `what are today's sales?` | `What are today's sales?` | **Both correct** |
| Tamil sales | "இன்று எவ்வளவு sales?" | `இன்று விருப்பனையே வழவு.` | `இன்று விர்ப்பனை எவ்வளவு` | base wrong; small recognisable but misspelled / missing the English loanword |
| Tamil customer | "புதிய கஸ்டமர் சேர்க்க வேண்டும்" | `புதிய கஷ்டோமர் செரிக்க வேண்டும்.` | `புதிய காஸ்ட்டோமர் சேர்க்க வேண்டும்.` | base partly wrong; **small correct intent** |
| Tamil payment | "இந்த ஆர்டருக்கு 500 ரூபாய் payment திரும்பு" (approx.) | `இν்டாதுக்கு அண்ணுரு ஊருப்பாய் பேய்மன்று செய்விட்டு.` | `இந்த உதர்க்கு 500 ரூபாய் பேய்மன்த் திரும்பு` | both imperfect; **small preserves the digit `500`** |
| Tanglish sales | "இன்னைக்கு sales எவ்வளவு" | `இனைக்கும் செல்லாம்.` | `இன்னுக்கு சேல்ஸ் எவ்வளவு` | base wrong; **small correct** |

Key observations:

- English is reliable on both models.
- `base` is not usable for Tamil/Tanglish business commands.
- `small` is usable for *intent* on short phrases but produces spelling variants and drops/mangles
  some words.
- **Spoken Tamil number words are unreliable.** Digits that appear as English numerals survive
  better than Tamil number words. This is why the product must keep the typed fallback and the
  preview/confirmation step; never auto-save from audio alone.

## 3. Latency

| Clip | `base` total | `small` total | `base` RTF | `small` RTF |
|---|---|---|---|---|
| English sales (~1.53 s) | 1,206 ms | 4,195 ms | 0.79× | 2.74× |
| Tamil sales (~1.51 s) | 1,705 ms warm / 1,818 ms cold | 5,800 ms warm / 5,657 ms cold | ~1.13× | ~3.8× |
| Tamil customer (~1.84 s) | 2,388 ms | 6,500 ms | 1.30× | 3.53× |
| Tamil payment (~3.05 s) | 2,895 ms | 9,145 ms | 0.95× | 3.00× |
| Tanglish sales (~1.26 s) | 1,619 ms | 6,389 ms | 1.28× | 5.07× |

`small` is roughly **3–5× slower** than `base`. Model load time was 66–294 ms (`base`) and
166–348 ms (`small`) on this machine; Metal kernel compilation dominated the very first cold run
and is amortised afterwards.

**Critical caveat:** these numbers use Apple Silicon + Metal. On an Oracle Always Free Ampere
ARM64 CPU with no GPU, expect materially slower transcription. A 3-second Tamil utterance could
take well over 10 seconds on a small CPU VM. Do not quote these timings as server capacity.

## 4. Memory

| Model | Peak RSS |
|---|---|
| `base` | 339–386 MB |
| `small` | 767–886 MB |

`small` needs roughly **0.8–0.9 GB** at inference. Combined with the FastAPI process and
PostgreSQL client, this fits an 8 GB Mac but is a real constraint on a 1 GB / 6 GB free VM.
Concurrent transcription would multiply this; the app should transcribe one request at a time or
queue them.

## 5. Recommendations

1. **Use `small` (or larger) for Tamil/Tanglish**, never `base`.
2. **Keep English on `base`** for speed, or on the browser's native speech where available.
3. **Keep typed fallback and preview confirmation mandatory** — speech is an input convenience,
   not an authority. This is already implemented.
4. **Do not auto-save** from a transcript, especially for names, phone numbers, amounts and dates.
5. **Benchmark on the actual deployment hardware** before promising latency.
6. **Consider a Tamil-specific model** (e.g. AI4Bharat IndicConformer) only after a licence and
   runtime review; it is MIT but requires a different runtime and is not integrated.
7. **Do not enable the Groq provider** unless the owner approves an external API and its cost.

## 6. Limitations

- Only five short, synthetic clips were tested; no noisy shop environment, accents, or long
  sentences.
- `small` was run on M1 Metal; server CPU numbers are **NOT TESTED**.
- No word-error-rate corpus was scored; assessment is qualitative.
- Tamil TTS was not implemented or evaluated; human listening remains `NOT TESTED`.
- The browser Transformers.js path was not benchmarked end-to-end for accuracy on this hardware
  (the WASM bundle is currently blocked for Cloudflare deployment).

## 7. Verdict

- **English local STT: PASS** (both models, short clips).
- **Tamil/Tanglish intent recognition with `small`: PARTIAL PASS** (usable with confirmation).
- **Tamil/Tanglish with `base`: FAIL.**
- **Spoken Tamil digits: FAIL / unreliable.**
- **Server-side (Oracle ARM64 CPU) latency and memory: NOT TESTED.**
- **Tamil TTS: NOT IMPLEMENTED / NOT TESTED.**
