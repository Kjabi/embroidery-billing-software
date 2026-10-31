/**
 * Browser-local speech recognition for the admin voice assistant.
 *
 * Audio is captured with the Web Audio API, segmented by a small energy-based
 * VAD, resampled to 16 kHz in memory, and transcribed with a multilingual
 * Whisper model through Transformers.js.  Audio buffers and transcripts never
 * leave this browser process and are never written to Web Storage, IndexedDB,
 * analytics, or the backend.
 *
 * The model weights are downloaded on first use from the public Hugging Face
 * model repository and cached by the browser's Cache Storage.  The cache can
 * be removed from the assistant panel.
 */

export const TARGET_SAMPLE_RATE = 16000;
export const DEFAULT_MODEL = "onnx-community/whisper-base";
export const TAMIL_MODEL = "onnx-community/whisper-small";

// Whisper's multilingual checkpoints need an explicit language.  Leaving it
// unset makes Transformers.js fall back to English, which turns Tamil speech
// into unrelated English text.  The UI therefore asks the admin to choose the
// language once per conversation.
export const SPEECH_LANGUAGES = Object.freeze({
  en: { label: "English", code: "en", model: DEFAULT_MODEL, mixed: false },
  ta: { label: "தமிழ் (Tamil)", code: "ta", model: TAMIL_MODEL, mixed: false },
  mixed: { label: "Tanglish (mixed)", code: "ta", model: TAMIL_MODEL, mixed: true },
});

export function speechLanguage(key) {
  return SPEECH_LANGUAGES[key] || SPEECH_LANGUAGES.en;
}

let transformersPromise = null;
let pipelinePromise = null;
let loadedModelKey = "";
let loadedPipeline = null;

function transformersModule() {
  if (!transformersPromise) {
    transformersPromise = import("@huggingface/transformers");
  }
  return transformersPromise;
}

export function speechCapabilities() {
  if (typeof window === "undefined") {
    return {
      supported: false,
      reasons: ["Voice input is only available in a browser."],
      webgpu: false,
      memory: null,
      model: DEFAULT_MODEL,
    };
  }
  const media = Boolean(navigator.mediaDevices?.getUserMedia);
  const audioContext = Boolean(window.AudioContext || window.webkitAudioContext);
  const wasm = typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
  const secure = window.isSecureContext !== false;
  const memory = Number(navigator.deviceMemory || 0) || null;
  const reasons = [];
  if (!media) reasons.push("This browser cannot access a microphone.");
  if (!audioContext) reasons.push("This browser cannot process audio locally.");
  if (!wasm) reasons.push("WebAssembly is unavailable, so the local speech model cannot run.");
  if (!secure) reasons.push("Local microphone access requires HTTPS or localhost.");
  return {
    supported: reasons.length === 0,
    reasons,
    webgpu: Boolean(navigator.gpu),
    memory,
    model: DEFAULT_MODEL,
  };
}

export function rms(samples) {
  if (!samples?.length) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Linear-interpolation resampler.  The speech model expects 16 kHz mono PCM,
 * while a browser AudioContext commonly runs at 44.1 or 48 kHz.
 */
export function resampleTo16k(samples, sampleRate, targetRate = TARGET_SAMPLE_RATE) {
  if (!samples?.length) return new Float32Array(0);
  if (!sampleRate || sampleRate === targetRate) {
    return samples instanceof Float32Array ? samples : Float32Array.from(samples);
  }
  const ratio = sampleRate / targetRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const before = Math.floor(position);
    const after = Math.min(before + 1, samples.length - 1);
    const weight = position - before;
    output[index] = samples[before] * (1 - weight) + samples[after] * weight;
  }
  return output;
}

export function modelDisplayName(model) {
  return String(model || DEFAULT_MODEL).split("/").pop() || "Whisper";
}

