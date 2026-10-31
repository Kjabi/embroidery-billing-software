import React from "react";
import { ClipboardList, PencilLine, XCircle } from "lucide-react";
import { formatMoney } from "./voiceLogic";

const INTENT_LABELS = {
  create_order: "Preparing a new order",
  update_measurements: "Correcting measurements",
  record_payment: "Preparing a payment",
  update_delivery_date: "Changing a delivery date",
  update_order_status: "Changing an order status",
  create_customer: "Preparing a new customer",
  update_customer: "Updating a customer",
};

export default function VoiceTaskCard({ task, onEdit, onCancel, busy }) {
  if (!task) return null;
  const draft = task.draft || {};
  const missing = task.missing_fields || [];
  const measurements = Object.entries(draft.measurements || {});
  return (
    <div className="mt-3 rounded-xl border border-indigo-200 bg-white p-3 text-xs shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <ClipboardList size={16} className="mt-0.5 text-indigo-600" />
          <div>
            <p className="font-semibold text-slate-800">{INTENT_LABELS[task.intent] || task.intent || "Active task"}</p>
            {draft.customer_name && (
              <p className="mt-0.5 text-slate-600">
                {draft.customer_name}
                {draft.product_name ? ` — ${draft.product_name}` : ""}
              </p>
            )}
            {missing.length > 0 && (
              <p className="mt-1 text-amber-700">Still needed: {missing.join(", ")}</p>
            )}
            {!missing.length && draft.total_amount !== null && draft.total_amount !== undefined && (
              <p className="mt-1 text-slate-600">
                Total {formatMoney(draft.total_amount)} · paid {formatMoney(draft.paid_amount || 0)}
                {draft.delivery_date ? ` · delivery ${draft.delivery_date}` : ""}
              </p>
            )}
            {measurements.length > 0 && (
              <p className="mt-1 line-clamp-2 text-slate-500">
                {measurements.map(([name, value]) => `${name} ${value}`).join(" · ")}
              </p>
            )}
          </div>
        </div>
        <div className="flex gap-1.5">
          {draft.customer_id && (
            <button
              type="button"
              onClick={onEdit}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <PencilLine size={13} /> Edit
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-white px-2 py-1.5 font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            <XCircle size={13} /> Cancel draft
          </button>
        </div>
      </div>
    </div>
  );
}
