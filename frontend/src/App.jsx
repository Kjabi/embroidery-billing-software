import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  LayoutDashboard, Users, Scissors, FilePlus2, Receipt, Wallet,
  Download, MessageCircle, Plus, CheckCircle2, DatabaseBackup, LogOut,
  Search, Bell, Clock3, ClipboardCheck, Palette, Package, Settings2, ChevronRight,
  FileUp, Trash2
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, Cell, LineChart, Line, Pie, PieChart, XAxis, YAxis,
  Tooltip, ResponsiveContainer, CartesianGrid, Legend
} from 'recharts';
import VoiceAssistantPanel from './VoiceAssistantPanel';

const API = import.meta.env.VITE_API_BASE_URL
  || (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:8000/api"
    : "/api");

// Build-time feature flag. Set VITE_VOICE_ENABLED=false to hide the assistant
// without affecting the rest of the admin dashboard or any existing workflow.
const VOICE_ENABLED = import.meta.env.VITE_VOICE_ENABLED !== "false";

const newIdempotencyKey = () => (
  globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
);

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("emb_token") || "");
  const [loginForm, setLoginForm] = useState({ username: "lalithas", password: "" });
  const [loginErr, setLoginErr] = useState("");
  const [tab, setTab] = useState("dashboard");

  // App State
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [rates, setRates] = useState([]);
  const [orders, setOrders] = useState([]);
  const [finance, setFinance] = useState({
    summary: {
      total_income: 0, total_expense: 0, net_profit: 0, total_orders: 0,
      pending_orders: 0, completed_orders: 0, paid_orders: 0,
      partially_paid_orders: 0, unpaid_orders: 0, pending_payments: 0
    },
    daily_chart: [],
    monthly_chart: [],
    transactions: []
  });

  // Filters
  const [dateRange, setDateRange] = useState({ start: "", end: "" });
  const [custSearch, setCustSearch] = useState("");
  const [transactionFilter, setTransactionFilter] = useState({ type: "ALL", search: "" });

  // Forms
  const [newCust, setNewCust] = useState({ name: "", phone: "", alternate_phone: "", address: "", city: "Madurai", notes: "" });
  const [newProd, setNewProd] = useState({ name: "", pricing_type: "MANUAL", base_price: 500, measurement_template_id: "" });
  const [newTmpl, setNewTmpl] = useState({ name: "", fieldsCSV: "Bust, Waist, Shoulder, Sleeve Length" });
  const [newTx, setNewTx] = useState({
    date: new Date().toISOString().slice(0, 10),
    type: "EXPENSE",
    category: "Thread & Aari Material",
    description: "",
    amount: "",
    payment_method: "Cash/UPI"
  });

  // Order Form State
  const [orderForm, setOrderForm] = useState(() => {
    const savedDraft = localStorage.getItem("lalithas_order_draft");
    if (savedDraft) {
      try {
        return JSON.parse(savedDraft);
      } catch {
        localStorage.removeItem("lalithas_order_draft");
      }
    }
    return {
      customer_id: "",
      product_id: "",
      order_date: new Date().toISOString().slice(0, 10),
      delivery_date: "",
      description: "",
      embroidery_category: "Business Customer",
      stitch_count: 25000,
      base_amount: 0,
      extra_amount: 0,
      paid_amount: 0,
      measurements: {},
      idempotency_key: newIdempotencyKey()
    };
  });
  const [draftSavedAt, setDraftSavedAt] = useState(null);
  const [cloudBackupConfigured, setCloudBackupConfigured] = useState(false);

  const apiFetch = async (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
      localStorage.removeItem("emb_token");
      setToken("");
    }
    return response;
  };

  const logout = async () => {
    try {
      if (token) await apiFetch(`${API}/logout`, { method: "POST" });
    } finally {
      localStorage.removeItem("emb_token");
      localStorage.removeItem("lalithas_order_draft");
      setToken("");
    }
  };

  const openInvoicePdf = async (orderId, existingWindow = null, referenceImage = null) => {
    // Open synchronously within the click handler so browser popup blocking is less likely.
    const pdfWindow = existingWindow || window.open("about:blank", "_blank");
    try {
      const body = referenceImage ? (() => {
        const form = new FormData();
        form.append("image", referenceImage);
        return form;
      })() : undefined;
      const response = await apiFetch(
        `${API}/orders/${orderId}${referenceImage ? "/invoice" : "/pdf"}`,
        { method: referenceImage ? "POST" : "GET", body }
      );
      if (!response.ok) throw new Error("Invoice PDF could not be generated or downloaded.");
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      if (pdfWindow) pdfWindow.location.href = objectUrl;
      else window.location.href = objectUrl;
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (error) {
      if (pdfWindow && !pdfWindow.closed) pdfWindow.close();
      alert(error.message || "Invoice PDF could not be opened.");
    }
  };

  const setFinancePeriod = (period) => {
    const today = new Date();
    const end = today.toISOString().slice(0, 10);
    if (period === "all") {
      setDateRange({ start: "", end: "" });
      return;
    }
    const start = new Date(today);
    if (period === "month") start.setDate(1);
    if (period === "year") {
      start.setMonth(0);
      start.setDate(1);
    }
    setDateRange({ start: start.toISOString().slice(0, 10), end });
  };

  const downloadFinanceExport = async (format) => {
    const params = new URLSearchParams();
    if (dateRange.start) params.set("start_date", dateRange.start);
    if (dateRange.end) params.set("end_date", dateRange.end);
    const response = await apiFetch(`${API}/finance/export.${format}?${params.toString()}`);
    if (!response.ok) throw new Error("Finance export could not be generated.");
    const blob = await response.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `lalithas-finance.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(downloadUrl);
  };

  const financeChartData = useMemo(() => {
    let runningBalance = 0;
    return finance.daily_chart.map(day => {
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

  const restoreInputRef = useRef(null);
  const paymentRequestKeys = useRef({});
  const [referenceImage, setReferenceImage] = useState(null);
  const [referencePreview, setReferencePreview] = useState("");

  const loadAll = async () => {
    if (!token) return;
    const requests = [
      ["customers", `${API}/customers?q=${encodeURIComponent(custSearch)}`],
      ["products", `${API}/products`],
      ["templates", `${API}/templates`],
      ["rates", `${API}/embroidery-rates`],
      ["orders", `${API}/orders`],
      ["finance", `${API}/finance?start_date=${dateRange.start}&end_date=${dateRange.end}`],
    ];
    const results = await Promise.allSettled(requests.map(async ([name, url]) => {
      const response = await apiFetch(url);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`${name}: ${payload.detail || `HTTP ${response.status}`}`);
      }
      return [name, payload];
    }));

    results.forEach(result => {
      if (result.status === "rejected") {
        console.error("Could not load application data:", result.reason);
        return;
      }
      const [name, payload] = result.value;
      if (name === "customers") setCustomers(Array.isArray(payload) ? payload : (payload.items || []));
      if (name === "products") setProducts(Array.isArray(payload) ? payload : []);
      if (name === "templates") setTemplates(Array.isArray(payload) ? payload : []);
      if (name === "rates") setRates(Array.isArray(payload) ? payload : []);
      if (name === "orders") setOrders(Array.isArray(payload) ? payload : (payload.items || []));
      if (name === "finance" && payload?.summary) setFinance(payload);
    });
  };

  const removeOrder = async (order) => {
    if (!window.confirm(`Delete order ${order.invoice_number}? This also removes its measurements and saved files.`)) return;
    const response = await apiFetch(`${API}/orders/${order.id}`, { method: "DELETE" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      alert(result.detail || "Order could not be deleted.");
      return;
    }
    await loadAll();
  };

  const removeCustomer = async (customer) => {
    const orderMessage = customer.order_count
      ? ` This will also delete ${customer.order_count} linked order(s), measurements, and saved files.`
      : "";
    if (!window.confirm(`Delete customer ${customer.name}?${orderMessage}`)) return;
    const response = await apiFetch(
      `${API}/customers/${customer.id}?cascade_orders=${customer.order_count > 0}`,
      { method: "DELETE" }
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      alert(result.detail || "Customer could not be deleted.");
      return;
    }
    await loadAll();
  };

  useEffect(() => {
    loadAll();
  }, [token, custSearch, dateRange]);

  useEffect(() => {
    if (!token) return;
    apiFetch(`${API}/cloud-backup/status`)
      .then(response => response.json())
      .then(status => setCloudBackupConfigured(Boolean(status.configured)))
      .catch(() => setCloudBackupConfigured(false));
  }, [token]);

  useEffect(() => {
    if (tab !== "new-order") return;
    localStorage.setItem("lalithas_order_draft", JSON.stringify(orderForm));
    setDraftSavedAt(new Date());
  }, [orderForm, tab]);

  useEffect(() => () => {
    if (referencePreview) URL.revokeObjectURL(referencePreview);
  }, [referencePreview]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginErr("");
    try {
      const res = await fetch(`${API}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginForm)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoginErr(data.detail || "Invalid administrator username or password.");
        return;
      }
      localStorage.setItem("emb_token", data.token);
      setToken(data.token);
    } catch {
      setLoginErr("Cannot reach the backend. Start FastAPI on port 8000.");
    }
  };

  // --- ORDER HELPERS ---
  const selectedProduct = products.find(p => String(p.id) === String(orderForm.product_id));
  const selectedTemplate = templates.find(t => t.id === selectedProduct?.measurement_template_id);
  const currentRateObj = rates.find(r => r.category === orderForm.embroidery_category);
  const currentStitchRate = currentRateObj ? currentRateObj.rate_per_stitch : 0.05;
  const orderStatusCounts = orders.reduce((counts, order) => {
    const status = order.status || "Pending";
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
  const productionStages = [
    { label: "Pending", key: "Pending", icon: ClipboardCheck, color: "text-amber-500", bg: "bg-amber-50" },
    { label: "In Production", key: "In Progress", icon: Settings2, color: "text-blue-600", bg: "bg-blue-50" },
    { label: "Quality Check", key: "Quality Check", icon: CheckCircle2, color: "text-violet-600", bg: "bg-violet-50" },
    { label: "Ready", key: "Ready", icon: Package, color: "text-emerald-600", bg: "bg-emerald-50" }
  ];

  const calculateOrderTotal = () => {
    if (!selectedProduct) return 0;
    if (selectedProduct.pricing_type === "STITCH_BASED") {
      return Number((orderForm.stitch_count * currentStitchRate).toFixed(2));
    }
    return Number(orderForm.base_amount || 0) + Number(orderForm.extra_amount || 0);
  };

  const handleSelectCustomerForOrder = (custId) => {
    const cust = customers.find(c => String(c.id) === String(custId));
    setOrderForm(prev => ({
      ...prev,
      customer_id: custId,
      measurements: cust?.last_measurements || {}
    }));
  };

  const handleSelectProductForOrder = (prodId) => {
    const prod = products.find(p => String(p.id) === String(prodId));
    setOrderForm(prev => ({
      ...prev,
      product_id: prodId,
      base_amount: prod ? prod.base_price : 0,
      extra_amount: 0,
      embroidery_category: prod?.name.toLowerCase().includes("business to business") ? "Business" : "Business Customer"
    }));
  };

  const submitOrder = async (e) => {
    e.preventDefault();
    if (!orderForm.customer_id || !orderForm.product_id) {
      alert("Please select both a Customer and a Product.");
      return;
    }
    if (selectedTemplate) {
      const missingMeasurements = selectedTemplate.fields.filter(
        field => !String(orderForm.measurements[field] || "").trim()
      );
      if (missingMeasurements.length > 0) {
        alert(`Please enter all measurements:\n\n${missingMeasurements.join(", ")}`);
        return;
      }
    }
    const total = calculateOrderTotal();
    const msList = Object.entries(orderForm.measurements).map(([field_name, value]) => ({ field_name, value }));

    const payload = {
      customer_id: Number(orderForm.customer_id),
      product_id: Number(orderForm.product_id),
      order_date: orderForm.order_date,
      delivery_date: orderForm.delivery_date,
      description: orderForm.description,
      embroidery_category: selectedProduct?.pricing_type === "STITCH_BASED" ? orderForm.embroidery_category : null,
      stitch_count: selectedProduct?.pricing_type === "STITCH_BASED" ? Number(orderForm.stitch_count) : 0,
      rate_per_stitch: selectedProduct?.pricing_type === "STITCH_BASED" ? currentStitchRate : 0,
      base_amount: Number(orderForm.base_amount),
      extra_amount: Number(orderForm.extra_amount),
      total_amount: total,
      paid_amount: Number(orderForm.paid_amount),
      measurements: selectedProduct?.pricing_type === "STITCH_BASED" ? [] : msList,
      idempotency_key: orderForm.idempotency_key || newIdempotencyKey()
    };

    const invoiceWindow = window.open("about:blank", "_blank");
    const res = await apiFetch(`${API}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      const created = await res.json();
      localStorage.removeItem("lalithas_order_draft");
      await loadAll();
      await openInvoicePdf(created.id, invoiceWindow, referenceImage);
      setTab("invoices");
      if (referencePreview) URL.revokeObjectURL(referencePreview);
      setReferenceImage(null);
      setReferencePreview("");
      setOrderForm({
        customer_id: "", product_id: "", order_date: new Date().toISOString().slice(0, 10),
        delivery_date: "", description: "", embroidery_category: "Business Customer", stitch_count: 25000,
        base_amount: 0, extra_amount: 0, paid_amount: 0, measurements: {}, idempotency_key: newIdempotencyKey()
      });
    } else {
      if (invoiceWindow && !invoiceWindow.closed) invoiceWindow.close();
      const errorBody = await res.json().catch(() => ({}));
      alert(errorBody.detail || "Order could not be saved.");
    }
  };

  const sendWhatsAppMsg = (order, type) => {
    const cleanPhone = order.customer_phone.replace(/\D/g, "");
    const phoneWithCode = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;
    const msg = type === "ready"
      ? `Vanakkam ${order.customer_name}! Your order *${order.invoice_number}* (${order.product_name}) is stitched and READY for pickup at Lalitha's Apparel, Madurai. Balance Due: *Rs.${order.balance}*. Thank you!`
      : `Vanakkam ${order.customer_name}! Thank you for your order *${order.invoice_number}* (${order.product_name}). Total: Rs.${order.total_amount} | Advance Paid: Rs.${order.paid_amount} | Balance Due: *Rs.${order.balance}*. Delivery Date: ${order.delivery_date || 'Soon'}.`;
    window.open(`https://wa.me/${phoneWithCode}?text=${encodeURIComponent(msg)}`, "_blank");
  };

  const sendInvoicePdfOnWhatsApp = async (order) => {
    const cleanPhone = order.customer_phone.replace(/\D/g, "");
    const phoneWithCode = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;
    const msg = `Vanakkam ${order.customer_name}! Please find your Lalitha's Apparel invoice *${order.invoice_number}*. Total: Rs.${order.total_amount} | Paid: Rs.${order.paid_amount} | Balance Due: *Rs.${order.balance}*.`;
    const pdfUrl = `${API}/orders/${order.id}/pdf`;

    try {
      const response = await apiFetch(pdfUrl);
      if (!response.ok) {
        throw new Error("Invoice PDF could not be generated.");
      }
      const pdfBlob = await response.blob();
      const pdfFile = new File([pdfBlob], `${order.invoice_number}.pdf`, { type: "application/pdf" });

      if (navigator.share && navigator.canShare?.({ files: [pdfFile] })) {
        await navigator.share({
          files: [pdfFile],
          title: `Lalitha's Apparel - ${order.invoice_number}`,
          text: msg
        });
        return;
      }

      const downloadUrl = URL.createObjectURL(pdfBlob);
      const downloadLink = document.createElement("a");
      downloadLink.href = downloadUrl;
      downloadLink.download = `${order.invoice_number}.pdf`;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      downloadLink.remove();
      URL.revokeObjectURL(downloadUrl);
      window.open(`https://wa.me/${phoneWithCode}?text=${encodeURIComponent(`${msg} The PDF has been downloaded. Please attach it to this chat.`)}`, "_blank");
      alert("The invoice PDF was downloaded. Attach it in the WhatsApp chat that just opened.");
    } catch (error) {
      if (error.name === "AbortError") return;
      alert(error.message || "The invoice PDF could not be sent.");
    }
  };

  const restoreBackup = async (file) => {
    if (!file) return;
    const confirmed = window.confirm(
      "Restore this backup? All current customers, orders, measurements, payments, and settings will be replaced. A safety backup will be created first."
    );
    if (!confirmed) return;

    const formData = new FormData();
    formData.append("file", file);
    const response = await apiFetch(`${API}/restore`, {
      method: "POST",
      body: formData
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      alert(result.detail || "Restore failed. Current data was not changed.");
      return;
    }
    await loadAll();
    alert(`Restore completed. ${result.restored_counts.orders || 0} orders and ${result.restored_counts.customers || 0} customers are now available.`);
  };

  // --- LOGIN VIEW ---
  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4">
        <form onSubmit={handleLogin} className="bg-slate-900 border border-slate-800 rounded-2xl p-8 w-full max-w-md shadow-2xl">
          <div className="flex items-center gap-3 mb-6">
            <div className="overflow-hidden rounded-xl bg-white p-1.5 shadow-sm">
              <img src="/lalithas-apparel-logo.png" alt="Lalitha's Apparel logo" className="h-16 w-16 object-cover" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">Lalitha&apos;s Apparel</h1>
              <p className="text-xs text-slate-400">Embroidery, tailoring & boutique management</p>
            </div>
          </div>
          {loginErr && <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs">{loginErr}</div>}
          <label className="block text-xs font-medium text-slate-400 mb-1">Admin Username</label>
          <input
            value={loginForm.username}
            onChange={e => setLoginForm({ ...loginForm, username: e.target.value })}
            className="w-full mb-4 px-3 py-2.5 rounded-lg bg-slate-950 border border-slate-800 text-white"
          />
          <label className="block text-xs font-medium text-slate-400 mb-1">Password</label>
          <input
            type="password"
            value={loginForm.password}
            onChange={e => setLoginForm({ ...loginForm, password: e.target.value })}
            autoComplete="current-password"
            className="w-full mb-6 px-3 py-2.5 rounded-lg bg-slate-950 border border-slate-800 text-white"
          />
          <button className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-semibold text-white transition">
            LOGIN TO ADMIN PANEL
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* SIDEBAR */}
      <aside className="w-full md:w-60 bg-slate-900 border-b md:border-r border-slate-800 p-4 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-2.5 px-2 py-5 mb-2 border-b border-slate-800">
            <img src="/lalithas-apparel-logo.png" alt="Lalitha's Apparel logo" className="h-11 w-11 rounded-full object-cover" />
            <div>
              <h2 className="font-bold text-sm tracking-tight">Lalitha&apos;s Apparel</h2>
              <p className="text-[11px] text-slate-400">Apparel studio</p>
            </div>
          </div>
          <nav className="space-y-1 px-0 py-4">
            {[
              { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
              { id: "new-order", label: "New Order", icon: FilePlus2 },
              { id: "invoices", label: "Orders", icon: Receipt },
              { id: "customers", label: "Customers", icon: Users },
              { id: "products", label: "Products", icon: Scissors },
              { id: "finance", label: "Finance", icon: Wallet },
            ].map(item => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition ${
                    tab === item.id ? "bg-indigo-600 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-white"
                  }`}
                >
                  <Icon size={18} /> {item.label}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="space-y-2 pt-4 border-t border-slate-800">
          <button
            onClick={async () => {
              const r = await apiFetch(`${API}/backup`, { method: "POST" }).then(res => res.json());
              alert(`Database backed up locally to:\n${r.backup_file}`);
            }}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200"
          >
            <DatabaseBackup size={15} /> Backup Local Database
          </button>
          <input
            ref={restoreInputRef}
            type="file"
            accept=".db,.sqlite,.sqlite3"
            className="hidden"
            onChange={e => {
              restoreBackup(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => restoreInputRef.current?.click()}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-amber-50 hover:bg-amber-100 text-xs text-amber-700"
          >
            <FileUp size={15} /> Restore From Backup File
          </button>
          <button
            disabled={!cloudBackupConfigured}
            onClick={async () => {
              const response = await apiFetch(`${API}/cloud-backup`, { method: "POST" });
              const result = await response.json().catch(() => ({}));
              if (!response.ok) {
                alert(result.detail || "Cloud backup failed.");
                return;
              }
              alert(`Cloud backup completed.\nDatabase: ${result.database_object}`);
            }}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-blue-50 hover:bg-blue-100 text-xs text-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            title={cloudBackupConfigured ? "Upload a SQLite snapshot to Supabase Storage" : "Configure Supabase Storage credentials on the backend first"}
          >
            <DatabaseBackup size={15} /> {cloudBackupConfigured ? "Backup to Supabase Storage" : "Supabase Storage Backup Not Configured"}
          </button>
          <button
            onClick={logout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-xs text-red-300"
          >
            <LogOut size={15} /> Logout
          </button>
        </div>
      </aside>

      {/* MAIN CONTENT */}
      <main className="flex-1 overflow-y-auto">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-slate-200 bg-white/95 px-5 py-4 backdrop-blur md:px-8">
          <div className="relative hidden min-w-0 max-w-md flex-1 md:block">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              aria-label="Search customers"
              value={custSearch}
              onChange={e => setCustSearch(e.target.value)}
              placeholder="Search customers, phone numbers..."
              className="w-full rounded-lg border px-9 py-2 text-sm"
            />
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-slate-500 sm:inline">Local workspace</span>
            <button className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Notifications">
              <Bell size={18} />
              {finance.summary.pending_orders > 0 && (
                <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-orange-500" />
              )}
            </button>
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700">A</div>
          </div>
        </header>
        <div className="mx-auto max-w-[1400px] p-5 pb-32 md:px-8 md:py-7">
        {VOICE_ENABLED && (
          <VoiceAssistantPanel
            apiFetch={apiFetch}
            apiBase={API}
            onOpenInvoice={openInvoicePdf}
            onDataChanged={loadAll}
          />
        )}
        {/* 1. DASHBOARD */}
        {tab === "dashboard" && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-slate-500">
                  <span>Workspace</span><ChevronRight size={13} /><span className="text-blue-600">Overview</span>
                </div>
                <h1 className="text-2xl font-bold">Good morning, Admin</h1>
                <p className="text-xs text-slate-400">Here is today&apos;s embroidery and boutique operations summary.</p>
              </div>
              <button
                onClick={() => setTab("new-order")}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-sm font-semibold"
              >
                <Plus size={18} /> + Create New Order Bill
              </button>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-sm lg:col-span-2">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-medium text-slate-400">Production control</p>
                    <h2 className="mt-2 text-xl font-semibold">Keep every job moving</h2>
                    <p className="mt-1 max-w-lg text-sm text-slate-500">Track orders from measurement and digitizing through stitching, quality check, and delivery.</p>
                  </div>
                  <Palette size={34} className="text-blue-600" />
                </div>
                <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {productionStages.map(stage => {
                    const Icon = stage.icon;
                    return (
                      <div key={stage.key} className={`rounded-xl ${stage.bg} p-3`}>
                        <Icon size={16} className={`mb-2 ${stage.color}`} />
                        <p className="text-xl font-bold">{orderStatusCounts[stage.key] || 0}</p>
                        <p className="text-[11px] text-slate-500">{stage.label}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="rounded-2xl border border-orange-100 bg-orange-50 p-4">
                <div className="flex items-center gap-2 text-orange-700">
                  <Clock3 size={18} />
                  <p className="text-xs font-semibold">Attention needed</p>
                </div>
                <p className="mt-2 text-3xl font-bold text-orange-800">{finance.summary.pending_orders}</p>
                <p className="mt-1 text-sm text-orange-800">orders still in progress</p>
                <p className="mt-3 border-t border-orange-200 pt-3 text-xs text-orange-700">
                  ₹{finance.summary.pending_payments.toLocaleString()} outstanding from customers
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
                <p className="text-xs text-slate-400">Total Income Received</p>
                <p className="text-2xl font-bold text-emerald-400 mt-1">₹{finance.summary.total_income.toLocaleString()}</p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-4 lg:col-span-2">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-semibold text-sm">Payment collection status</h3>
                    <p className="mt-1 text-xs text-slate-400">Live status calculated from each order&apos;s paid amount and balance.</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    ["Paid", finance.summary.paid_orders, "text-emerald-600", "bg-emerald-50"],
                    ["Partially paid", finance.summary.partially_paid_orders, "text-blue-600", "bg-blue-50"],
                    ["Unpaid", finance.summary.unpaid_orders, "text-rose-600", "bg-rose-50"],
                    ["Outstanding", `₹${finance.summary.pending_payments.toLocaleString()}`, "text-orange-600", "bg-orange-50"]
                  ].map(([label, value, color, bg]) => (
                    <div key={label} className={`rounded-xl ${bg} p-3`}>
                      <p className={`text-xl font-bold ${color}`}>{value}</p>
                      <p className="mt-1 text-[11px] text-slate-600">{label}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex justify-end">
                  <button onClick={loadAll} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-blue-600 hover:bg-blue-50">
                    Refresh status
                  </button>
                </div>
              </div>
              <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
                <p className="text-xs text-slate-400">Total Expenses</p>
                <p className="text-2xl font-bold text-rose-400 mt-1">₹{finance.summary.total_expense.toLocaleString()}</p>
              </div>
              <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
                <p className="text-xs text-slate-400">Net Profit</p>
                <p className="text-2xl font-bold text-indigo-400 mt-1">₹{finance.summary.net_profit.toLocaleString()}</p>
              </div>
              <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 lg:col-span-2">
                <p className="text-xs text-slate-400">Pending Customer Balance</p>
                <p className="text-2xl font-bold text-amber-400 mt-1">₹{finance.summary.pending_payments.toLocaleString()}</p>
                <p className="text-xs text-slate-400 mt-1">{finance.summary.pending_orders} pending / {finance.summary.completed_orders} completed</p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {[
                { title: "Customer relationships", text: "Store contact details, preferences, notes, and measurement history.", icon: Users, tab: "customers" },
                { title: "Design & rate library", text: "Manage products, stitch rates, templates, and reusable services.", icon: Palette, tab: "products" },
                { title: "Cash & profitability", text: "Review collections, expenses, balances, and date-range performance.", icon: Wallet, tab: "finance" }
              ].map(item => {
                const Icon = item.icon;
                return (
                  <button key={item.title} onClick={() => setTab(item.tab)} className="group flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-sm">
                    <span className="rounded-lg bg-blue-50 p-2 text-blue-600"><Icon size={18} /></span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-slate-700">{item.title}</span>
                      <span className="mt-1 block text-xs leading-5 text-slate-500">{item.text}</span>
                    </span>
                    <ChevronRight size={16} className="ml-auto mt-1 shrink-0 text-slate-300 transition group-hover:text-blue-500" />
                  </button>
                );
              })}
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <h3 className="font-semibold text-sm mb-4">Recent Orders & Quick Actions</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="py-2">Invoice</th>
                      <th>Customer</th>
                      <th>Product</th>
                      <th>Total</th>
                      <th>Balance Due</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {orders.slice(0, 6).map(o => (
                      <tr key={o.id}>
                        <td className="py-3 font-mono text-xs text-indigo-400">{o.invoice_number}</td>
                        <td>{o.customer_name} <span className="text-xs text-slate-400">({o.customer_phone})</span></td>
                        <td>{o.product_name}</td>
                        <td>₹{o.total_amount}</td>
                        <td className={o.balance > 0 ? "text-amber-400 font-semibold" : "text-emerald-400"}>₹{o.balance}</td>
                        <td className="flex items-center gap-2 py-2">
                          <button
                            onClick={() => openInvoicePdf(o.id)}
                            className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm flex items-center gap-1"
                          >
                            <Download size={13} /> PDF
                          </button>
                          <button
                            onClick={() => sendWhatsAppMsg(o, "ready")}
                            className="px-3 py-2 rounded-lg bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 text-sm flex items-center gap-1"
                          >
                            <MessageCircle size={13} /> Ready Alert
                          </button>
                          <button
                            onClick={() => sendInvoicePdfOnWhatsApp(o)}
                            className="px-3 py-2 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 text-sm flex items-center gap-1"
                          >
                            <FileUp size={13} /> Send Bill PDF
                          </button>
                          <button
                            onClick={() => removeOrder(o)}
                            className="px-3 py-2 rounded-lg bg-rose-600/20 text-rose-300 hover:bg-rose-600/30 text-sm flex items-center gap-1"
                          >
                            <Trash2 size={13} /> Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* 2. NEW ORDER / BILLING */}
        {tab === "new-order" && (
          <form onSubmit={submitOrder} className="space-y-6 max-w-4xl">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-400">Orders / New order</p>
                <h1 className="text-2xl font-bold">Build a new order</h1>
                <p className="mt-1 text-xs text-slate-400">Capture the customer, measurements, design notes, pricing, and first payment in one place.</p>
              </div>
              <span className="text-xs text-slate-400">
                {draftSavedAt ? `Draft autosaved at ${draftSavedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Draft ready"}
              </span>
            </div>

            <div className="grid md:grid-cols-2 gap-4 bg-slate-900 border border-slate-800 p-5 rounded-2xl">
              <div>
                <label className="text-xs text-slate-400">1. Select Customer (Auto-loads saved measurements)</label>
                <select
                  required
                  value={orderForm.customer_id}
                  onChange={e => handleSelectCustomerForOrder(e.target.value)}
                  className="w-full mt-1 px-3 py-2.5 rounded-lg bg-slate-950 border border-slate-800"
                >
                  <option value="">-- Choose Customer --</option>
                  {customers.map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({c.phone})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs text-slate-400">2. Select Product / Work Type</label>
                <select
                  required
                  value={orderForm.product_id}
                  onChange={e => handleSelectProductForOrder(e.target.value)}
                  className="w-full mt-1 px-3 py-2.5 rounded-lg bg-slate-950 border border-slate-800"
                >
                  <option value="">-- Choose Product --</option>
                  {products.filter(p => p.active).map(p => (
                    <option key={p.id} value={p.id}>{p.name} ({p.pricing_type})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs text-slate-400">Order Date</label>
                <input
                  type="date"
                  value={orderForm.order_date}
                  onChange={e => setOrderForm({ ...orderForm, order_date: e.target.value })}
                  className="w-full mt-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800"
                />
              </div>

              <div>
                <label className="text-xs text-slate-400">Delivery Date</label>
                <input
                  type="date"
                  value={orderForm.delivery_date}
                  onChange={e => setOrderForm({ ...orderForm, delivery_date: e.target.value })}
                  className="w-full mt-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800"
                />
              </div>
            </div>

            {/* CONDITIONAL: EMBROIDERY STITCH CALCULATOR VS MEASUREMENTS */}
            {selectedProduct && selectedProduct.pricing_type === "STITCH_BASED" ? (
              <div className="bg-indigo-950/30 border border-indigo-500/40 p-5 rounded-2xl space-y-4">
                <h3 className="font-semibold text-indigo-300">Embroidery Stitch-Based Cost Calculator (No Measurements Needed)</h3>
                <div className="grid md:grid-cols-3 gap-4">
                  <div>
                    <label className="text-xs text-slate-300">Customer Category</label>
                    <select
                      value={orderForm.embroidery_category}
                      onChange={e => setOrderForm({ ...orderForm, embroidery_category: e.target.value })}
                      className="w-full mt-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800"
                    >
                      {rates.map(r => (
                        <option key={r.category} value={r.category}>{r.category} (₹{r.rate_per_stitch}/stitch)</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-slate-300">Number of Stitches</label>
                    <input
                      type="number"
                      value={orderForm.stitch_count}
                      onChange={e => setOrderForm({ ...orderForm, stitch_count: Number(e.target.value) })}
                      className="w-full mt-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-300">Calculated Stitch Amount</label>
                    <div className="mt-1 px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 font-bold text-emerald-400">
                      ₹{calculateOrderTotal().toLocaleString()}
                    </div>
                  </div>
                </div>
              </div>
            ) : selectedTemplate ? (
              <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-semibold text-sm text-indigo-300">
                      3. {selectedTemplate.name} Measurements
                    </h3>
                    <p className="mt-1 text-xs text-slate-400">
                      Enter the customer&apos;s measurements in inches. Every field is required for this product.
                    </p>
                  </div>
                  <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700">
                    {selectedTemplate.fields.length} measurements required
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {selectedTemplate.fields.map(field => (
                    <div key={field}>
                      <label className="text-xs text-slate-400">
                        {field} <span className="text-rose-400">*</span>
                      </label>
                      <input
                        required
                        type="number"
                        min="0"
                        step="0.1"
                        placeholder="inch"
                        value={orderForm.measurements[field] || ""}
                        onChange={e =>
                          setOrderForm({
                            ...orderForm,
                            measurements: { ...orderForm.measurements, [field]: e.target.value }
                          })
                        }
                        className="w-full mt-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm"
                      />
                    </div>
                  ))}
                </div>
              </div>
            ) : selectedProduct ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
                <p className="text-sm font-semibold text-amber-800">No measurements required for {selectedProduct.name}</p>
                <p className="mt-1 text-xs text-amber-700">
                  This product is priced as a service or embroidery job. Add design and cloth details below.
                </p>
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-500">
                Select a product to see the exact customer measurements required.
              </div>
            )}

            {/* DESCRIPTION & REFERENCE IMAGE */}
            <div className="grid md:grid-cols-2 gap-4 bg-slate-900 border border-slate-800 p-5 rounded-2xl">
              <div>
                <label className="text-xs font-semibold text-slate-300">4. Cloth & Design Description Notes</label>
                <textarea
                  rows={6}
                  placeholder="E.g., Dark green raw silk, peacock zardosi on sleeve, deep U back neck with dori, front hook..."
                  value={orderForm.description}
                  onChange={e => setOrderForm({ ...orderForm, description: e.target.value })}
                  className="w-full mt-2 p-3 rounded-lg bg-slate-950 border border-slate-800 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-300">5. Reference Image (Optional)</label>
                <p className="mt-1 text-xs text-slate-400">JPEG or PNG, maximum 5 MB. Used only for the PDF generated now; it is not saved.</p>
                {!referencePreview ? (
                  <label className="mt-3 flex min-h-32 cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 text-center text-sm text-slate-500">
                    <span>Upload reference image (optional)</span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png"
                      className="hidden"
                      onChange={event => {
                        const file = event.target.files?.[0];
                        if (!file) return;
                        if (!["image/jpeg", "image/png"].includes(file.type)) {
                          alert("Only JPEG and PNG images are supported.");
                          event.target.value = "";
                          return;
                        }
                        if (file.size > 5 * 1024 * 1024) {
                          alert("Reference image must be 5 MB or smaller.");
                          event.target.value = "";
                          return;
                        }
                        if (referencePreview) URL.revokeObjectURL(referencePreview);
                        setReferenceImage(file);
                        setReferencePreview(URL.createObjectURL(file));
                      }}
                    />
                  </label>
                ) : (
                  <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <img src={referencePreview} alt="Reference preview" className="max-h-40 w-full rounded-lg object-contain" />
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-xs text-slate-500">{referenceImage?.name}</span>
                      <div className="flex gap-2">
                        <label className="cursor-pointer rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700">
                          Replace
                          <input type="file" accept="image/jpeg,image/png" className="hidden" onChange={event => {
                            const file = event.target.files?.[0];
                            if (!file) return;
                            if (!["image/jpeg", "image/png"].includes(file.type) || file.size > 5 * 1024 * 1024) {
                              alert("Choose a JPEG or PNG image up to 5 MB.");
                              return;
                            }
                            if (referencePreview) URL.revokeObjectURL(referencePreview);
                            setReferenceImage(file);
                            setReferencePreview(URL.createObjectURL(file));
                          }} />
                        </label>
                        <button type="button" onClick={() => { if (referencePreview) URL.revokeObjectURL(referencePreview); setReferenceImage(null); setReferencePreview(""); }} className="rounded-lg bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700">Remove</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* BILLING & PAYMENT */}
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl grid md:grid-cols-4 gap-4 items-end">
              {selectedProduct?.pricing_type !== "STITCH_BASED" && (
                <>
                  <div>
                    <label className="text-xs text-slate-400">Base Price (₹)</label>
                    <input
                      type="number"
                      value={orderForm.base_amount}
                      onChange={e => setOrderForm({ ...orderForm, base_amount: e.target.value })}
                      className="w-full mt-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400">Extra Aari / Design Charge (₹)</label>
                    <input
                      type="number"
                      value={orderForm.extra_amount}
                      onChange={e => setOrderForm({ ...orderForm, extra_amount: e.target.value })}
                      className="w-full mt-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800"
                    />
                  </div>
                </>
              )}
              <div>
                <label className="text-xs text-slate-400">Advance Paid Now (₹)</label>
                <input
                  type="number"
                  value={orderForm.paid_amount}
                  onChange={e => setOrderForm({ ...orderForm, paid_amount: e.target.value })}
                  className="w-full mt-1 px-3 py-2 rounded-lg bg-slate-950 border border-emerald-700"
                />
              </div>
              <div>
                <p className="text-xs text-slate-400">Final Total / Balance Due</p>
                <p className="text-lg font-bold text-white">
                  Total: ₹{calculateOrderTotal()} | <span className="text-amber-400">Bal: ₹{Math.max(0, calculateOrderTotal() - Number(orderForm.paid_amount))}</span>
                </p>
              </div>
            </div>

            <button type="submit" className="w-full py-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-bold text-white shadow-lg">
              SAVE ORDER & GENERATE DOWNLOADABLE PDF INVOICE
            </button>
          </form>
        )}

        {/* 3. INVOICES & ORDERS */}
        {tab === "invoices" && (
          <div className="space-y-4">
            <h1 className="text-2xl font-bold">Orders & PDF Invoices</h1>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-2">Invoice</th>
                    <th>Date</th>
                    <th>Customer</th>
                    <th>Product</th>
                    <th>Total</th>
                    <th>Paid</th>
                    <th>Balance</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {orders.map(o => (
                    <tr key={o.id}>
                      <td className="py-3 font-mono text-xs text-indigo-400">{o.invoice_number}</td>
                      <td>{o.order_date}</td>
                      <td>{o.customer_name} ({o.customer_phone})</td>
                      <td>{o.product_name}</td>
                      <td>₹{o.total_amount}</td>
                      <td className="text-emerald-400">₹{o.paid_amount}</td>
                      <td className="text-amber-400 font-bold">₹{o.balance}</td>
                      <td>
                        <span className={`px-2 py-0.5 rounded text-xs ${o.status === 'Paid' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}`}>
                          {o.status}
                        </span>
                      </td>
                      <td className="py-2 flex flex-wrap gap-1.5">
                        <button
                          onClick={() => openInvoicePdf(o.id)}
                          className="px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs flex items-center gap-1"
                        >
                          <Download size={13} /> PDF Bill
                        </button>
                        <button
                          onClick={() => sendWhatsAppMsg(o, "bill")}
                          className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs"
                        >
                          WA Bill
                        </button>
                        <button
                          onClick={() => sendInvoicePdfOnWhatsApp(o)}
                          className="px-2.5 py-1 rounded bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs flex items-center gap-1"
                        >
                          <FileUp size={13} /> Send PDF
                        </button>
                        <button
                          onClick={() => sendWhatsAppMsg(o, "ready")}
                          className="px-2.5 py-1 rounded bg-emerald-600/20 text-emerald-300 text-xs"
                        >
                          WA Ready
                        </button>
                        <button
                          onClick={() => removeOrder(o)}
                          className="px-2.5 py-1 rounded bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 text-xs flex items-center gap-1"
                        >
                          <Trash2 size={13} /> Delete
                        </button>
                        {o.balance > 0 && (
                          <button
                            onClick={async () => {
                              const amt = prompt(`Collect remaining balance for ${o.invoice_number} (Due: ₹${o.balance}):`, o.balance);
                              if (amt && Number(amt) > 0) {
                                const paymentKey = paymentRequestKeys.current[o.id] || newIdempotencyKey();
                                paymentRequestKeys.current[o.id] = paymentKey;
                                const paymentResponse = await apiFetch(`${API}/orders/${o.id}/pay`, {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ additional_paid: Number(amt), idempotency_key: paymentKey })
                                });
                                if (!paymentResponse.ok) {
                                  const error = await paymentResponse.json().catch(() => ({}));
                                  alert(error.detail || "Payment could not be updated.");
                                  return;
                                }
                                delete paymentRequestKeys.current[o.id];
                                await loadAll();
                              }
                            }}
                            className="px-2.5 py-1 rounded bg-amber-500/20 text-amber-300 text-xs flex items-center gap-1"
                          >
                            <CheckCircle2 size={13} /> Mark Paid
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 4. CUSTOMERS */}
        {tab === "customers" && (
          <div className="grid items-start gap-6 md:grid-cols-[minmax(240px,280px)_minmax(0,1fr)]">
            <form
              onSubmit={async e => {
                e.preventDefault();
                try {
                  const response = await apiFetch(`${API}/customers`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(newCust)
                  });
                  const result = await response.json().catch(() => ({}));
                  if (!response.ok) {
                    if (response.status === 401) {
                      logout();
                      throw new Error("Your session expired. Please log in again.");
                    }
                    throw new Error(result.detail || "Customer could not be saved.");
                  }
                  setNewCust({ name: "", phone: "", alternate_phone: "", address: "", city: "Madurai", notes: "" });
                  await loadAll();
                  alert("Customer saved successfully.");
                } catch (error) {
                  alert(error.message || "Customer could not be saved. Check that the backend is running.");
                }
              }}
              className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-3 h-fit"
            >
              <h3 className="font-bold text-base">+ Add Customer</h3>
              <input required placeholder="Customer Name" value={newCust.name} onChange={e => setNewCust({ ...newCust, name: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
              <input required placeholder="10-Digit Phone Number" value={newCust.phone} onChange={e => setNewCust({ ...newCust, phone: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
              <input placeholder="Address / Area" value={newCust.address} onChange={e => setNewCust({ ...newCust, address: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
              <textarea placeholder="Special Notes" value={newCust.notes} onChange={e => setNewCust({ ...newCust, notes: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
              <button className="w-full py-2.5 rounded-xl bg-indigo-600 font-semibold text-sm">Save Customer</button>
            </form>

            <div className="min-w-0 bg-slate-900 border border-slate-800 p-5 rounded-2xl">
              <div className="sticky top-0 z-10 -mx-1 mb-4 flex flex-wrap items-center justify-between gap-3 bg-white px-1 pb-3">
                <div>
                  <h3 className="font-bold">Customer Directory</h3>
                  <p className="mt-1 text-xs text-slate-400">Saved measurements and order history</p>
                </div>
                <input
                  placeholder="Search name or phone..."
                  value={custSearch}
                  onChange={e => setCustSearch(e.target.value)}
                  className="w-full max-w-[220px] px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs"
                />
              </div>
              <div className="max-h-[calc(100vh-230px)] min-h-[260px] space-y-3 overflow-y-auto pr-2">
                {customers.map(c => (
                  <div key={c.id} className="grid gap-4 rounded-xl border border-slate-800 bg-slate-950 p-4 sm:grid-cols-[minmax(0,1fr)_150px] sm:items-start">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm">{c.name} <span className="text-xs text-indigo-400">({c.cust_code})</span></p>
                      <p className="mt-1 break-words text-xs text-slate-400">{c.phone} • {c.address}, {c.city}</p>
                      {Object.keys(c.last_measurements || {}).length > 0 && (
                        <p className="mt-2 break-words text-[11px] leading-5 text-emerald-400">
                          Saved Measurements: {Object.entries(c.last_measurements).map(([k, v]) => `${k}: ${v}"`).join(" | ")}
                        </p>
                      )}
                    </div>
                    <div className="flex items-start justify-between gap-3 border-t border-slate-800 pt-3 sm:block sm:border-t-0 sm:pt-0 sm:text-right">
                      <p className="text-xs text-slate-400">{c.order_count} Orders</p>
                      <p className="font-bold text-sm text-white">Total Spent: ₹{c.total_spent}</p>
                      <button
                        onClick={() => removeCustomer(c)}
                        className="mt-0 px-2.5 py-1.5 rounded bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 text-xs inline-flex items-center gap-1 sm:mt-2"
                      >
                        <Trash2 size={12} /> Delete customer
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 5. PRODUCTS, TEMPLATES & STITCH RATES */}
        {tab === "products" && (
          <div className="space-y-6">
            {/* Embroidery Stitch Rates */}
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
              <h3 className="font-bold mb-3 text-indigo-300">Configurable Embroidery Per-Stitch Rates</h3>
              <div className="grid sm:grid-cols-2 gap-4">
                {rates.map(r => (
                  <div key={r.category} className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-sm">{r.category}</p>
                      <p className="text-xs text-slate-400">Current Rate: ₹{r.rate_per_stitch} / stitch (1,000 stitches = ₹{(r.rate_per_stitch * 1000).toFixed(1)})</p>
                    </div>
                    <button
                      onClick={async () => {
                        const val = prompt(`Enter new rate per single stitch for ${r.category}:`, r.rate_per_stitch);
                        if (val) {
                          await apiFetch(`${API}/embroidery-rates`, {
                            method: "PUT",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ category: r.category, rate_per_stitch: Number(val) })
                          });
                          loadAll();
                        }
                      }}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600 text-xs font-semibold"
                    >
                      Edit Rate
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              {/* Add Customizable Product */}
              <form
                onSubmit={async e => {
                  e.preventDefault();
                  await apiFetch(`${API}/products`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      ...newProd,
                      base_price: Number(newProd.base_price),
                      measurement_template_id: newProd.measurement_template_id ? Number(newProd.measurement_template_id) : null
                    })
                  });
                  setNewProd({ name: "", pricing_type: "MANUAL", base_price: 500, measurement_template_id: "" });
                  loadAll();
                }}
                className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-3"
              >
                <h3 className="font-bold text-sm">+ Add Custom Product</h3>
                <input required placeholder="Product Name" value={newProd.name} onChange={e => setNewProd({ ...newProd, name: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
                <select value={newProd.pricing_type} onChange={e => setNewProd({ ...newProd, pricing_type: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm">
                  <option value="MANUAL">Fixed / Manual Price</option>
                  <option value="BASE_PLUS_EXTRA">Base + Extra Work Charge</option>
                  <option value="STITCH_BASED">Embroidery Stitch-Based</option>
                </select>
                <input type="number" placeholder="Default Base Price (₹)" value={newProd.base_price} onChange={e => setNewProd({ ...newProd, base_price: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
                <select value={newProd.measurement_template_id} onChange={e => setNewProd({ ...newProd, measurement_template_id: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm">
                  <option value="">No Measurement Needed (Saree Falls / Embroidery)</option>
                  {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <p className="text-[11px] text-slate-400">
                  The selected template becomes the required measurement checklist whenever this product is ordered.
                </p>
                <button className="w-full py-2 rounded-xl bg-indigo-600 font-semibold text-sm">Add Product</button>
              </form>

              {/* Add Custom Measurement Template */}
              <form
                onSubmit={async e => {
                  e.preventDefault();
                  await apiFetch(`${API}/templates`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: newTmpl.name, fields: newTmpl.fieldsCSV.split(",") })
                  });
                  setNewTmpl({ name: "", fieldsCSV: "" });
                  loadAll();
                }}
                className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-3"
              >
                <h3 className="font-bold text-sm">+ Create Custom Measurement Template</h3>
                <input required placeholder="Template Name (e.g. Kids Pavadai)" value={newTmpl.name} onChange={e => setNewTmpl({ ...newTmpl, name: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
                <textarea required rows={3} placeholder="Comma-separated fields (e.g. Chest, Waist, Skirt Length, Shoulder)" value={newTmpl.fieldsCSV} onChange={e => setNewTmpl({ ...newTmpl, fieldsCSV: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
                <button className="w-full py-2 rounded-xl bg-indigo-600 font-semibold text-sm">Save Measurement Template</button>
              </form>
            </div>

            {/* Product List */}
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
              <h3 className="font-bold mb-3 text-sm">All Products (Activate / Deactivate)</h3>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {products.map(p => (
                  <div key={p.id} className="p-3 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-sm">{p.name}</p>
                      <p className="text-xs text-slate-400">{p.pricing_type} • Base ₹{p.base_price}</p>
                    </div>
                    <button
                      onClick={async () => {
                        await apiFetch(`${API}/products/${p.id}/toggle`, { method: "PATCH" });
                        loadAll();
                      }}
                      className={`px-2.5 py-1 rounded text-xs font-semibold ${p.active ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"}`}
                    >
                      {p.active ? "Active" : "Deactivated"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 6. FINANCE, P&L & DATE-RANGE CHARTS */}
        {tab === "finance" && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-4 bg-slate-900 border border-slate-800 p-4 rounded-2xl">
              <div>
                <h1 className="text-xl font-bold">Finance workspace</h1>
                <p className="text-xs text-slate-400">Track cash flow, profit, collections, expenses, and the complete shop ledger.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {[
                  ["month", "This month"],
                  ["year", "This year"],
                  ["all", "All time"]
                ].map(([period, label]) => (
                  <button key={period} onClick={() => setFinancePeriod(period)} className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold">
                    {label}
                  </button>
                ))}
                <button onClick={() => downloadFinanceExport("csv").catch(error => alert(error.message))} className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-semibold">
                  Export CSV
                </button>
                <button onClick={() => downloadFinanceExport("pdf").catch(error => alert(error.message))} className="px-3 py-2 rounded-lg bg-indigo-600 text-white text-xs font-semibold">
                  Export PDF
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white p-4">
              <span className="text-xs font-semibold text-slate-600">Custom period</span>
              <input aria-label="Finance start date" type="date" value={dateRange.start} onChange={e => setDateRange({ ...dateRange, start: e.target.value })} className="px-3 py-2 rounded-lg text-xs" />
              <span className="text-xs text-slate-500">to</span>
              <input aria-label="Finance end date" type="date" value={dateRange.end} onChange={e => setDateRange({ ...dateRange, end: e.target.value })} className="px-3 py-2 rounded-lg text-xs" />
              <span className="ml-auto text-xs text-slate-500">{finance.transactions.length} ledger entries in this period</span>
            </div>

            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              {[
                ["Income", finance.summary.total_income, "text-emerald-700", "bg-emerald-50"],
                ["Expenses", finance.summary.total_expense, "text-rose-700", "bg-rose-50"],
                ["Net profit", finance.summary.net_profit, finance.summary.net_profit >= 0 ? "text-blue-700" : "text-rose-700", "bg-blue-50"],
                ["Receivables", finance.summary.pending_payments, "text-amber-700", "bg-amber-50"],
                ["Orders", finance.summary.total_orders, "text-slate-700", "bg-slate-100"]
              ].map(([label, value, color, bg]) => (
                <div key={label} className={`rounded-2xl p-4 ${bg}`}>
                  <p className="text-xs font-semibold text-slate-600">{label}</p>
                  <p className={`mt-1 text-2xl font-bold ${color}`}>{label === "Orders" ? value : `₹${Number(value).toLocaleString()}`}</p>
                </div>
              ))}
            </div>

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
                <h2 className="font-semibold text-sm mb-3">Monthly / Yearly Profit & Loss Trend</h2>
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

            <div className="grid gap-6 md:grid-cols-2">
              {[
                ["Income by category", finance.income_by_category || [], "text-emerald-700"],
                ["Expenses by category", finance.expense_by_category || [], "text-rose-700"]
              ].map(([title, items, color]) => (
                <div key={title} className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
                  <h3 className="font-semibold text-sm mb-3">{title}</h3>
                  {items.length === 0 ? <p className="text-sm text-slate-500">No entries in this period.</p> : (
                    <div className="space-y-2">
                      {items.slice(0, 6).map(item => (
                        <div key={item.category} className="flex items-center justify-between gap-3 text-sm">
                          <span className="truncate">{item.category}</span>
                          <span className={`font-semibold ${color}`}>₹{Number(item.amount).toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="grid md:grid-cols-3 gap-6">
              <form
                onSubmit={async e => {
                  e.preventDefault();
                  await apiFetch(`${API}/transactions`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ...newTx, amount: Number(newTx.amount) })
                  });
                  setNewTx({ ...newTx, description: "", amount: "" });
                  loadAll();
                }}
                className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-3 h-fit"
              >
                <h3 className="font-bold text-sm">+ Record Expense / Extra Income</h3>
                <label className="block text-xs font-medium text-slate-500" htmlFor="transaction-type">Entry type</label>
                <select id="transaction-type" value={newTx.type} onChange={e => setNewTx({ ...newTx, type: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm">
                  <option value="EXPENSE">DEBIT (Expense Out)</option>
                  <option value="INCOME">CREDIT (Manual Income In)</option>
                </select>
                <label className="block text-xs font-medium text-slate-500" htmlFor="transaction-date">Entry date</label>
                <input id="transaction-date" type="date" value={newTx.date} onChange={e => setNewTx({ ...newTx, date: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
                <input required placeholder="Category (Thread, Zari, Rent, Electricity)" value={newTx.category} onChange={e => setNewTx({ ...newTx, category: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
                <input required type="number" placeholder="Amount (₹)" value={newTx.amount} onChange={e => setNewTx({ ...newTx, amount: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
                <input placeholder="Description / Bill Ref" value={newTx.description} onChange={e => setNewTx({ ...newTx, description: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
                <button className="w-full py-2.5 rounded-xl bg-indigo-600 font-semibold text-sm">Add Entry</button>
              </form>

              <div className="md:col-span-2 bg-slate-900 border border-slate-800 p-5 rounded-2xl overflow-x-auto">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-bold text-sm">Credit & Debit Ledger</h3>
                  <div className="flex gap-2">
                    <select aria-label="Filter transactions by type" value={transactionFilter.type} onChange={e => setTransactionFilter({ ...transactionFilter, type: e.target.value })} className="px-2 py-1.5 rounded-lg text-xs">
                      <option value="ALL">All types</option>
                      <option value="INCOME">Income only</option>
                      <option value="EXPENSE">Expenses only</option>
                    </select>
                    <input aria-label="Search transactions" placeholder="Search ledger" value={transactionFilter.search} onChange={e => setTransactionFilter({ ...transactionFilter, search: e.target.value })} className="w-36 px-2 py-1.5 rounded-lg text-xs" />
                  </div>
                </div>
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="py-2">Date</th>
                      <th>Category</th>
                      <th>Description</th>
                      <th>Credit (+)</th>
                      <th>Debit (-)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {finance.transactions.filter(t => (
                      (transactionFilter.type === "ALL" || t.type === transactionFilter.type) &&
                      `${t.category} ${t.description} ${t.payment_method}`.toLowerCase().includes(transactionFilter.search.toLowerCase())
                    )).map(t => (
                      <tr key={t.id}>
                        <td className="py-2.5 text-xs">{t.date}</td>
                        <td className="font-medium">{t.category}</td>
                        <td className="text-xs text-slate-400">{t.description}</td>
                        <td className="text-emerald-400 font-semibold">{t.type === "INCOME" ? `+₹${t.amount}` : "-"}</td>
                        <td className="text-rose-400 font-semibold">{t.type === "EXPENSE" ? `-₹${t.amount}` : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
        </div>
      </main>
    </div>
  );
}