function progressTracker(onProgress) {
  const files = new Map();
  return event => {
    if (!event) return;
    if (event.status === "progress" && event.file) {
      files.set(event.file, {
        loaded: Number(event.loaded || 0),
        total: Number(event.total || 0),
      });
      let loaded = 0;
      let total = 0;
      for (const item of files.values()) {
        loaded += item.loaded;
        total += item.total;
      }
      const percent = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : null;
      onProgress?.({
        phase: "download",
        percent,
        file: event.file,
        message: percent == null ? `Downloading ${event.file}` : `Downloading model ${percent}%`,
      });
    } else if (event.status === "done" && event.file) {
      onProgress?.({ phase: "download", percent: 100, file: event.file, message: "Model file ready" });
    } else if (event.status === "initiate") {
      onProgress?.({ phase: "load", percent: null, message: "Starting local speech model" });
    } else if (event.status === "ready") {
      onProgress?.({ phase: "ready", percent: 100, message: "Local speech model ready" });
    }
  };
}

export function modelOptions(language = "en") {
  const selected = speechLanguage(language);
  const env = import.meta.env || {};
  const model = selected.mixed
    ? env.VITE_VOICE_MODEL_TANGLISH || selected.model
    : selected.code === "ta"
      ? env.VITE_VOICE_MODEL_TA || selected.model
      : env.VITE_VOICE_MODEL_EN || selected.model;
  return {
    model,
    dtype: env.VITE_VOICE_MODEL_DTYPE || "q4",
    language: selected.code,
    label: selected.label,
  };
}

export async function loadLocalWhisper(onProgress, language = "en") {
  const { model, dtype } = modelOptions(language);
  if (loadedPipeline && loadedModelKey === `${model}:${dtype}`) {
    onProgress?.({ phase: "ready", percent: 100, message: "Local speech model ready" });
    return loadedPipeline;
  }
  if (pipelinePromise && loadedModelKey === `${model}:${dtype}`) return pipelinePromise;
  loadedModelKey = `${model}:${dtype}`;
  pipelinePromise = (async () => {
    const { pipeline, env } = await transformersModule();
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(2, navigator.hardwareConcurrency || 1));
    }
    const created = await pipeline("automatic-speech-recognition", model, {
      dtype,
      device: "wasm",
      progress_callback: progressTracker(onProgress),
    });
    loadedPipeline = created;
    return created;
  })().catch(error => {
    pipelinePromise = null;
    loadedModelKey = "";
    throw error;
  });
  return pipelinePromise;
}

export async function transcribeLocally(samples, { language = "en", onProgress } = {}) {
  if (!samples?.length) throw new Error("No speech was captured.");
  const selected = speechLanguage(language);
  const transcriber = await loadLocalWhisper(onProgress, language);
  const options = {
    task: "transcribe",
    language: selected.code,
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false,
  };
  const result = await transcriber(samples, options);
  const text = String(result?.text || "").trim();
  if (!text) throw new Error("I could not understand that recording. Please repeat it or type the command.");
  return text;
}

export async function clearModelCache() {
  loadedPipeline = null;
  pipelinePromise = null;
  loadedModelKey = "";
  if (typeof caches === "undefined") return false;
  const names = await caches.keys();
  const targets = names.filter(name => /transformers|huggingface|onnx|whisper/i.test(name));
  await Promise.all(targets.map(name => caches.delete(name)));
  return targets.length > 0;
}

