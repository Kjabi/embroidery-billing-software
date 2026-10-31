import React, { useEffect, useRef } from "react";
import { Bot, UserRound } from "lucide-react";

export default function VoiceTranscript({ messages = [], busy = false }) {
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [messages.length, busy]);

  return (
    <div className="mt-3 max-h-56 space-y-2 overflow-y-auto rounded-xl border border-slate-200 bg-white p-3 text-sm" aria-live="polite" aria-relevant="additions">
      {messages.length === 0 && (
        <p className="text-slate-500">
          Ask about live orders, payments, customers, or prepare an order. Nothing is saved until you review the preview and confirm.
        </p>
      )}
      {messages.map((message, index) => {
        const assistant = message.role === "assistant";
        return (
          <div
            key={`${index}-${message.role}`}
            className={`flex gap-2 rounded-lg px-2 py-1.5 ${assistant ? "bg-slate-50 text-slate-700" : "bg-indigo-50 text-indigo-900"}`}
          >
            <span className={`mt-0.5 shrink-0 ${assistant ? "text-slate-500" : "text-indigo-600"}`} aria-hidden="true">
              {assistant ? <Bot size={15} /> : <UserRound size={15} />}
            </span>
            <p className="whitespace-pre-wrap leading-5">{message.content}</p>
          </div>
        );
      })}
      {busy && (
        <p className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-slate-500">
          <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-500" />
          Working with live shop data…
        </p>
      )}
      <div ref={endRef} />
    </div>
  );
}
