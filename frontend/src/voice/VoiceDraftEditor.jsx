import React, { useEffect, useState } from "react";
import { Save, X } from "lucide-react";
import { buildDraftPatch } from "./voiceLogic";

export default function VoiceDraftEditor({ draft, busy, onSave, onClose }) {
  const [form, setForm] = useState({ measurements: {} });
  const [error, setError] = useState("");

  useEffect(() => {
    setForm({
      customer_name: draft?.customer_name || "",
      product_name: draft?.product_name || "",
      measurements: { ...(draft?.measurements || {}) },
      total_amount: draft?.total_amount ?? "",
      paid_amount: draft?.paid_amount ?? 0,
      extra_amount: draft?.extra_amount ?? 0,
      delivery_date: draft?.delivery_date || "",
      description: draft?.description || "",
      required_measurements: draft?.required_measurements || [],
    });
    setError("");
  }, [draft]);

  const fields = Array.from(new Set([...(form.required_measurements || []), ...Object.keys(form.measurements || {})]));
  const invalidAmounts =
    Number(form.paid_amount || 0) > Number(form.total_amount || 0) &&
    form.total_amount !== "" &&
    Number(form.total_amount) > 0;

  const save = () => {
    if (invalidAmounts) {
      setError("Paid amount cannot be greater than the total amount.");
      return;
    }
    const patch = buildDraftPatch(form);
    onSave?.(patch);
  };

  return (
    <div className="mt-3 rounded-xl border border-indigo-200 bg-white p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-800">Edit draft before confirming</p>
        <button type="button" onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-100" aria-label="Close draft editor">
          <X size={16} />
        </button>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="text-xs font-medium text-slate-600">
          Customer
          <input value={form.customer_name} readOnly className="mt-1 w-full rounded-lg border bg-slate-50 px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Product
          <input value={form.product_name} readOnly className="mt-1 w-full rounded-lg border bg-slate-50 px-2 py-1.5 text-sm" />
        </label>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {fields.map(field => (
          <label key={field} className="text-xs font-medium text-slate-600">
            {field}
            <input
              value={form.measurements?.[field] || ""}
              onChange={event =>
                setForm(current => ({
                  ...current,
                  measurements: { ...current.measurements, [field]: event.target.value },
                }))
              }
              placeholder="e.g. 36 in"
              className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm"
            />
          </label>
        ))}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <label className="text-xs font-medium text-slate-600">
          Total amount
          <input
            type="number"
            min="0"
            step="0.01"
            value={form.total_amount}
            onChange={event => setForm(current => ({ ...current, total_amount: event.target.value }))}
            className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Paid now
          <input
            type="number"
            min="0"
            step="0.01"
            value={form.paid_amount}
            onChange={event => setForm(current => ({ ...current, paid_amount: event.target.value }))}
            className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Delivery date
          <input
            type="date"
            value={form.delivery_date}
            onChange={event => setForm(current => ({ ...current, delivery_date: event.target.value }))}
            className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm"
          />
        </label>
      </div>
      <label className="mt-2 block text-xs font-medium text-slate-600">
        Notes
        <textarea
          rows={2}
          value={form.description}
          onChange={event => setForm(current => ({ ...current, description: event.target.value }))}
          className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm"
          maxLength={1000}
        />
      </label>
      {invalidAmounts && <p className="mt-2 text-xs font-medium text-rose-700">Paid amount cannot be greater than the total.</p>}
      {error && <p className="mt-2 text-xs font-medium text-rose-700">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          <Save size={14} /> Save draft and refresh preview
        </button>
        <button type="button" onClick={onClose} disabled={busy} className="rounded-lg border bg-white px-3 py-2 text-xs font-semibold text-slate-700">
          Close
        </button>
      </div>
    </div>
  );
}
