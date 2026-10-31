import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, ShieldCheck, X } from "lucide-react";
import VoiceMicButton from "./VoiceMicButton";
import { confirmationPhrase, pendingTitle, previewRows } from "./voiceLogic";

export default function VoiceConfirmationDialog({
  pending,
  busy = false,
  language = "en",
  onConfirm,
  onCancel,
  onClose,
}) {
  const [phrase, setPhrase] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [touched, setTouched] = useState(false);

  const suggested = useMemo(() => confirmationPhrase(pending), [pending]);
  const rows = useMemo(() => previewRows(pending), [pending]);
  const expiresAt = Number(pending?.expires_at || 0) * 1000;
  const secondsLeft = expiresAt ? Math.max(0, Math.floor((expiresAt - now) / 1000)) : 0;
  const expired = Boolean(expiresAt) && secondsLeft <= 0;

  useEffect(() => {
    setPhrase(suggested);
    setTouched(false);
  }, [suggested, pending?.confirmation_id]);

  useEffect(() => {
    if (!pending) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);

  if (!pending) return null;

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  const canConfirm = Boolean(phrase.trim()) && !busy && !expired;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-3 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="voice-confirm-title"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-amber-200 bg-white p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 rounded-full bg-amber-100 p-1.5 text-amber-700">
              <ShieldCheck size={18} />
            </span>
            <div>
              <h3 id="voice-confirm-title" className="text-base font-semibold text-slate-900">
                {pendingTitle(pending)}
              </h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Review the server preview carefully. Nothing has been saved yet.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-50"
            aria-label="Close confirmation preview"
          >
            <X size={17} />
          </button>
        </div>

        <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
          <dl className="divide-y divide-slate-200">
            {rows.map(row => (
              <div key={row.label} className="grid grid-cols-[9rem_1fr] gap-2 py-1.5 first:pt-0 last:pb-0">
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{row.label}</dt>
                <dd className="break-words text-slate-800">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <label className="mt-3 block text-xs font-semibold text-slate-700" htmlFor="voice-confirm-phrase">
          Confirmation phrase
        </label>
        <input
          id="voice-confirm-phrase"
          value={phrase}
          onChange={event => {
            setPhrase(event.target.value);
            setTouched(true);
          }}
          maxLength={240}
          autoComplete="off"
          className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${
            touched && phrase.trim() !== suggested.trim() ? "border-amber-400" : "border-slate-300"
          }`}
        />
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span>
            {touched && phrase.trim() !== suggested.trim()
              ? "Edited phrase — the server will verify it before saving."
              : "Say or type this phrase exactly, or use the microphone."}
          </span>
          <span className={`inline-flex items-center gap-1 font-medium ${expired ? "text-rose-700" : "text-slate-500"}`}>
            <Clock3 size={13} />
            {expired ? "Preview expired" : `${minutes}:${String(seconds).padStart(2, "0")} left`}
          </span>
        </div>

        {!expired && (
          <div className="mt-2">
            <VoiceMicButton
              compact
              language={language}
              showLanguage={false}
              label="Speak phrase"
              disabled={busy || expired}
              onTranscript={transcript => {
                setPhrase(transcript);
                setTouched(true);
              }}
              onError={() => {}}
            />
          </div>
        )}

        {expired && (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-rose-50 p-2.5 text-xs font-medium text-rose-700">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            This confirmation expired. Close it and ask again so the server can prepare a fresh preview.
          </p>
        )}

        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => onCancel?.("pending")}
            disabled={busy}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Discard preview
          </button>
          <button
            type="button"
            onClick={() => onConfirm?.(phrase.trim())}
            disabled={!canConfirm}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            ) : (
              <CheckCircle2 size={16} />
            )}
            Confirm and save
          </button>
        </div>
      </div>
    </div>
  );
}