export class SpeechSession {
  constructor({
    onSegment,
    onLevel,
    onSpeechStart,
    onError,
    onStateChange,
    silenceMs = 900,
    maxSegmentMs = 20000,
  } = {}) {
    this.onSegment = onSegment;
    this.onLevel = onLevel;
    this.onSpeechStart = onSpeechStart;
    this.onError = onError;
    this.onStateChange = onStateChange;
    this.silenceMs = silenceMs;
    this.maxSegmentMs = maxSegmentMs;
    this.stream = null;
    this.context = null;
    this.source = null;
    this.processor = null;
    this.mute = null;
    this.running = false;
    this.inSpeech = false;
    this.chunks = [];
    this.preRoll = [];
    this.speechSamples = 0;
    this.silenceSamples = 0;
    this.calibrationSamples = 0;
    this.noiseFloor = 0.006;
    this.sampleRate = 48000;
  }

  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot access a microphone. Type the command instead.");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Local audio processing is unavailable in this browser.");
    this.context = new AudioContextClass();
    await this.context.resume?.();
    this.sampleRate = this.context.sampleRate || 48000;
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(2048, 1, 1);
    this.mute = this.context.createGain();
    this.mute.gain.value = 0;
    this.processor.onaudioprocess = event => {
      if (!this.running) return;
      const channel = event.inputBuffer.getChannelData(0);
      this.handleFrame(Float32Array.from(channel));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.mute);
    this.mute.connect(this.context.destination);
    this.running = true;
    this.onStateChange?.("listening");
  }

  handleFrame(frame) {
    if (!frame?.length) return;
    const level = rms(frame);
    this.onLevel?.(level);
    const samplesPerMs = this.sampleRate / 1000;
    if (this.calibrationSamples < this.sampleRate * 0.4) {
      // Measure the room for a moment so Fan/AC noise is not mistaken for speech.
      this.calibrationSamples += frame.length;
      this.noiseFloor = this.noiseFloor * 0.8 + level * 0.2;
      this.preRoll.push(frame);
      this.trimPreRoll();
      return;
    }
    const threshold = Math.max(0.012, this.noiseFloor * 3.2);
    if (!this.inSpeech) {
      this.noiseFloor = this.noiseFloor * 0.995 + level * 0.005;
      this.preRoll.push(frame);
      this.trimPreRoll();
      if (level > threshold) {
        this.inSpeech = true;
        this.chunks = [...this.preRoll];
        this.silenceSamples = 0;
        this.speechSamples = this.preRoll.reduce((total, item) => total + item.length, 0);
        this.preRoll = [];
        this.onSpeechStart?.();
        this.onStateChange?.("hearing");
      }
      return;
    }
    this.chunks.push(frame);
    this.speechSamples += frame.length;
    if (level < threshold * 0.85) {
      this.silenceSamples += frame.length;
    } else {
      this.silenceSamples = 0;
    }
    const silenceLimit = (this.silenceMs / 1000) * this.sampleRate;
    const maxLimit = (this.maxSegmentMs / 1000) * this.sampleRate;
    if (
      (this.silenceSamples >= silenceLimit && this.speechSamples > samplesPerMs * 250) ||
      this.speechSamples >= maxLimit
    ) {
      this.finishSegment();
    }
  }

  trimPreRoll() {
    const maxSamples = Math.round(this.sampleRate * 0.35);
    let total = this.preRoll.reduce((sum, item) => sum + item.length, 0);
    while (this.preRoll.length && total > maxSamples) {
      total -= this.preRoll[0].length;
      this.preRoll.shift();
    }
  }

  finishSegment() {
    if (!this.inSpeech) return;
    const total = this.chunks.reduce((sum, item) => sum + item.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const segment = resampleTo16k(merged, this.sampleRate);
    this.inSpeech = false;
    this.chunks = [];
    this.preRoll = [];
    this.speechSamples = 0;
    this.silenceSamples = 0;
    this.noiseFloor = Math.max(0.003, this.noiseFloor);
    this.onStateChange?.("listening");
    if (segment.length >= TARGET_SAMPLE_RATE * 0.25) {
      try {
        this.onSegment?.(segment);
      } catch (error) {
        this.onError?.(error);
      }
    }
  }

  stop() {
    this.running = false;
    this.inSpeech = false;
    this.chunks = [];
    this.preRoll = [];
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
      this.mute?.disconnect();
    } catch {
      // Already disconnected.
    }
    this.stream?.getTracks?.().forEach(track => track.stop());
    this.context?.close?.().catch?.(() => {});
    this.stream = null;
    this.source = null;
    this.processor = null;
    this.mute = null;
    this.context = null;
    this.onStateChange?.("idle");
  }
}
