import React, { useMemo } from "react";
import {
  AreaChart, Area, BarChart, Bar, Cell, LineChart, Line, Pie, PieChart, XAxis, YAxis,
  Tooltip, ResponsiveContainer, CartesianGrid, Legend
} from "recharts";

export default function FinanceCharts({ finance }) {
  const financeChartData = useMemo(() => {
    let runningBalance = 0;
    return (finance.daily_chart || []).map(day => {
      const net = day.Income - day.Expense;
      runningBalance += net;
      return { ...day, Net: net, RunningBalance: runningBalance };
    });
  }, [finance.daily_chart]);

  const paymentMix = [
    { name: "Paid", value: finance.summary.paid_orders, color: "#08734f" },
    { name: "Partially paid", value: finance.summary.partially_paid_orders, color: "#1768c4" },
    { name: "Unpaid", value: finance.summary.unpaid_orders, color: "#b42332" }
  ].filter(item => item.value > 0);
  const categoryMix = (finance.expense_by_category || []).slice(0, 6).map((item, index) => ({
    ...item,
    color: ["#b42332", "#d97706", "#1768c4", "#7c3aed", "#08734f", "#52606d"][index]
  }));

  return (
    <>
      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl h-80">
          <h2 className="font-semibold text-sm mb-3">Date-Range Cash Flow (Credit vs Debit)</h2>
          <p className="sr-only">A chart comparing income and expenses for each day in the selected period.</p>
          <ResponsiveContainer aria-hidden="true" width="100%" height="88%">
            <BarChart data={finance.daily_chart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} />
              <YAxis stroke="#94a3b8" fontSize={11} />
              <Tooltip contentStyle={{ backgroundColor: "#0f172a", borderColor: "#334155" }} />
              <Legend />
              <Bar dataKey="Income" fill="#10b981" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Expense" fill="#f43f5e" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl h-80">
          <h2 className="font-semibold text-sm mb-3">Monthly / Yearly Profit &amp; Loss Trend</h2>
          <p className="sr-only">A chart comparing monthly income, expenses, and profit for the selected period.</p>
          <ResponsiveContainer aria-hidden="true" width="100%" height="88%">
            <BarChart data={finance.monthly_chart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="month" stroke="#94a3b8" fontSize={11} />
              <YAxis stroke="#94a3b8" fontSize={11} />
              <Tooltip contentStyle={{ backgroundColor: "#0f172a", borderColor: "#334155" }} />
              <Legend />
              <Bar dataKey="Income" fill="#6366f1" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Expense" fill="#f43f5e" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Profit" fill="#22c55e" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl lg:col-span-2">
          <div className="mb-1 flex items-center justify-between gap-3">
            <h2 className="font-semibold text-sm">Daily net cash movement</h2>
            <span className="text-xs text-slate-400">Income minus expenses</span>
          </div>
          <p className="mb-3 text-xs text-slate-400">Bars above zero mean cash came in faster than it went out. The line shows the running total for this selected period.</p>
          <p className="sr-only">A chart showing daily net cash movement and the running balance for the selected period.</p>
          <div className="h-64" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={financeChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#dbe3ea" />
                <XAxis dataKey="date" stroke="#64748b" fontSize={11} />
                <YAxis stroke="#64748b" fontSize={11} />
                <Tooltip formatter={(value) => `₹${Number(value).toLocaleString()}`} />
                <Legend />
                <Area type="monotone" dataKey="Net" name="Daily net" stroke="#1768c4" fill="#dbeafe" />
                <Line type="monotone" dataKey="RunningBalance" name="Running balance" stroke="#08734f" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
          <h2 className="font-semibold text-sm">Order payment health</h2>
          <p className="mb-2 mt-1 text-xs text-slate-400">Shows how many orders are fully collected, partly collected, or still unpaid.</p>
          <p className="sr-only">A chart showing the count of paid, partially paid, and unpaid orders.</p>
          <div className="h-52" aria-hidden="true">
            {paymentMix.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={paymentMix} dataKey="value" nameKey="name" innerRadius={48} outerRadius={76} paddingAngle={3}>
                    {paymentMix.map(item => <Cell key={item.name} fill={item.color} />)}
                  </Pie>
                  <Tooltip />
                  <Legend verticalAlign="bottom" height={30} />
                </PieChart>
              </ResponsiveContainer>
            ) : <p className="pt-16 text-center text-sm text-slate-500">No orders in this period.</p>}
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
          <h2 className="font-semibold text-sm">Where expenses go</h2>
          <p className="mb-2 mt-1 text-xs text-slate-400">The largest slices identify the categories that need the closest cost control.</p>
          <p className="sr-only">A chart showing expense totals grouped by category.</p>
          <div className="h-64" aria-hidden="true">
            {categoryMix.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={categoryMix} dataKey="amount" nameKey="category" outerRadius={82} label={({ category }) => category}>
                    {categoryMix.map(item => <Cell key={item.category} fill={item.color} />)}
                  </Pie>
                  <Tooltip formatter={(value) => `₹${Number(value).toLocaleString()}`} />
                </PieChart>
              </ResponsiveContainer>
            ) : <p className="pt-20 text-center text-sm text-slate-500">No expenses in this period.</p>}
          </div>
        </div>
        <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
          <h2 className="font-semibold text-sm">Income and expense comparison</h2>
          <p className="mb-2 mt-1 text-xs text-slate-400">Compare each month directly to spot profitable and costly periods.</p>
          <p className="sr-only">A chart comparing monthly income, expenses, and profit.</p>
          <div className="h-64" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={finance.monthly_chart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#dbe3ea" />
                <XAxis dataKey="month" stroke="#64748b" fontSize={11} />
                <YAxis stroke="#64748b" fontSize={11} />
                <Tooltip formatter={(value) => `₹${Number(value).toLocaleString()}`} />
                <Legend />
                <Line type="monotone" dataKey="Income" stroke="#08734f" strokeWidth={2} />
                <Line type="monotone" dataKey="Expense" stroke="#b42332" strokeWidth={2} />
                <Line type="monotone" dataKey="Profit" stroke="#1768c4" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </>
  );
}
