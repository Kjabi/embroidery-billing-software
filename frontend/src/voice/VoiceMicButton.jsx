import React, { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Play, StopCircle, Trash2 } from "lucide-react";
import {
  clearModelCache,
  loadLocalWhisper,
  modelDisplayName,
  modelOptions,
  SpeechSession,
  speechCapabilities,
  speechLanguage,
  SPEECH_LANGUAGES,
  transcribeLocally,
} from "./browserSpeech";

/**
 * Continuous, browser-local voice conversation control.
 *
 * The microphone stays open while the session is active.  A local VAD cuts
 * speech into short segments; each segment is transcribed in this browser by a
 * multilingual Whisper model.  No audio or transcript is sent to the backend or
 * persisted by this component.
 */
export default function VoiceMicButton({
  onTranscript,
  onError,
  onStatus,
  onSpeechStart,
  onEnd,
  language = "en",
  onLanguageChange,
  showLanguage = true,
  disabled = false,
  compact = false,
  label = "Start conversation",
}) {
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState("idle");
  const [progress, setProgress] = useState(null);
  const [level, setLevel] = useState(0);
  const [cacheNote, setCacheNote] = useState("");
  const [capabilities] = useState(() => speechCapabilities());
  const sessionRef = useRef(null);
  const queueRef = useRef([]);
  const processingRef = useRef(false);
  const activeRef = useRef(false);
  const aliveRef = useRef(true);
  const statusRef = useRef(onStatus);
  const errorRef = useRef(onError);
  const transcriptRef = useRef(onTranscript);
  const speechStartRef = useRef(onSpeechStart);
  const endRef = useRef(onEnd);
  const languageRef = useRef(language);

  useEffect(() => {
    statusRef.current = onStatus;
    errorRef.current = onError;
    transcriptRef.current = onTranscript;
    speechStartRef.current = onSpeechStart;
    endRef.current = onEnd;
    languageRef.current = language;
  }, [onStatus, onError, onTranscript, onSpeechStart, onEnd, language]);

  const report = (nextPhase, detail = "") => {
    if (!aliveRef.current) return;
    setPhase(nextPhase);
    statusRef.current?.(nextPhase, detail);
  };

  const processQueue = async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    while (queueRef.current.length) {
      const segment = queueRef.current.shift();
      if (!activeRef.current) break;
      const selected = speechLanguage(languageRef.current);
      report("transcribing", `Transcribing ${selected.label} locally…`);
      try {
        const text = await transcribeLocally(segment, { language: languageRef.current });
        if (text) await transcriptRef.current?.(text);
      } catch (error) {
        if (activeRef.current) {
          errorRef.current?.(error?.message || "The local speech model could not transcribe that.");
        }
      }
    }
    processingRef.current = false;
    if (activeRef.current) {
      const selected = speechLanguage(languageRef.current);
      report("listening", `Listening — ${selected.label}`);
    }
  };

  const start = async () => {
    if (disabled || active) return;
    if (!capabilities.supported) {
      errorRef.current?.(capabilities.reasons.join(" ") || "Voice input is unavailable in this browser.");
      return;
    }
    errorRef.current?.("");
    setCacheNote("");
    const selected = speechLanguage(languageRef.current);
    report("loading", `Loading the local ${selected.label} speech model…`);
    setProgress({ percent: null, message: `Loading the local ${selected.label} speech model…` });
    try {
      await loadLocalWhisper(event => {
        if (aliveRef.current) setProgress(event);
      }, languageRef.current);
      const session = new SpeechSession({
        onSegment: segment => {
          if (!activeRef.current) return;
          queueRef.current.push(segment);
          // Keep the queue bounded so an old utterance cannot be transcribed
          // long after the administrator has moved on.
          if (queueRef.current.length > 2) queueRef.current.shift();
          processQueue();
        },
        onLevel: value => {
          if (aliveRef.current) setLevel(Math.min(1, value * 22));
        },
        onSpeechStart: () => speechStartRef.current?.(),
        onError: error => errorRef.current?.(error?.message || "Voice capture failed."),
        onStateChange: state => {
          if (!activeRef.current) return;
          if (state === "listening" && !processingRef.current) {
            report("listening", `Listening — ${speechLanguage(languageRef.current).label}`);
          } else if (state === "hearing") {
            report("hearing", "Hearing you…");
          }
        },
      });
      sessionRef.current = session;
      await session.start();
      activeRef.current = true;
      setActive(true);
      report("listening", `Listening — ${speechLanguage(languageRef.current).label}`);
      setProgress(null);
    } catch (error) {
      sessionRef.current?.stop?.();
      sessionRef.current = null;
      activeRef.current = false;
      setActive(false);
      setProgress(null);
      report("error", error?.message || "Could not start the voice conversation.");
      errorRef.current?.(
        error?.name === "NotAllowedError"
          ? "Microphone permission was denied. Type the command instead."
          : error?.message || "Could not start the voice conversation. Type the command instead.",
      );
    }
  };

  const stop = () => {
    activeRef.current = false;
    queueRef.current = [];
    sessionRef.current?.stop?.();
    sessionRef.current = null;
    setActive(false);
    setLevel(0);
    report("idle", "Conversation ended. Start again when you are ready.");
    endRef.current?.();
  };

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      activeRef.current = false;
      sessionRef.current?.stop?.();
    };
  }, []);

  const removeCachedModel = async () => {
    if (active) return;
    try {
      const removed = await clearModelCache();
      setCacheNote(removed ? "Cached voice model removed." : "No cached voice model was found.");
    } catch {
      setCacheNote("The cached voice model could not be removed.");
    }
  };

  const busy = phase === "loading";
  const selectedLanguage = speechLanguage(language);
  const statusText = (() => {
    if (!capabilities.supported && phase === "idle") return capabilities.reasons[0];
    if (phase === "loading") {
      if (!progress) return `Loading the local ${selectedLanguage.label} speech model…`;
      return progress.percent == null
        ? progress.message || "Loading the local speech model…"
        : `${progress.message || "Downloading model"} (${progress.percent}%)`;
    }
    if (phase === "transcribing") return `Transcribing ${selectedLanguage.label} locally…`;
    if (phase === "hearing") return "Hearing you…";
    if (phase === "listening") return `Listening — ${selectedLanguage.label}`;
    if (phase === "error") return "Voice is unavailable — type instead";
    return cacheNote || "Voice runs only in this browser.";
  })();

  return (
    <div className={compact ? "flex flex-wrap items-center gap-2" : "space-y-2"}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={active ? stop : start}
          disabled={disabled || busy || (!capabilities.supported && !active)}
          aria-label={active ? "End voice conversation" : "Start voice conversation"}
          title={capabilities.supported ? label : capabilities.reasons.join(" ")}
          className={`inline-flex items-center justify-center gap-2 rounded-lg font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50 ${
            compact ? "px-2.5 py-2 text-xs" : "px-3 py-2 text-sm"
          } ${active ? "bg-rose-600 hover:bg-rose-700" : "bg-indigo-600 hover:bg-indigo-700"}`}
        >
          {busy ? (
            <Loader2 size={16} className="animate-spin" />
          ) : active ? (
            <StopCircle size={16} />
          ) : (
            <Play size={16} />
          )}
          {busy ? "Loading model…" : active ? "End conversation" : label}
        </button>
        {showLanguage && (
          <select
            value={language}
            onChange={event => onLanguageChange?.(event.target.value)}
            disabled={active || busy || disabled}
            aria-label="Voice language"
            title="Choose the language you will speak. Whisper needs an explicit language."
            className={`rounded-lg border border-slate-200 bg-white font-medium text-slate-700 disabled:opacity-60 ${
              compact ? "px-1.5 py-2 text-[11px]" : "px-2 py-2 text-xs"
            }`}
          >
            {Object.entries(SPEECH_LANGUAGES).map(([key, value]) => (
              <option key={key} value={key}>{value.label}</option>
            ))}
          </select>
        )}
        {!active && (
          <button
            type="button"
            onClick={removeCachedModel}
            disabled={disabled || busy}
            className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-50 disabled:opacity-50"
            title="Remove cached local speech model weights"
            aria-label="Remove cached speech model"
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>
      <div className={compact ? "flex items-center gap-2 text-[11px] text-slate-500" : "flex items-center gap-2 text-xs text-slate-600"}>
        {active ? (
          <span className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-rose-500" aria-hidden="true" />
        ) : (
          <Mic size={12} className="shrink-0 text-slate-400" />
        )}
        <span className="max-w-[28rem] truncate" aria-live="polite">
          {statusText}
        </span>
        {active && (
          <span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
            <span
              className="block h-full rounded-full bg-rose-500 transition-[width] duration-100"
              style={{ width: `${Math.max(6, Math.round(level * 100))}%` }}
            />
          </span>
        )}
        {!active && phase !== "loading" && (
          <span className="text-slate-400">· {modelDisplayName(modelOptions(language).model)}</span>
        )}
      </div>
    </div>
  );
}
