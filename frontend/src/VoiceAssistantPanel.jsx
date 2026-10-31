import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Eraser,
  Send,
  ShieldCheck,
  Volume2,
  VolumeX,
} from "lucide-react";
import VoiceConfirmationDialog from "./voice/VoiceConfirmationDialog";
import VoiceDraftEditor from "./voice/VoiceDraftEditor";
import VoiceMicButton from "./voice/VoiceMicButton";
import VoiceTaskCard from "./voice/VoiceTaskCard";
import VoiceTranscript from "./voice/VoiceTranscript";
import {
  draftFromState,
  parseApiError,
  pendingTitle,
  previewRows,
  speechLanguage,
} from "./voice/voiceLogic";

const PROVIDER_LABELS = {
  deterministic: "Built-in command parser",
  groq: "Groq (configured)",
  ollama: "Ollama (local)",
};

export default function VoiceAssistantPanel({ apiFetch, apiBase, onOpenInvoice, onDataChanged }) {
  const [messages, setMessages] = useState([]);
  const [task, setTask] = useState(null);
  const [pending, setPending] = useState(null);
  const [provider, setProvider] = useState("");
  const [warnings, setWarnings] = useState([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [speak, setSpeak] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState({ phase: "idle", detail: "" });
  const [editorOpen, setEditorOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [voiceLanguage, setVoiceLanguage] = useState(() => {
    try {
      const saved = window.localStorage.getItem("emb_voice_language");
      return saved === "ta" || saved === "mixed" ? saved : "en";
    } catch {
      return "en";
    }
  });
  const aliveRef = useRef(true);
  const speakRef = useRef(speak);

  const changeVoiceLanguage = (key) => {
    if (!["en", "ta", "mixed"].includes(key)) return;
    setVoiceLanguage(key);
    try {
      // A language preference is not conversation content. Transcripts,
      // audio, drafts, and business data are never written to storage.
      window.localStorage.setItem("emb_voice_language", key);
    } catch {
      // Storage may be unavailable in private mode; the in-memory choice still works.
    }
  };

  useEffect(() => {
    speakRef.current = speak;
    if (!speak) {
      window.speechSynthesis?.cancel();
      setSpeaking(false);
    }
  }, [speak]);

  const stopSpeaking = () => {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  };

  const speakText = (value) => {
    if (!speakRef.current || !value || !("speechSynthesis" in window)) return;
    const utterance = new SpeechSynthesisUtterance(String(value));
    utterance.lang = speechLanguage(value);
    utterance.rate = 0.98;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.cancel();
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  const applyPayload = (payload, { speakReply = true } = {}) => {
    if (!aliveRef.current) return;
    setMessages(payload.messages || []);
    setTask(payload.task || null);
    setPending(payload.pending_operation || null);
    setProvider(payload.provider || "");
    setWarnings(payload.warnings || []);
    if (speakReply && payload.reply) speakText(payload.reply);
  };

  const request = async (path, options = {}) => {
    const response = await apiFetch(`${apiBase}${path}`, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(parseApiError(payload));
    return payload;
  };

  const jsonOptions = (method, body) => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  useEffect(() => {
    aliveRef.current = true;
    (async () => {
      try {
        const payload = await request("/voice/session");
        applyPayload(payload, { speakReply: false });
      } catch (err) {
        if (aliveRef.current) setError(err.message || "The voice session could not be loaded.");
      }
    })();
    return () => {
      aliveRef.current = false;
      window.speechSynthesis?.cancel();
    };
    // The session is loaded once for this authenticated panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmPending = async (confirmationId, phrase) => {
    const payload = await request(
      "/voice/confirm",
      jsonOptions("POST", { confirmation_id: confirmationId, confirmation_phrase: phrase }),
    );
    applyPayload(payload);
    onDataChanged?.();
    return payload;
  };

  const submitTurn = async (value = text) => {
    const clean = String(value || "").trim();
    if (!clean || busy) return;
    setBusy(true);
    setError("");
    try {
      const payload = await request("/voice/turn", jsonOptions("POST", { text: clean }));
      applyPayload(payload);
      if (payload.ui_action?.type === "confirm_pending") {
        await confirmPending(
          payload.ui_action.confirmation_id,
          payload.ui_action.confirmation_phrase,
        );
      } else if (payload.ui_action?.type === "open_invoice") {
        onOpenInvoice?.(payload.ui_action.order_id);
      }
      setText("");
    } catch (err) {
      setError(err.message || "The voice command could not be completed.");
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const confirmFromDialog = async (phrase) => {
    if (!pending || busy) return;
    setBusy(true);
    setError("");
    try {
      await confirmPending(pending.confirmation_id, phrase);
      setDialogOpen(false);
    } catch (err) {
      setError(err.message || "The confirmation could not be completed.");
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const cancelOperation = async (scope) => {
    setBusy(true);
    setError("");
    try {
      const payload = await request("/voice/cancel", jsonOptions("POST", { scope }));
      applyPayload(payload);
      if (scope === "pending") setDialogOpen(false);
      else setEditorOpen(false);
    } catch (err) {
      setError(err.message || "The operation could not be cancelled.");
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const saveDraft = async (patch) => {
    setBusy(true);
    setError("");
    try {
      const payload = await request("/voice/draft", jsonOptions("PATCH", patch));
      applyPayload(payload);
      setEditorOpen(false);
    } catch (err) {
      setError(err.message || "The draft could not be updated.");
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const clearConversation = async () => {
    if (busy) return;
    const confirmed = window.confirm(
      "Clear this conversation? Drafts and previews in the assistant will be discarded. No saved business record is changed.",
    );
    if (!confirmed) return;
    setBusy(true);
    setError("");
    stopSpeaking();
    try {
      await request("/voice/session", { method: "DELETE" });
      setMessages([]);
      setTask(null);
      setPending(null);
      setWarnings([]);
      setProvider("");
      setText("");
      setEditorOpen(false);
      setDialogOpen(false);
    } catch (err) {
      setError(err.message || "The conversation could not be cleared.");
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const endVoiceConversation = async () => {
    stopSpeaking();
    setError("");
    try {
      await request("/voice/session", { method: "DELETE" });
    } catch {
      // The local panel is still cleared; the backend copy expires on its own.
    }
    setMessages([]);
    setTask(null);
    setPending(null);
    setWarnings([]);
    setProvider("");
    setText("");
    setEditorOpen(false);
    setDialogOpen(false);
    setVoiceStatus({ phase: "idle", detail: "" });
  };

  const draft = useMemo(() => draftFromState(task, pending), [task, pending]);
  const compactPreview = useMemo(() => previewRows(pending).slice(0, 3), [pending]);
  const providerLabel = PROVIDER_LABELS[provider] || provider;

  return (
    <section className="mb-6 rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4 text-slate-900 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <ShieldCheck size={18} className="text-indigo-600" />
            Voice assistant
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Ask about live orders and payments, or prepare a change. Writes are saved only after a preview and an
            explicit confirmation.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setSpeak(current => !current)}
            className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50"
            title={speak ? "Stop spoken replies" : "Speak replies aloud"}
            aria-pressed={speak}
          >
            {speak ? <Volume2 size={17} /> : <VolumeX size={17} />}
          </button>
          <button
            type="button"
            onClick={clearConversation}
            disabled={busy || (!messages.length && !task && !pending)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            title="Clear this temporary conversation"
          >
            <Eraser size={15} /> Clear
          </button>
          <VoiceMicButton
            disabled={busy}
            language={voiceLanguage}
            onLanguageChange={changeVoiceLanguage}
            onTranscript={transcript => submitTurn(transcript)}
            onError={message => setError(message)}
            onStatus={(phase, detail) => setVoiceStatus({ phase, detail })}
            onSpeechStart={stopSpeaking}
            onEnd={endVoiceConversation}
          />
        </div>
      </div>

      {providerLabel && (
        <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">
          Answers from {providerLabel}
          {speaking && <span className="ml-2 normal-case text-emerald-600">· speaking reply — start talking to interrupt</span>}
        </p>
      )}

      {voiceStatus.phase !== "idle" && voiceStatus.detail && (
        <p className="mt-1 text-[11px] text-slate-500" aria-live="polite">
          Voice input: {voiceStatus.detail}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg bg-rose-50 p-2.5 text-sm text-rose-700">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      {warnings.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800">
          {warnings.map((warning, index) => (
            <li key={`${index}-${warning}`} className="flex items-start gap-1.5">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {warning}
            </li>
          ))}
        </ul>
      )}

      <VoiceTranscript messages={messages} busy={busy} />

      <VoiceTaskCard
        task={task}
        busy={busy}
        onEdit={() => setEditorOpen(true)}
        onCancel={() => cancelOperation("draft")}
      />

      {editorOpen && task?.draft && (
        <VoiceDraftEditor
          draft={draft}
          busy={busy}
          onSave={saveDraft}
          onClose={() => setEditorOpen(false)}
        />
      )}

      {pending && (
        <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-semibold text-amber-900">{pendingTitle(pending)}</p>
              <p className="mt-0.5 text-xs text-amber-800">
                Nothing has been saved. Review the server preview and confirm explicitly.
              </p>
              <dl className="mt-2 space-y-0.5 text-xs text-amber-900">
                {compactPreview.map(row => (
                  <div key={row.label} className="flex gap-2">
                    <dt className="min-w-20 font-medium">{row.label}:</dt>
                    <dd className="truncate">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="flex flex-wrap gap-2">
              {task?.draft && (
                <button
                  type="button"
                  onClick={() => setEditorOpen(true)}
                  disabled={busy}
                  className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                >
                  Edit draft
                </button>
              )}
              <button
                type="button"
                onClick={() => setDialogOpen(true)}
                disabled={busy}
                className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Review &amp; confirm
              </button>
              <button
                type="button"
                onClick={() => cancelOperation("pending")}
                disabled={busy}
                className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}

      <form
        className="mt-3 flex gap-2"
        onSubmit={event => {
          event.preventDefault();
          submitTurn();
        }}
      >
        <input
          value={text}
          onChange={event => setText(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          placeholder="Type a command, for example: How much was collected today?"
          maxLength={1200}
          disabled={busy}
          aria-label="Voice assistant command"
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="rounded-lg bg-slate-900 px-3 py-2 text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Send command"
        >
          <Send size={17} />
        </button>
      </form>

      <VoiceConfirmationDialog
        pending={dialogOpen ? pending : null}
        busy={busy}
        language={voiceLanguage}
        onConfirm={confirmFromDialog}
        onCancel={cancelOperation}
        onClose={() => setDialogOpen(false)}
      />
    </section>
  );
}
