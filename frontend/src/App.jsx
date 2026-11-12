import React, { Suspense, useState, useEffect, useRef, useMemo } from 'react';
import {
  LayoutDashboard, Users, Scissors, FilePlus2, Receipt, Wallet,
  Download, MessageCircle, Plus, CheckCircle2, DatabaseBackup, LogOut,
  Search, Bell, Clock3, ClipboardCheck, Palette, Package, ChevronRight,
  FileUp, Trash2, Pencil, X, Home, Menu, Phone, Loader2, AlertTriangle,
  CircleDollarSign, Settings, RotateCcw, Cloud, ArrowLeft, ArrowRight,
  Check, CalendarDays, UserPlus, FileText, TrendingUp, Ruler, Filter,
  RefreshCw, ChevronDown, MoreVertical, MapPin, Percent
} from 'lucide-react';
const VoiceAssistantPanel = React.lazy(() => import('./VoiceAssistantPanel.jsx'));
const FinanceCharts = React.lazy(() => import('./FinanceCharts.jsx'));

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

const rawHashRoute = (hash = window.location.hash) => (
  String(hash || "").replace(/^#\/?/, "").trim()
);

// Shared, unit-tested mobile helpers (single source of truth for the mobile shell).
import {
  BOTTOM_NAV_ITEMS,
  MOBILE_MAX_WIDTH,
  VALID_TABS,
  businessToday,
  customerOrders,
  filterMobileCustomers,
  filterMobileOrders,
  financeBarDays,
  financeBarMax,
  money,
  mobileGreeting,
  mobileScreenTitle,
  orderDueSoon,
  orderOverdue,
  ordersWithBalance,
  readTabFromHash,
  shortDate,
  statusLabel,
  statusTone,
  validateOrderStep,
  validatePaymentAmount,
  validateReferenceImage,
} from "./mobile/mobileHelpers.js";

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => (
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false
  ));
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const media = window.matchMedia(query);
    const onChange = (event) => setMatches(event.matches);
    setMatches(media.matches);
    if (media.addEventListener) media.addEventListener("change", onChange);
    else media.addListener(onChange);
    return () => {
      if (media.removeEventListener) media.removeEventListener("change", onChange);
      else media.removeListener(onChange);
    };
  }, [query]);
  return matches;
}

export default function App() {
  const isMobile = useMediaQuery(`(max-width: ${MOBILE_MAX_WIDTH}px)`);
  const [token, setToken] = useState(localStorage.getItem("emb_token") || "");
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });
  const [loginErr, setLoginErr] = useState("");
  const [tab, setTab] = useState(() => readTabFromHash(window.location.hash));
  const [notFoundRoute, setNotFoundRoute] = useState(() => {
    const raw = rawHashRoute();
    return raw && !VALID_TABS.includes(raw) ? raw : "";
  });
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingSlow, setLoadingSlow] = useState(false);
  const [toast, setToast] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const confirmResolver = useRef(null);

  // Mobile-only navigation and sheet state. Desktop never renders these.
  const [mobileOrderStep, setMobileOrderStep] = useState(() => {
    const savedDraft = localStorage.getItem("lalithas_order_draft");
    if (!savedDraft) return 1;
    const savedStep = Number(localStorage.getItem("lalithas_order_step"));
    return Number.isInteger(savedStep) && savedStep >= 1 && savedStep <= 6 ? savedStep : 1;
  });
  const [mobileOrderOpenId, setMobileOrderOpenId] = useState(null);
  const [mobileCustomerOpen, setMobileCustomerOpen] = useState(null);
  const [mobileCustomerFormOpen, setMobileCustomerFormOpen] = useState(false);
  const [mobileCustomerQuery, setMobileCustomerQuery] = useState("");
  const [mobileRateEdit, setMobileRateEdit] = useState(null);
  const [mobileProductTab, setMobileProductTab] = useState("products");
  const [mobileStepError, setMobileStepError] = useState("");
  const [mobileShowExpenseForm, setMobileShowExpenseForm] = useState(false);
  const [mobileShowAddProduct, setMobileShowAddProduct] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const [paymentTarget, setPaymentTarget] = useState(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("Cash/UPI");
  const [paymentNote, setPaymentNote] = useState("");
  const [paymentError, setPaymentError] = useState("");
  const [paymentBusy, setPaymentBusy] = useState(false);

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
      partially_paid_orders: 0, unpaid_orders: 0, pending_payments: 0,
      today_sales: 0, today_collection: 0
    },
    daily_chart: [],
    monthly_chart: [],
    transactions: []
  });

  // Filters
  const [dateRange, setDateRange] = useState({ start: "", end: "" });
  const [financePeriod, setFinancePeriodState] = useState("all");
  const [custSearch, setCustSearch] = useState("");
  const [transactionFilter, setTransactionFilter] = useState({ type: "ALL", search: "" });
  const [orderFilter, setOrderFilter] = useState({ search: "", status: "ALL" });

  // Forms
  const [newCust, setNewCust] = useState({ name: "", phone: "", alternate_phone: "", address: "", city: "Madurai", notes: "" });
  const [custFeedback, setCustFeedback] = useState(null);
  const [editingCustomer, setEditingCustomer] = useState(null);
  const editCustomerNameRef = useRef(null);
  const [editCust, setEditCust] = useState({ name: "", phone: "", alternate_phone: "", address: "", city: "Madurai", notes: "" });
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [editCustError, setEditCustError] = useState("");
  const [newProd, setNewProd] = useState({ name: "", pricing_type: "MANUAL", base_price: 500, measurement_template_id: "" });
  const [productFeedback, setProductFeedback] = useState(null);
  const [newTmpl, setNewTmpl] = useState({ name: "", fieldsCSV: "Bust, Waist, Shoulder, Sleeve Length" });
  const [txFeedback, setTxFeedback] = useState(null);
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
      localStorage.removeItem("lalithas_order_step");
      setToken("");
    }
  };

  // Tab state is mirrored into the URL hash so refresh / deep links keep the page.
  useEffect(() => {
    if (notFoundRoute) return;
    const next = `#/${tab}`;
    if (window.location.hash !== next) window.history.replaceState(null, "", next);
  }, [notFoundRoute, tab]);

  useEffect(() => {
    const onHashChange = () => {
      const raw = rawHashRoute(window.location.hash);
      const next = readTabFromHash(window.location.hash);
      setNotFoundRoute(raw && !VALID_TABS.includes(raw) ? raw : "");
      setTab(previous => (previous === next ? previous : next));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  // Keep floating UI (assistant, toast) above the on-screen keyboard on phones.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const apply = () => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty("--keyboard-inset", `${Math.round(inset)}px`);
    };
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    apply();
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      document.documentElement.style.removeProperty("--keyboard-inset");
    };
  }, []);

  const notify = (text, type = "success") => setToast({ text, type, id: Date.now() });

  const askConfirm = ({ title, message, confirmLabel = "Delete", danger = true }) => (
    new Promise(resolve => {
      confirmResolver.current = resolve;
      setConfirmState({ title, message, confirmLabel, danger });
    })
  );

  const resolveConfirm = (value) => {
    const resolver = confirmResolver.current;
    confirmResolver.current = null;
    setConfirmState(null);
    if (resolver) resolver(value);
  };

  const openPayment = (order) => {
    setPaymentTarget(order);
    setPaymentAmount(String(order.balance));
    setPaymentError("");
  };

  const closePayment = () => {
    if (paymentBusy) return;
    setPaymentTarget(null);
    setPaymentError("");
  };

  const submitPayment = async () => {
    const order = paymentTarget;
    if (!order || paymentBusy) return;
    const amount = Number(paymentAmount);
    const paymentProblem = validatePaymentAmount(amount, order.balance);
    if (paymentProblem) {
      setPaymentError(paymentProblem);
      return;
    }
    setPaymentBusy(true);
    setPaymentError("");
    const paymentKey = paymentRequestKeys.current[order.id] || newIdempotencyKey();
    paymentRequestKeys.current[order.id] = paymentKey;
    try {
      const response = await apiFetch(`${API}/orders/${order.id}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ additional_paid: amount, idempotency_key: paymentKey })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || "Payment could not be recorded.");
      delete paymentRequestKeys.current[order.id];
      setPaymentTarget(null);
      notify(`${money(amount)} collected for ${order.invoice_number}.`);
      await loadAll();
    } catch (error) {
      setPaymentError(error.message || "Payment could not be recorded. Please retry.");
    } finally {
      setPaymentBusy(false);
    }
  };

  const createMobileCustomer = async (event) => {
    event?.preventDefault?.();
    if (savingCustomer) return;
    setSavingCustomer(true);
    setCustFeedback(null);
    try {
      const response = await apiFetch(`${API}/customers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newCust,
          name: newCust.name.trim(),
          phone: newCust.phone.trim(),
          alternate_phone: newCust.alternate_phone.trim(),
        })
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
      setCustFeedback({ type: "success", text: `Saved ${result.name || "customer"} successfully.` });
      setMobileCustomerFormOpen(false);
      notify(`${result.name || "Customer"} added.`);
      await loadAll("customers");
    } catch (error) {
      setCustFeedback({ type: "error", text: error.message || "Customer could not be saved." });
    } finally {
      setSavingCustomer(false);
    }
  };

  const resetOrderForm = () => setOrderForm({
    customer_id: "", product_id: "", order_date: new Date().toISOString().slice(0, 10),
    delivery_date: "", description: "", embroidery_category: "Business Customer", stitch_count: 25000,
    base_amount: 0, extra_amount: 0, paid_amount: 0, measurements: {}, idempotency_key: newIdempotencyKey()
  });

  const mobileStepProblem = (step = mobileOrderStep) => validateOrderStep(step, {
    orderForm,
    selectedProduct,
    selectedTemplate,
    total: calculateOrderTotal(),
  });

  const goToMobileOrderStep = (nextStep) => {
    if (nextStep > mobileOrderStep) {
      for (let step = mobileOrderStep; step < nextStep; step += 1) {
        const problem = mobileStepProblem(step);
        if (problem) {
          setMobileStepError(problem);
          return;
        }
      }
    }
    setMobileStepError("");
    setMobileOrderStep(nextStep);
  };

  const submitMobileOrder = async () => {
    if (savingOrder) return;
    for (let step = 1; step <= 5; step += 1) {
      const problem = mobileStepProblem(step);
      if (problem) {
        setMobileStepError(problem);
        setMobileOrderStep(step);
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
    setSavingOrder(true);
    setMobileStepError("");
    try {
      const response = await apiFetch(`${API}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const created = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(created.detail || "Order could not be saved.");
      localStorage.removeItem("lalithas_order_draft");
      localStorage.removeItem("lalithas_order_step");
      const image = referenceImage;
      resetOrderForm();
      setMobileOrderStep(1);
      setTab("invoices");
      setMobileOrderOpenId(created.id || null);
      notify(`Order ${created.invoice_number || ""} saved.`.trim());
      if (referencePreview) URL.revokeObjectURL(referencePreview);
      setReferenceImage(null);
      setReferencePreview("");
      await loadAll("invoices");
      if (image) openInvoicePdf(created.id, null, image);
    } catch (error) {
      setMobileStepError(error.message || "Order could not be saved. Please retry.");
    } finally {
      setSavingOrder(false);
    }
  };

  const createProductRecord = async (event) => {
    event?.preventDefault?.();
    setProductFeedback(null);
    try {
      const response = await apiFetch(`${API}/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newProd,
          base_price: Number(newProd.base_price),
          measurement_template_id: newProd.measurement_template_id ? Number(newProd.measurement_template_id) : null
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || "Product could not be saved.");
      setNewProd({ name: "", pricing_type: "MANUAL", base_price: 500, measurement_template_id: "" });
      setProductFeedback({ type: "success", text: `Product ${body.name || ""} added.`.trim() });
      setMobileShowAddProduct(false);
      notify(`Product ${body.name || ""} added.`.trim());
      await loadAll("products");
    } catch (error) {
      setProductFeedback({ type: "error", text: error.message });
    }
  };

  const createTemplateRecord = async (event) => {
    event?.preventDefault?.();
    setProductFeedback(null);
    try {
      const fields = newTmpl.fieldsCSV.split(",").map(field => field.trim()).filter(Boolean);
      if (fields.length === 0) throw new Error("Add at least one measurement field.");
      const response = await apiFetch(`${API}/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTmpl.name, fields })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || "Template could not be saved.");
      setNewTmpl({ name: "", fieldsCSV: "" });
      setProductFeedback({ type: "success", text: `Measurement template ${body.name || ""} created.`.trim() });
      notify("Measurement template saved.");
      await loadAll("products");
    } catch (error) {
      setProductFeedback({ type: "error", text: error.message });
    }
  };

  const createTransactionRecord = async (event) => {
    event?.preventDefault?.();
    setTxFeedback(null);
    try {
      const response = await apiFetch(`${API}/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...newTx, amount: Number(newTx.amount) })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || "Entry could not be saved.");
      setNewTx({ ...newTx, description: "", amount: "" });
      setTxFeedback({ type: "success", text: "Ledger entry saved." });
      notify("Ledger entry saved.");
      setMobileShowExpenseForm(false);
      await loadAll("finance");
    } catch (error) {
      setTxFeedback({ type: "error", text: error.message });
    }
  };

  const saveRateEdit = async (event) => {
    event?.preventDefault?.();
    if (!mobileRateEdit) return;
    const numeric = Number(mobileRateEdit.value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      setProductFeedback({ type: "error", text: "Rate must be a number greater than 0." });
      return;
    }
    try {
      const response = await apiFetch(`${API}/embroidery-rates`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: mobileRateEdit.category, rate_per_stitch: numeric })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || "Rate could not be saved.");
      setProductFeedback({ type: "success", text: `${mobileRateEdit.category} rate updated to ₹${numeric} per stitch.` });
      setMobileRateEdit(null);
      notify("Rate updated.");
      await loadAll("products");
    } catch (error) {
      setProductFeedback({ type: "error", text: error.message });
    }
  };

  const createBackup = async () => {
    let objectUrl = "";
    try {
      const response = await apiFetch(`${API}/backup`, { method: "POST" });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({}));
        throw new Error(problem.detail || `Backup could not be created (HTTP ${response.status}).`);
      }
      if (!(response.headers.get("content-type") || "").includes("application/octet-stream")) {
        throw new Error("The server did not return a backup file. Please try again.");
      }
      // Read the attachment name the server chose, but fall back to a locally
      // generated, equally meaningful name if the header is missing.
      const disposition = response.headers.get("content-disposition") || "";
      const headerName = /filename="([^"]+)"/.exec(disposition)?.[1];
      const stamp = new Date().toISOString().slice(0, 19).replace("T", "_");
      const filename = headerName || `embroidery_backup_${stamp}.db`;
      const blob = await response.blob();
      if (!blob.size) throw new Error("The backup file arrived empty. Please try again.");

      // Hand the bytes to the browser's download manager, then release the URL.
      objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      notify(`Backup downloaded: ${filename} (${(blob.size / 1024).toFixed(0)} KB).`);
    } catch (error) {
      notify(error.message || "Backup could not be created.", "error");
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  };

  const createCloudBackup = async () => {
    try {
      const response = await apiFetch(`${API}/cloud-backup`, { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || "Cloud backup failed.");
      notify(`Cloud backup completed: ${result.database_object}`);
    } catch (error) {
      notify(error.message || "Cloud backup failed.", "error");
    }
  };

  const restoreBackupFile = async (file) => {
    if (!file) return;
    const confirmed = await askConfirm({
      title: "Restore this backup?",
      message: "All current customers, orders, measurements, payments, and settings will be replaced. A safety backup is created first.",
      confirmLabel: "Restore backup"
    });
    if (!confirmed) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      const response = await apiFetch(`${API}/restore`, { method: "POST", body: formData });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || "Restore failed. Current data was not changed.");
      await loadAll();
      notify(`Restore completed. ${result.restored_counts?.orders || 0} orders and ${result.restored_counts?.customers || 0} customers restored.`);
    } catch (error) {
      notify(error.message || "Restore failed. Current data was not changed.", "error");
    }
  };

  const openMobileCustomer = (customer) => {
    setMobileCustomerOpen(customer);
    setMobileCustomerQuery("");
  };

  const startMobileNewOrderForCustomer = (customer) => {
    if (!customer) return;
    handleSelectCustomerForOrder(customer.id);
    setMobileCustomerOpen(null);
    setMobileOrderStep(2);
    setMobileStepError("");
    setTab("new-order");
  };

  const uploadReferenceImage = (file, resetInput) => {
    if (!file) return;
    const imageProblem = validateReferenceImage(file);
    if (imageProblem) {
      notify(imageProblem, "error");
      if (resetInput) resetInput.value = "";
      return;
    }
    if (referencePreview) URL.revokeObjectURL(referencePreview);
    setReferenceImage(file);
    setReferencePreview(URL.createObjectURL(file));
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
      if (isMobile) notify(error.message || "Invoice PDF could not be opened.", "error");
      else alert(error.message || "Invoice PDF could not be opened.");
    }
  };

  const setFinancePeriod = (period) => {
    setFinancePeriodState(period);
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

  // Mobile-only chart slice: the last 7 days that actually have activity.
  const mobileFinanceDays = useMemo(
    () => financeBarDays(finance.daily_chart),
    [finance.daily_chart]
  );
  const mobileFinanceMax = useMemo(() => financeBarMax(mobileFinanceDays), [mobileFinanceDays]);

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

  const loadAll = async (targetTab = tab) => {
    if (!token) return;
    if (!VALID_TABS.includes(targetTab)) return;
    setLoading(true);
    setLoadingSlow(false);
    const slowTimer = window.setTimeout(() => setLoadingSlow(true), 5000);
    const requests = targetTab === "dashboard"
      ? [
        ["dashboard", `${API}/dashboard/summary`],
        ...(isMobile ? [["orders", `${API}/orders?limit=100`]] : []),
      ]
      : targetTab === "customers"
        ? [
          ["customers", `${API}/customers?q=${encodeURIComponent(custSearch)}`],
          ...(isMobile ? [["orders", `${API}/orders?limit=250`]] : []),
        ]
        : targetTab === "new-order"
          ? [
            ["customers", `${API}/customers?limit=250`],
            ["products", `${API}/products`],
            ["templates", `${API}/templates`],
            ["rates", `${API}/embroidery-rates`],
          ]
          : targetTab === "products"
            ? [
              ["products", `${API}/products`],
              ["templates", `${API}/templates`],
              ["rates", `${API}/embroidery-rates`],
            ]
            : targetTab === "payments"
              ? [
                ["orders", `${API}/orders?limit=250`],
                ["finance", `${API}/finance?start_date=${dateRange.start}&end_date=${dateRange.end}`],
              ]
              : targetTab === "more"
                ? [
                  ["dashboard", `${API}/dashboard/summary`],
                  ["orders", `${API}/orders?limit=100`],
                ]
                : targetTab === "finance"
                  ? [["finance", `${API}/finance?start_date=${dateRange.start}&end_date=${dateRange.end}`]]
                  : [["orders", `${API}/orders?limit=100`]];
    const results = await Promise.allSettled(requests.map(async ([name, url]) => {
      const response = await apiFetch(url);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`${name}: ${payload.detail || `HTTP ${response.status}`}`);
      }
      return [name, payload];
    }));

    const failures = results.filter(result => result.status === "rejected");
    setLoadError(
      failures.length
        ? "Some data could not be loaded. Check your connection and try again."
        : ""
    );
    results.forEach(result => {
      if (result.status === "rejected") {
        console.error("Could not load application data:", result.reason);
        return;
      }
      const [name, payload] = result.value;
      if (name === "dashboard") {
        if (payload?.summary) setFinance(prev => ({ ...prev, summary: payload.summary }));
        setOrders(Array.isArray(payload?.recent_orders) ? payload.recent_orders : []);
      }
      if (name === "customers") setCustomers(Array.isArray(payload) ? payload : (payload.items || []));
      if (name === "products") setProducts(Array.isArray(payload) ? payload : []);
      if (name === "templates") setTemplates(Array.isArray(payload) ? payload : []);
      if (name === "rates") setRates(Array.isArray(payload) ? payload : []);
      if (name === "orders") setOrders(Array.isArray(payload) ? payload : (payload.items || []));
      if (name === "finance" && payload?.summary) {
        setFinance(prev => ({
          ...prev,
          ...payload,
          summary: { ...prev.summary, ...payload.summary }
        }));
      }
    });
    window.clearTimeout(slowTimer);
    setLoading(false);
    setLoadingSlow(false);
  };

  const removeOrder = async (order) => {
    const confirmed = await askConfirm({
      title: `Delete ${order.invoice_number}?`,
      message: "This also removes the order's measurements and saved files. This cannot be undone.",
      confirmLabel: "Delete order"
    });
    if (!confirmed) return;
    const response = await apiFetch(`${API}/orders/${order.id}`, { method: "DELETE" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      notify(result.detail || "Order could not be deleted.", "error");
      return;
    }
    setMobileOrderOpenId(null);
    notify(`Order ${order.invoice_number} deleted.`);
    await loadAll();
  };

  const removeCustomer = async (customer) => {
    const orderMessage = customer.order_count
      ? ` This will also delete ${customer.order_count} linked order(s), measurements, and saved files.`
      : "";
    const confirmed = await askConfirm({
      title: `Delete ${customer.name}?`,
      message: `This cannot be undone.${orderMessage}`,
      confirmLabel: "Delete customer"
    });
    if (!confirmed) return;
    const response = await apiFetch(
      `${API}/customers/${customer.id}?cascade_orders=${customer.order_count > 0}`,
      { method: "DELETE" }
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      notify(result.detail || "Customer could not be deleted.", "error");
      return;
    }
    notify(`${customer.name} deleted.`);
    setMobileCustomerOpen(null);
    await loadAll("customers");
  };

  const startEditCustomer = (customer) => {
    setEditCustError("");
    setEditingCustomer(customer);
    setEditCust({
      name: customer.name || "",
      phone: customer.phone || "",
      alternate_phone: customer.alternate_phone || "",
      address: customer.address || "",
      city: customer.city || "Madurai",
      notes: customer.notes || "",
    });
  };

  const saveCustomerEdit = async (e) => {
    e.preventDefault();
    if (!editingCustomer || savingCustomer) return;
    setSavingCustomer(true);
    try {
      const response = await apiFetch(`${API}/customers/${editingCustomer.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editCust),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) {
          logout();
          throw new Error("Your session expired. Please log in again.");
        }
        throw new Error(result.detail || "Customer could not be updated.");
      }
      setEditingCustomer(null);
      setMobileCustomerFormOpen(false);
      setCustFeedback({ type: "success", text: "Customer updated successfully." });
      notify("Customer updated.");
      await loadAll();
    } catch (error) {
      setEditCustError(error.message || "Customer could not be updated. Check that the backend is running.");
    } finally {
      setSavingCustomer(false);
    }
  };

  useEffect(() => {
    const timeout = window.setTimeout(() => loadAll(), custSearch ? 300 : 0);
    return () => window.clearTimeout(timeout);
  }, [token, custSearch, dateRange, tab]);

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

  // Remember which wizard step the draft was left on so a reload continues there.
  useEffect(() => {
    if (tab !== "new-order") return;
    if (mobileOrderStep > 1) localStorage.setItem("lalithas_order_step", String(mobileOrderStep));
    else localStorage.removeItem("lalithas_order_step");
  }, [mobileOrderStep, tab]);

  useEffect(() => {
    if (!editingCustomer) return undefined;
    editCustomerNameRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") setEditingCustomer(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editingCustomer]);

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
      setLoginErr("Cannot reach the server. Check your internet connection and try again.");
    }
  };

  // --- ORDER HELPERS ---
  const selectedProduct = products.find(p => String(p.id) === String(orderForm.product_id));
  const selectedTemplate = templates.find(t => t.id === selectedProduct?.measurement_template_id);
  const currentRateObj = rates.find(r => r.category === orderForm.embroidery_category);
  const currentStitchRate = currentRateObj ? currentRateObj.rate_per_stitch : 0.05;
  // These four tiles come from the server-side payment summary, so the numbers
  // always match the order ledger instead of a single page of recent orders.
  const productionStages = [
    { label: "Unpaid", value: finance.summary.unpaid_orders, icon: ClipboardCheck, color: "text-amber-500", bg: "bg-amber-50" },
    { label: "Partially paid", value: finance.summary.partially_paid_orders, icon: Clock3, color: "text-blue-600", bg: "bg-blue-50" },
    { label: "Paid in full", value: finance.summary.paid_orders, icon: CheckCircle2, color: "text-emerald-600", bg: "bg-emerald-50" },
    { label: "All orders", value: finance.summary.total_orders, icon: Package, color: "text-violet-600", bg: "bg-violet-50" }
  ];

  const filteredOrders = useMemo(() => {
    const term = orderFilter.search.trim().toLowerCase();
    return orders.filter(order => {
      if (orderFilter.status !== "ALL" && (order.status || "Pending") !== orderFilter.status) return false;
      if (!term) return true;
      return [
        order.invoice_number,
        order.customer_name,
        order.customer_phone,
        order.product_name,
      ]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(term));
    });
  }, [orders, orderFilter]);

  // Mobile-only derived lists. Desktop keeps using filteredOrders above.
  const mobileOrderResults = useMemo(
    () => filterMobileOrders(orders, orderFilter, businessToday()),
    [orders, orderFilter]
  );

  const mobileCustomerResults = useMemo(
    () => filterMobileCustomers(customers, mobileCustomerQuery),
    [customers, mobileCustomerQuery]
  );

  const mobileOpenOrder = mobileOrderOpenId
    ? orders.find(order => String(order.id) === String(mobileOrderOpenId))
    : null;

  const mobileCustomerOrders = customerOrders(orders, mobileCustomerOpen);

  const mobileBalanceOrders = ordersWithBalance(orders);
  const mobileCollectedToday = Number(finance.summary.today_collection || 0);
  const mobileOverdueOrders = orders.filter(orderOverdue);
  const mobileDueSoonOrders = orders.filter(orderDueSoon);
  const mobileGreetingText = mobileGreeting();
  const mobileScreenHeading = mobileScreenTitle(tab);

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
      localStorage.removeItem("lalithas_order_step");
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
              <img src="/lalithas-apparel-logo.webp" alt="Lalitha's Apparel logo" width="64" height="64" className="h-16 w-16 object-cover" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">Lalitha&apos;s Apparel</h1>
              <p className="text-xs text-slate-400">Embroidery, tailoring & boutique management</p>
            </div>
          </div>
          {loginErr && (
            <div role="alert" aria-live="polite" className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs">
              {loginErr}
            </div>
          )}
          <label htmlFor="login-username" className="block text-xs font-medium text-slate-400 mb-1">Admin Username</label>
          <input
            id="login-username"
            name="username"
            required
            autoFocus
            autoComplete="username"
            placeholder="Enter admin username"
            value={loginForm.username}
            onChange={e => setLoginForm({ ...loginForm, username: e.target.value })}
            className="w-full mb-4 px-3 py-2.5 rounded-lg bg-slate-950 border border-slate-800 text-white"
          />
          <label htmlFor="login-password" className="block text-xs font-medium text-slate-400 mb-1">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            required
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

  if (notFoundRoute) {
    return <NotFoundPage onHome={() => { setNotFoundRoute(""); setTab("dashboard"); }} />;
  }

  // --- MOBILE SHELL (max-width: 767px only) ---
  // The desktop JSX below is intentionally untouched. This branch renders a
  // dedicated phone experience using the same state, APIs and business rules.
  if (isMobile) {
    return (
      <div className="mobile-app">
        <header className="mobile-header">
          <button type="button" className="mobile-brand" onClick={() => setTab("dashboard")} aria-label="Go to home">
            <img src="/lalithas-apparel-logo.webp" alt="" width="36" height="36" />
            <span className="min-w-0">
              <strong>Lalitha&apos;s Apparel</strong>
              <small>{mobileScreenHeading}</small>
            </span>
          </button>
          <div className="mobile-header-actions">
            <button
              type="button"
              className="mobile-icon-button"
              onClick={() => setTab("invoices")}
              aria-label={finance.summary.pending_orders > 0 ? `${finance.summary.pending_orders} orders with a balance due` : "View orders"}
            >
              <Bell size={20} />
              {finance.summary.pending_orders > 0 && <span className="mobile-notification-dot" />}
            </button>
            <button type="button" className="mobile-avatar-button" onClick={() => setTab("more")} aria-label="Open account and more options">
              A
            </button>
          </div>
        </header>

        <div className="mobile-main" role="main">
          {loadError && (
            <div className="mobile-banner mobile-banner-warning" role="alert">
              <span>{loadError}</span>
              <button type="button" onClick={() => loadAll()}>Retry</button>
            </div>
          )}

          {/* MOBILE / HOME DASHBOARD */}
          {tab === "dashboard" && (
            <div className="mobile-screen">
              <section className="mobile-hero">
                <p className="mobile-eyebrow">
                  {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}
                </p>
                <h1>{mobileGreetingText}, Admin</h1>
                <p>Here is how your shop is doing today.</p>
              </section>

              {loading && orders.length === 0 && (
                <MobileLoading
                  label={loadingSlow ? "This is taking a little longer than usual…" : "Preparing today’s summary…"}
                />
              )}

              <div className="mobile-metric-grid">
                <MobileMetric Icon={TrendingUp} label="Today's sales" value={money(finance.summary.today_sales)} hint="Order value booked today" />
                <MobileMetric Icon={CircleDollarSign} label="Today's collection" value={money(finance.summary.today_collection)} hint="Payments received today" />
                <MobileMetric Icon={Clock3} label="Pending orders" value={String(finance.summary.pending_orders || 0)} hint="Still have a balance" />
                <MobileMetric Icon={Wallet} label="Outstanding" value={money(finance.summary.pending_payments)} hint="Total from customers" />
              </div>

              <section className="mobile-section">
                <div className="mobile-section-head">
                  <h2>Quick actions</h2>
                </div>
                <div className="mobile-quick-grid">
                  <button type="button" onClick={() => { setCustFeedback(null); setMobileCustomerFormOpen(true); setTab("customers"); }}>
                    <UserPlus size={20} /><span>Add customer</span>
                  </button>
                  <button type="button" onClick={() => { setMobileStepError(""); setTab("new-order"); }}>
                    <FilePlus2 size={20} /><span>New order</span>
                  </button>
                  <button type="button" onClick={() => setTab("payments")}>
                    <Wallet size={20} /><span>Collect payment</span>
                  </button>
                  <button type="button" onClick={() => setTab("invoices")}>
                    <Receipt size={20} /><span>Orders</span>
                  </button>
                  <button type="button" onClick={() => setTab("invoices")}>
                    <FileText size={20} /><span>Invoices</span>
                  </button>
                </div>
              </section>

              {(mobileOverdueOrders.length > 0 || mobileDueSoonOrders.length > 0 || mobileBalanceOrders.length > 0) && (
                <section className="mobile-section">
                  <div className="mobile-section-head">
                    <h2>Needs attention</h2>
                  </div>
                  <div className="mobile-alert-list">
                    {mobileOverdueOrders.length > 0 && (
                      <button type="button" className="mobile-alert is-danger" onClick={() => setTab("invoices")}>
                        <AlertTriangle size={18} />
                        <span><strong>{mobileOverdueOrders.length} overdue order{mobileOverdueOrders.length === 1 ? "" : "s"}</strong><small>Delivery date passed and balance is still due</small></span>
                        <ChevronRight size={18} />
                      </button>
                    )}
                    {mobileDueSoonOrders.length > 0 && (
                      <button type="button" className="mobile-alert is-warning" onClick={() => setTab("invoices")}>
                        <CalendarDays size={18} />
                        <span><strong>{mobileDueSoonOrders.length} due this week</strong><small>Check stitching and delivery dates</small></span>
                        <ChevronRight size={18} />
                      </button>
                    )}
                    {mobileBalanceOrders.length > 0 && (
                      <button type="button" className="mobile-alert is-info" onClick={() => setTab("payments")}>
                        <Wallet size={18} />
                        <span><strong>{mobileBalanceOrders.length} unpaid balance{mobileBalanceOrders.length === 1 ? "" : "s"}</strong><small>{money(finance.summary.pending_payments)} still to collect</small></span>
                        <ChevronRight size={18} />
                      </button>
                    )}
                  </div>
                </section>
              )}

              <section className="mobile-section">
                <div className="mobile-section-head">
                  <h2>Recent orders</h2>
                  <button type="button" className="mobile-link-button" onClick={() => setTab("invoices")}>View all</button>
                </div>
                {orders.length === 0 ? (
                  <MobileEmptyState
                    Icon={Receipt}
                    title={loading ? "Loading orders…" : "No orders yet"}
                    text={loading ? "Please wait a moment." : "Create your first order to see it here."}
                    actionLabel={loading ? "" : "New order"}
                    onAction={() => setTab("new-order")}
                  />
                ) : (
                  <div className="mobile-card-list">
                    {orders.slice(0, 5).map(order => (
                      <MobileOrderCard key={order.id} order={order} onOpen={item => setMobileOrderOpenId(item.id)} onPay={openPayment} />
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* MOBILE / ORDERS + INVOICES */}
          {tab === "invoices" && (
            <div className="mobile-screen">
              <div className="mobile-screen-head">
                <div>
                  <h1>Orders</h1>
                  <p>Search, filter and open any order.</p>
                </div>
                <button type="button" className="mobile-primary-button mobile-compact-button" onClick={() => { setMobileStepError(""); setTab("new-order"); }}>
                  <Plus size={18} /> New
                </button>
              </div>

              <div className="mobile-search-box">
                <Search size={18} />
                <input
                  type="search"
                  value={orderFilter.search}
                  onChange={event => setOrderFilter(previous => ({ ...previous, search: event.target.value }))}
                  placeholder="Search invoice, customer or phone"
                  aria-label="Search orders"
                />
              </div>
              <div className="mobile-chip-row" role="group" aria-label="Filter orders by status">
                {[
                  ["ALL", "All"],
                  ["Pending", "Pending"],
                  ["Partially Paid", "Part paid"],
                  ["Paid", "Paid"],
                  ["OVERDUE", "Overdue"]
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`mobile-chip ${orderFilter.status === value ? "is-active" : ""}`}
                    aria-pressed={orderFilter.status === value}
                    onClick={() => setOrderFilter(previous => ({ ...previous, status: value }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mobile-count">{mobileOrderResults.length} of {orders.length} order(s)</p>

              {loading && orders.length === 0 ? (
                <MobileLoading label={loadingSlow ? "Orders are taking a little longer to arrive…" : "Preparing your orders…"} />
              ) : mobileOrderResults.length === 0 ? (
                <MobileEmptyState
                  Icon={orders.length === 0 ? Receipt : Search}
                  title={orders.length === 0 ? "No orders yet" : "No orders match"}
                  text={orders.length === 0 ? "Create your first order to generate an invoice." : "Try another search or clear the filter."}
                  actionLabel={orders.length === 0 ? "Create an order" : "Clear filters"}
                  onAction={() => {
                    if (orders.length === 0) setTab("new-order");
                    else setOrderFilter({ search: "", status: "ALL" });
                  }}
                />
              ) : (
                <div className="mobile-card-list">
                  {mobileOrderResults.map(order => (
                    <MobileOrderCard key={order.id} order={order} onOpen={item => setMobileOrderOpenId(item.id)} onPay={openPayment} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* MOBILE / CUSTOMERS */}
          {tab === "customers" && (
            <div className="mobile-screen">
              <div className="mobile-screen-head">
                <div>
                  <h1>Customers</h1>
                  <p>Find a customer, call them, or update details.</p>
                </div>
                <button
                  type="button"
                  className="mobile-primary-button mobile-compact-button"
                  onClick={() => { setCustFeedback(null); setMobileCustomerFormOpen(true); }}
                >
                  <UserPlus size={18} /> Add
                </button>
              </div>

              <div className="mobile-search-box">
                <Search size={18} />
                <input
                  type="search"
                  value={mobileCustomerQuery}
                  onChange={event => setMobileCustomerQuery(event.target.value)}
                  placeholder="Search name, phone or customer code"
                  aria-label="Search customers"
                />
              </div>
              <p className="mobile-count">{mobileCustomerResults.length} customer(s)</p>

              {loading && customers.length === 0 ? (
                <MobileLoading label={loadingSlow ? "Customers are taking a little longer to arrive…" : "Preparing your customers…"} />
              ) : mobileCustomerResults.length === 0 ? (
                <MobileEmptyState
                  Icon={customers.length === 0 ? Users : Search}
                  title={customers.length === 0 ? "No customers yet" : "No customers found"}
                  text={customers.length === 0 ? "Add your first customer to start taking orders." : "Try a different name or phone number."}
                  actionLabel={customers.length === 0 ? "Add customer" : ""}
                  onAction={() => { setCustFeedback(null); setMobileCustomerFormOpen(true); }}
                />
              ) : (
                <div className="mobile-card-list">
                  {mobileCustomerResults.map(customer => (
                    <MobileCustomerCard
                      key={customer.id}
                      customer={customer}
                      onOpen={item => openMobileCustomer(item)}
                      onCall={phone => { window.location.href = `tel:${String(phone || "").replace(/[^\d+]/g, "")}`; }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* MOBILE / PAYMENTS */}
          {tab === "payments" && (
            <div className="mobile-screen">
              <div className="mobile-screen-head">
                <div>
                  <h1>Payments</h1>
                  <p>Collect balances and review recent collections.</p>
                </div>
              </div>

              <div className="mobile-metric-grid">
                <MobileMetric Icon={CircleDollarSign} label="Today's collection" value={money(mobileCollectedToday)} hint="Payments received today" />
                <MobileMetric Icon={Wallet} label="Outstanding" value={money(finance.summary.pending_payments)} hint={`${mobileBalanceOrders.length} order(s) with balance`} />
              </div>

              <section className="mobile-section">
                <div className="mobile-section-head">
                  <h2>Balance due</h2>
                  <span className="mobile-count">{mobileBalanceOrders.length}</span>
                </div>
                {loading && orders.length === 0 ? (
                  <MobileLoading label="Loading outstanding orders…" />
                ) : mobileBalanceOrders.length === 0 ? (
                  <MobileEmptyState Icon={CheckCircle2} title="All payments collected" text="No order currently has an outstanding balance." />
                ) : (
                  <div className="mobile-card-list">
                    {mobileBalanceOrders.map(order => (
                      <MobileOrderCard key={order.id} order={order} onOpen={item => setMobileOrderOpenId(item.id)} onPay={openPayment} />
                    ))}
                  </div>
                )}
              </section>

              <section className="mobile-section">
                <div className="mobile-section-head">
                  <h2>Recent collections</h2>
                </div>
                {(() => {
                  const collected = (finance.transactions || [])
                    .filter(transaction => transaction.type === "INCOME" && ["Order Payment", "Balance Collection"].includes(transaction.category))
                    .slice(0, 10);
                  if (!collected.length) {
                    return <MobileEmptyState Icon={Receipt} title="No collections yet" text="Payments collected against orders will appear here." />;
                  }
                  return (
                    <div className="mobile-card-list">
                      {collected.map(transaction => (
                        <div key={transaction.id} className="mobile-list-card">
                          <div className="min-w-0">
                            <p className="mobile-list-title">{transaction.category}</p>
                            <p className="mobile-list-subtitle">{transaction.description}</p>
                            <p className="mobile-list-meta">{shortDate(transaction.date)} · {transaction.payment_method || "Cash/UPI"}</p>
                          </div>
                          <span className="mobile-amount positive">+{money(transaction.amount)}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </section>
            </div>
          )}

          {/* MOBILE / GUIDED NEW ORDER WIZARD */}
          {tab === "new-order" && (
            <div className="mobile-screen mobile-wizard">
              <div className="mobile-screen-head">
                <div>
                  <h1>New order</h1>
                  <p>Step {mobileOrderStep} of 6 · {draftSavedAt ? `Draft saved ${draftSavedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Draft ready"}</p>
                </div>
                <button type="button" className="mobile-ghost-button" onClick={() => setTab("dashboard")}>Cancel</button>
              </div>

              <div className="mobile-progress" aria-label={`Step ${mobileOrderStep} of 6`}>
                {[1, 2, 3, 4, 5, 6].map(step => (
                  <span key={step} className={step < mobileOrderStep ? "is-done" : step === mobileOrderStep ? "is-current" : ""} />
                ))}
              </div>
              <ol className="mobile-step-labels">
                {["Customer", "Product", "Measurements", "Design", "Price", "Review"].map((label, index) => (
                  <li key={label} className={index + 1 === mobileOrderStep ? "is-current" : index + 1 < mobileOrderStep ? "is-done" : ""}>
                    <span>{index + 1}</span>{label}
                  </li>
                ))}
              </ol>

              {mobileStepError && (
                <div className="mobile-banner mobile-banner-danger" role="alert">
                  <AlertTriangle size={17} />
                  <span>{mobileStepError}</span>
                </div>
              )}

              {mobileOrderStep === 1 && (
                <section className="mobile-form-card">
                  <h2>Who is this order for?</h2>
                  <p className="mobile-help">Search an existing customer or add a new one.</p>
                  <div className="mobile-search-box">
                    <Search size={18} />
                    <input
                      type="search"
                      value={mobileCustomerQuery}
                      onChange={event => setMobileCustomerQuery(event.target.value)}
                      placeholder="Search name or phone"
                      aria-label="Search customers for this order"
                    />
                  </div>
                  <button type="button" className="mobile-secondary-button mobile-full-button" onClick={() => { setCustFeedback(null); setMobileCustomerFormOpen(true); }}>
                    <UserPlus size={18} /> Add a new customer
                  </button>
                  <div className="mobile-card-list mobile-select-list">
                    {mobileCustomerResults.slice(0, 30).map(customer => {
                      const selected = String(orderForm.customer_id) === String(customer.id);
                      return (
                        <button
                          key={customer.id}
                          type="button"
                          className={`mobile-select-card ${selected ? "is-selected" : ""}`}
                          onClick={() => handleSelectCustomerForOrder(customer.id)}
                          aria-pressed={selected}
                        >
                          <span className="min-w-0">
                            <strong>{customer.name}</strong>
                            <small>{customer.phone}{customer.city ? ` · ${customer.city}` : ""}</small>
                          </span>
                          {selected ? <Check size={20} /> : <ChevronRight size={18} />}
                        </button>
                      );
                    })}
                    {mobileCustomerResults.length === 0 && (
                      <p className="mobile-empty-inline">{customers.length ? "No customer matches that search." : "No customers yet. Add one above."}</p>
                    )}
                  </div>
                </section>
              )}

              {mobileOrderStep === 2 && (
                <section className="mobile-form-card">
                  <h2>What are we making?</h2>
                  <p className="mobile-help">Choose a product from your price list.</p>
                  <div className="mobile-select-list">
                    {products.filter(product => product.active).map(product => {
                      const selected = String(orderForm.product_id) === String(product.id);
                      return (
                        <button
                          key={product.id}
                          type="button"
                          className={`mobile-select-card ${selected ? "is-selected" : ""}`}
                          onClick={() => handleSelectProductForOrder(product.id)}
                          aria-pressed={selected}
                        >
                          <span className="min-w-0">
                            <strong>{product.name}</strong>
                            <small>{product.pricing_type === "STITCH_BASED" ? "Stitch-based embroidery" : money(product.base_price)}</small>
                          </span>
                          {selected ? <Check size={20} /> : <ChevronRight size={18} />}
                        </button>
                      );
                    })}
                    {products.filter(product => product.active).length === 0 && (
                      <p className="mobile-empty-inline">No active products. Add one from Products &amp; rates.</p>
                    )}
                  </div>
                </section>
              )}

              {mobileOrderStep === 3 && (
                <section className="mobile-form-card">
                  <h2>{selectedProduct?.pricing_type === "STITCH_BASED" ? "Stitch details" : "Measurements"}</h2>
                  {selectedProduct?.pricing_type === "STITCH_BASED" ? (
                    <>
                      <p className="mobile-help">Measurements are not needed for stitch-based embroidery.</p>
                      <label className="mobile-field">
                        <span>Customer category</span>
                        <select
                          value={orderForm.embroidery_category}
                          onChange={event => setOrderForm({ ...orderForm, embroidery_category: event.target.value })}
                        >
                          {rates.map(rate => (
                            <option key={rate.category} value={rate.category}>{rate.category} (₹{rate.rate_per_stitch}/stitch)</option>
                          ))}
                        </select>
                      </label>
                      <label className="mobile-field">
                        <span>Number of stitches</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min="1"
                          step="1"
                          value={orderForm.stitch_count}
                          onChange={event => setOrderForm({ ...orderForm, stitch_count: Number(event.target.value) })}
                        />
                      </label>
                      <div className="mobile-summary-row">
                        <span>Calculated amount</span>
                        <strong>{money(calculateOrderTotal())}</strong>
                      </div>
                    </>
                  ) : selectedTemplate ? (
                    <>
                      <p className="mobile-help">
                        {selectedTemplate.name} · {selectedTemplate.fields.filter(field => String(orderForm.measurements[field] || "").trim()).length} of {selectedTemplate.fields.length} entered. All values are in inches.
                      </p>
                      <div className="mobile-measurement-list">
                        {selectedTemplate.fields.map(field => (
                          <label key={field} className="mobile-field">
                            <span>{field} <em>inches</em></span>
                            <input
                              type="number"
                              inputMode="decimal"
                              min="0"
                              step="0.1"
                              value={orderForm.measurements[field] || ""}
                              onChange={event => setOrderForm({
                                ...orderForm,
                                measurements: { ...orderForm.measurements, [field]: event.target.value }
                              })}
                              placeholder="0.0"
                            />
                          </label>
                        ))}
                      </div>
                    </>
                  ) : selectedProduct ? (
                    <p className="mobile-help">No measurements are required for {selectedProduct.name}.</p>
                  ) : (
                    <p className="mobile-help">Choose a product first.</p>
                  )}
                </section>
              )}

              {mobileOrderStep === 4 && (
                <section className="mobile-form-card">
                  <h2>Design and reference</h2>
                  <label className="mobile-field">
                    <span>Cloth &amp; design notes</span>
                    <textarea
                      rows={5}
                      value={orderForm.description}
                      onChange={event => setOrderForm({ ...orderForm, description: event.target.value })}
                      placeholder="Colour, fabric, neck design, sleeve work…"
                    />
                  </label>
                  <div className="mobile-field">
                    <span>Reference image <em>optional, JPEG or PNG up to 4 MB</em></span>
                    {referencePreview ? (
                      <div className="mobile-reference-preview">
                        <img src={referencePreview} alt="Reference preview" />
                        <div>
                          <p>{referenceImage?.name}</p>
                          <button
                            type="button"
                            className="mobile-ghost-button"
                            onClick={() => {
                              if (referencePreview) URL.revokeObjectURL(referencePreview);
                              setReferenceImage(null);
                              setReferencePreview("");
                            }}
                          >
                            Remove image
                          </button>
                        </div>
                      </div>
                    ) : (
                      <label className="mobile-upload-box">
                        <FileUp size={22} />
                        <span>Choose a reference image</span>
                        <input
                          type="file"
                          accept="image/jpeg,image/png"
                          onChange={event => uploadReferenceImage(event.target.files?.[0], event.target)}
                        />
                      </label>
                    )}
                  </div>
                </section>
              )}

              {mobileOrderStep === 5 && (
                <section className="mobile-form-card">
                  <h2>Price and delivery</h2>
                  <label className="mobile-field">
                    <span>Order date</span>
                    <input type="date" value={orderForm.order_date} onChange={event => setOrderForm({ ...orderForm, order_date: event.target.value })} />
                  </label>
                  <label className="mobile-field">
                    <span>Delivery date</span>
                    <input type="date" value={orderForm.delivery_date} onChange={event => setOrderForm({ ...orderForm, delivery_date: event.target.value })} />
                  </label>
                  {selectedProduct?.pricing_type !== "STITCH_BASED" && (
                    <>
                      <label className="mobile-field">
                        <span>Base price (₹)</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.01"
                          value={orderForm.base_amount}
                          onChange={event => setOrderForm({ ...orderForm, base_amount: event.target.value })}
                        />
                      </label>
                      <label className="mobile-field">
                        <span>Extra aari / design charge (₹)</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.01"
                          value={orderForm.extra_amount}
                          onChange={event => setOrderForm({ ...orderForm, extra_amount: event.target.value })}
                        />
                      </label>
                    </>
                  )}
                  <label className="mobile-field">
                    <span>Advance paid now (₹)</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      value={orderForm.paid_amount}
                      onChange={event => setOrderForm({ ...orderForm, paid_amount: event.target.value })}
                    />
                  </label>
                  <div className="mobile-total-card">
                    <div><span>Order total</span><strong>{money(calculateOrderTotal())}</strong></div>
                    <div><span>Advance paid</span><strong>{money(orderForm.paid_amount)}</strong></div>
                    <div className="is-balance"><span>Balance due</span><strong>{money(Math.max(0, calculateOrderTotal() - Number(orderForm.paid_amount || 0)))}</strong></div>
                  </div>
                </section>
              )}

              {mobileOrderStep === 6 && (
                <section className="mobile-form-card">
                  <h2>Review before saving</h2>
                  <dl className="mobile-review-list">
                    <div><dt>Customer</dt><dd>{customers.find(c => String(c.id) === String(orderForm.customer_id))?.name || "Not selected"}</dd></div>
                    <div><dt>Phone</dt><dd>{customers.find(c => String(c.id) === String(orderForm.customer_id))?.phone || "—"}</dd></div>
                    <div><dt>Product</dt><dd>{selectedProduct?.name || "Not selected"}</dd></div>
                    <div><dt>Order date</dt><dd>{shortDate(orderForm.order_date)}</dd></div>
                    <div><dt>Delivery</dt><dd>{orderForm.delivery_date ? shortDate(orderForm.delivery_date) : "Not set"}</dd></div>
                    <div><dt>Total</dt><dd>{money(calculateOrderTotal())}</dd></div>
                    <div><dt>Advance</dt><dd>{money(orderForm.paid_amount)}</dd></div>
                    <div className="is-balance"><dt>Balance due</dt><dd>{money(Math.max(0, calculateOrderTotal() - Number(orderForm.paid_amount || 0)))}</dd></div>
                  </dl>
                  {orderForm.description && (
                    <div className="mobile-review-block">
                      <p>Design notes</p>
                      <span>{orderForm.description}</span>
                    </div>
                  )}
                  {selectedTemplate && selectedProduct?.pricing_type !== "STITCH_BASED" && (
                    <div className="mobile-review-block">
                      <p>Measurements (inches)</p>
                      <div className="mobile-measurement-chips">
                        {selectedTemplate.fields.map(field => (
                          <span key={field}>{field}: <strong>{orderForm.measurements[field] || "—"}</strong></span>
                        ))}
                      </div>
                    </div>
                  )}
                  {referencePreview && (
                    <div className="mobile-review-block">
                      <p>Reference image</p>
                      <img src={referencePreview} alt="Reference preview" className="mobile-review-image" />
                    </div>
                  )}
                  <p className="mobile-help">Saving creates the invoice and records the advance payment. This cannot be undone from the review screen.</p>
                </section>
              )}

              <div className="mobile-wizard-actions">
                <button
                  type="button"
                  className="mobile-secondary-button"
                  onClick={() => {
                    if (mobileOrderStep === 1) setTab("dashboard");
                    else goToMobileOrderStep(mobileOrderStep - 1);
                  }}
                >
                  <ArrowLeft size={18} /> {mobileOrderStep === 1 ? "Cancel" : "Back"}
                </button>
                {mobileOrderStep < 6 ? (
                  <button
                    type="button"
                    className="mobile-primary-button"
                    onClick={() => goToMobileOrderStep(mobileOrderStep + 1)}
                  >
                    Continue <ArrowRight size={18} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="mobile-primary-button"
                    onClick={submitMobileOrder}
                    disabled={savingOrder}
                  >
                    {savingOrder ? <><Loader2 size={18} className="spin" /> Saving…</> : <><Check size={18} /> Save order</>}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* MOBILE / PRODUCTS, RATES, TEMPLATES */}
          {tab === "products" && (
            <div className="mobile-screen">
              <div className="mobile-screen-head">
                <div>
                  <h1>Products &amp; rates</h1>
                  <p>Manage products, stitch rates and measurement templates.</p>
                </div>
              </div>

              <div className="mobile-segmented" role="tablist" aria-label="Product settings">
                {[
                  ["products", "Products"],
                  ["rates", "Stitch rates"],
                  ["templates", "Templates"]
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={mobileProductTab === value}
                    className={mobileProductTab === value ? "is-active" : ""}
                    onClick={() => setMobileProductTab(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {productFeedback && (
                <div className={`mobile-banner ${productFeedback.type === "error" ? "mobile-banner-danger" : "mobile-banner-success"}`} role="status">
                  {productFeedback.text}
                </div>
              )}

              {mobileProductTab === "products" && (
                <>
                  <button
                    type="button"
                    className="mobile-secondary-button mobile-full-button"
                    onClick={() => setMobileShowAddProduct(current => !current)}
                  >
                    <Plus size={18} /> {mobileShowAddProduct ? "Close add product form" : "Add product"}
                  </button>
                  {mobileShowAddProduct && (
                    <form className="mobile-form-card" onSubmit={createProductRecord}>
                      <h2>New product</h2>
                      <label className="mobile-field">
                        <span>Product name</span>
                        <input required value={newProd.name} onChange={event => setNewProd({ ...newProd, name: event.target.value })} placeholder="For example: Aari blouse" />
                      </label>
                      <label className="mobile-field">
                        <span>Pricing method</span>
                        <select value={newProd.pricing_type} onChange={event => setNewProd({ ...newProd, pricing_type: event.target.value })}>
                          <option value="MANUAL">Fixed / manual price</option>
                          <option value="BASE_PLUS_EXTRA">Base + extra work charge</option>
                          <option value="STITCH_BASED">Embroidery stitch-based</option>
                        </select>
                      </label>
                      <label className="mobile-field">
                        <span>Default base price (₹)</span>
                        <input type="number" inputMode="decimal" min="0" step="0.01" value={newProd.base_price} onChange={event => setNewProd({ ...newProd, base_price: event.target.value })} />
                      </label>
                      <label className="mobile-field">
                        <span>Measurement template</span>
                        <select value={newProd.measurement_template_id} onChange={event => setNewProd({ ...newProd, measurement_template_id: event.target.value })}>
                          <option value="">No measurements needed</option>
                          {templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
                        </select>
                      </label>
                      <button type="submit" className="mobile-primary-button mobile-full-button">Save product</button>
                    </form>
                  )}
                  {products.length === 0 ? (
                    <MobileEmptyState Icon={Package} title="No products yet" text="Add your first product above." />
                  ) : (
                    <div className="mobile-card-list">
                      {products.map(product => (
                        <div key={product.id} className="mobile-list-card">
                          <div className="min-w-0">
                            <p className="mobile-list-title">{product.name}</p>
                            <p className="mobile-list-subtitle">
                              {product.pricing_type === "STITCH_BASED" ? "Stitch-based embroidery" : `Base ${money(product.base_price)}`}
                            </p>
                            <p className="mobile-list-meta">{templates.find(template => template.id === product.measurement_template_id)?.name || "No measurements"}</p>
                          </div>
                          <button
                            type="button"
                            className={`mobile-status-button ${product.active ? "is-active" : ""}`}
                            onClick={async () => {
                              try {
                                const response = await apiFetch(`${API}/products/${product.id}/toggle`, { method: "PATCH" });
                                if (!response.ok) {
                                  const body = await response.json().catch(() => ({}));
                                  throw new Error(body.detail || "Product status could not be changed.");
                                }
                                notify(`${product.name} ${product.active ? "deactivated" : "activated"}.`);
                                await loadAll("products");
                              } catch (error) {
                                setProductFeedback({ type: "error", text: error.message });
                              }
                            }}
                          >
                            {product.active ? "Active" : "Inactive"}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {mobileProductTab === "rates" && (
                <div className="mobile-card-list">
                  {rates.map(rate => (
                    <div key={rate.category} className="mobile-list-card">
                      <div className="min-w-0">
                        <p className="mobile-list-title">{rate.category}</p>
                        <p className="mobile-list-subtitle">{money(rate.rate_per_stitch)} per stitch</p>
                        <p className="mobile-list-meta">1,000 stitches = {money(rate.rate_per_stitch * 1000)}</p>
                      </div>
                      <button type="button" className="mobile-ghost-button" onClick={() => setMobileRateEdit({ category: rate.category, value: String(rate.rate_per_stitch) })}>
                        Edit rate
                      </button>
                    </div>
                  ))}
                  {rates.length === 0 && <MobileEmptyState Icon={Percent} title="No stitch rates" text="Stitch rates are created by the backend seed data." />}
                </div>
              )}

              {mobileProductTab === "templates" && (
                <>
                  <form className="mobile-form-card" onSubmit={createTemplateRecord}>
                    <h2>New measurement template</h2>
                    <label className="mobile-field">
                      <span>Template name</span>
                      <input required value={newTmpl.name} onChange={event => setNewTmpl({ ...newTmpl, name: event.target.value })} placeholder="For example: Kids pavadai" />
                    </label>
                    <label className="mobile-field">
                      <span>Measurement fields <em>comma-separated</em></span>
                      <textarea required rows={3} value={newTmpl.fieldsCSV} onChange={event => setNewTmpl({ ...newTmpl, fieldsCSV: event.target.value })} placeholder="Chest, Waist, Length" />
                    </label>
                    <button type="submit" className="mobile-primary-button mobile-full-button">Save template</button>
                  </form>
                  <div className="mobile-card-list">
                    {templates.map(template => (
                      <div key={template.id} className="mobile-list-card is-stacked">
                        <p className="mobile-list-title">{template.name}</p>
                        <p className="mobile-list-subtitle">{(template.fields || []).join(", ") || "No fields"}</p>
                      </div>
                    ))}
                    {templates.length === 0 && <MobileEmptyState Icon={Ruler} title="No templates yet" text="Create one to collect measurements for a product." />}
                  </div>
                </>
              )}
            </div>
          )}

          {/* MOBILE / FINANCE & REPORTS */}
          {tab === "finance" && (
            <div className="mobile-screen">
              <div className="mobile-screen-head">
                <div>
                  <h1>Finance &amp; reports</h1>
                  <p>Sales, collections, expenses and receivables.</p>
                </div>
              </div>

              <div className="mobile-chip-row" role="group" aria-label="Finance period">
                {[["month", "This month"], ["year", "This year"], ["all", "All time"]].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`mobile-chip ${financePeriod === value ? "is-active" : ""}`}
                    aria-pressed={financePeriod === value}
                    onClick={() => setFinancePeriod(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="mobile-date-row">
                <label className="mobile-field">
                  <span>From</span>
                  <input type="date" value={dateRange.start} onChange={event => { setFinancePeriodState("custom"); setDateRange({ ...dateRange, start: event.target.value }); }} />
                </label>
                <label className="mobile-field">
                  <span>To</span>
                  <input type="date" value={dateRange.end} onChange={event => { setFinancePeriodState("custom"); setDateRange({ ...dateRange, end: event.target.value }); }} />
                </label>
              </div>

              <div className="mobile-metric-grid">
                <MobileMetric Icon={TrendingUp} label="Income" value={money(finance.summary.total_income)} />
                <MobileMetric Icon={Receipt} label="Expenses" value={money(finance.summary.total_expense)} />
                <MobileMetric Icon={TrendingUp} label="Net profit" value={money(finance.summary.net_profit)} />
                <MobileMetric Icon={Wallet} label="Receivables" value={money(finance.summary.pending_payments)} />
              </div>

              <section className="mobile-section">
                <div className="mobile-section-head">
                  <h2>Last 7 active days</h2>
                  <span className="mobile-count">{finance.transactions.length} entries</span>
                </div>
                {mobileFinanceDays.length === 0 ? (
                  <MobileEmptyState Icon={TrendingUp} title="No activity in this period" text="Income and expense entries will appear here." />
                ) : (
                  <div className="mobile-bars">
                    {mobileFinanceDays.map(day => (
                      <div key={day.date} className="mobile-bar-row">
                        <span className="mobile-bar-label">{shortDate(day.date)}</span>
                        <div className="mobile-bar-track">
                          <span className="mobile-bar-income" style={{ width: `${Math.max(2, (day.Income / mobileFinanceMax) * 100)}%` }} />
                          <span className="mobile-bar-expense" style={{ width: `${Math.max(2, (day.Expense / mobileFinanceMax) * 100)}%` }} />
                        </div>
                        <span className="mobile-bar-value">{money(day.Income - day.Expense)}</span>
                      </div>
                    ))}
                    <p className="mobile-legend"><span className="is-income" /> Income <span className="is-expense" /> Expenses</p>
                  </div>
                )}
              </section>

              <section className="mobile-section">
                <div className="mobile-section-head"><h2>Top categories</h2></div>
                <div className="mobile-category-grid">
                  <div className="mobile-summary-card">
                    <p>Income</p>
                    {(finance.income_by_category || []).slice(0, 5).map(item => (
                      <div key={item.category} className="mobile-summary-row">
                        <span>{item.category}</span><strong>{money(item.amount)}</strong>
                      </div>
                    ))}
                    {(finance.income_by_category || []).length === 0 && <span className="mobile-empty-inline">No income entries.</span>}
                  </div>
                  <div className="mobile-summary-card">
                    <p>Expenses</p>
                    {(finance.expense_by_category || []).slice(0, 5).map(item => (
                      <div key={item.category} className="mobile-summary-row">
                        <span>{item.category}</span><strong>{money(item.amount)}</strong>
                      </div>
                    ))}
                    {(finance.expense_by_category || []).length === 0 && <span className="mobile-empty-inline">No expense entries.</span>}
                  </div>
                </div>
              </section>

              <section className="mobile-section">
                <div className="mobile-section-head">
                  <h2>Add expense / income</h2>
                  <button type="button" className="mobile-link-button" onClick={() => setMobileShowExpenseForm(current => !current)}>
                    {mobileShowExpenseForm ? "Close" : "Add entry"}
                  </button>
                </div>
                {txFeedback && (
                  <div className={`mobile-banner ${txFeedback.type === "error" ? "mobile-banner-danger" : "mobile-banner-success"}`} role="status">
                    {txFeedback.text}
                  </div>
                )}
                {mobileShowExpenseForm && (
                  <form className="mobile-form-card" onSubmit={createTransactionRecord}>
                    <label className="mobile-field">
                      <span>Entry type</span>
                      <select value={newTx.type} onChange={event => setNewTx({ ...newTx, type: event.target.value })}>
                        <option value="EXPENSE">Expense out</option>
                        <option value="INCOME">Manual income in</option>
                      </select>
                    </label>
                    <label className="mobile-field">
                      <span>Date</span>
                      <input type="date" value={newTx.date} onChange={event => setNewTx({ ...newTx, date: event.target.value })} />
                    </label>
                    <label className="mobile-field">
                      <span>Category</span>
                      <input required value={newTx.category} onChange={event => setNewTx({ ...newTx, category: event.target.value })} placeholder="Thread, zari, rent…" />
                    </label>
                    <label className="mobile-field">
                      <span>Amount (₹)</span>
                      <input required type="number" inputMode="decimal" min="0.01" step="0.01" value={newTx.amount} onChange={event => setNewTx({ ...newTx, amount: event.target.value })} />
                    </label>
                    <label className="mobile-field">
                      <span>Description / bill reference</span>
                      <input value={newTx.description} onChange={event => setNewTx({ ...newTx, description: event.target.value })} />
                    </label>
                    <button type="submit" className="mobile-primary-button mobile-full-button">Save entry</button>
                  </form>
                )}
              </section>

              <section className="mobile-section">
                <div className="mobile-section-head">
                  <h2>Ledger</h2>
                  <div className="mobile-button-row">
                    <button type="button" className="mobile-ghost-button" onClick={() => downloadFinanceExport("csv").catch(error => setTxFeedback({ type: "error", text: error.message }))}>CSV</button>
                    <button type="button" className="mobile-ghost-button" onClick={() => downloadFinanceExport("pdf").catch(error => setTxFeedback({ type: "error", text: error.message }))}>PDF</button>
                  </div>
                </div>
                <div className="mobile-search-box">
                  <Search size={18} />
                  <input
                    type="search"
                    value={transactionFilter.search}
                    onChange={event => setTransactionFilter({ ...transactionFilter, search: event.target.value })}
                    placeholder="Search ledger"
                    aria-label="Search ledger"
                  />
                </div>
                <div className="mobile-card-list">
                  {(finance.transactions || [])
                    .filter(transaction => (
                      (transactionFilter.type === "ALL" || transaction.type === transactionFilter.type)
                      && `${transaction.category} ${transaction.description} ${transaction.payment_method}`.toLowerCase().includes(transactionFilter.search.toLowerCase())
                    ))
                    .slice(0, 40)
                    .map(transaction => (
                      <div key={transaction.id} className="mobile-list-card">
                        <div className="min-w-0">
                          <p className="mobile-list-title">{transaction.category}</p>
                          <p className="mobile-list-subtitle">{transaction.description || "—"}</p>
                          <p className="mobile-list-meta">{shortDate(transaction.date)} · {transaction.payment_method || "Cash/UPI"}</p>
                        </div>
                        <span className={`mobile-amount ${transaction.type === "INCOME" ? "positive" : "negative"}`}>
                          {transaction.type === "INCOME" ? "+" : "−"}{money(transaction.amount)}
                        </span>
                      </div>
                    ))}
                  {(finance.transactions || []).length === 0 && (
                    <MobileEmptyState Icon={Receipt} title="No ledger entries" text="Add an expense or income entry to start tracking cash flow." />
                  )}
                </div>
              </section>
            </div>
          )}

          {/* MOBILE / MORE */}
          {tab === "more" && (
            <div className="mobile-screen">
              <section className="mobile-profile-card">
                <div className="mobile-profile-avatar">A</div>
                <div>
                  <h1>Admin</h1>
                  <p>Lalitha&apos;s Apparel · Madurai</p>
                </div>
              </section>

              <section className="mobile-section">
                <div className="mobile-section-head"><h2>Business</h2></div>
                <div className="mobile-link-list">
                  {[
                    [Scissors, "Products & rates", "Products, stitch rates and templates", "products"],
                    [Wallet, "Finance & reports", "Income, expenses and receivables", "finance"],
                    [Receipt, "Orders & invoices", "Search, collect and share invoices", "invoices"],
                    [Users, "Customers", "Details, measurements and calling", "customers"],
                    [FilePlus2, "New order", "Guided order form", "new-order"],
                    [Ruler, "Measurements", "Reusable measurement templates", "products"]
                  ].map(([Icon, title, description, target]) => (
                    <button
                      key={title}
                      type="button"
                      onClick={() => {
                        if (title === "Measurements") setMobileProductTab("templates");
                        if (title === "Products & rates") setMobileProductTab("products");
                        setTab(target);
                      }}
                    >
                      <span className="mobile-link-icon"><Icon size={20} /></span>
                      <span className="min-w-0"><strong>{title}</strong><small>{description}</small></span>
                      <ChevronRight size={18} />
                    </button>
                  ))}
                </div>
              </section>

              <section className="mobile-section">
                <div className="mobile-section-head"><h2>Backup</h2></div>
                <div className="mobile-link-list">
                  <button type="button" onClick={createBackup}>
                    <span className="mobile-link-icon"><DatabaseBackup size={20} /></span>
                    <span className="min-w-0"><strong>Backup database</strong><small>Create a local backup file</small></span>
                    <ChevronRight size={18} />
                  </button>
                  <button type="button" onClick={() => restoreInputRef.current?.click()}>
                    <span className="mobile-link-icon"><FileUp size={20} /></span>
                    <span className="min-w-0"><strong>Restore from file</strong><small>Replace data with a saved backup</small></span>
                    <ChevronRight size={18} />
                  </button>
                  <button type="button" onClick={createCloudBackup} disabled={!cloudBackupConfigured}>
                    <span className="mobile-link-icon"><Cloud size={20} /></span>
                    <span className="min-w-0">
                      <strong>Cloud backup</strong>
                      <small>{cloudBackupConfigured ? "Upload a snapshot to Supabase Storage" : "Supabase Storage is not configured"}</small>
                    </span>
                    <ChevronRight size={18} />
                  </button>
                </div>
              </section>

              <section className="mobile-section">
                <div className="mobile-section-head"><h2>About</h2></div>
                <div className="mobile-summary-card">
                  <div className="mobile-summary-row"><span>Application</span><strong>Lalitha&apos;s Apparel</strong></div>
                  <div className="mobile-summary-row"><span>Business</span><strong>Embroidery &amp; boutique</strong></div>
                  <div className="mobile-summary-row"><span>AI assistant</span><strong>{VOICE_ENABLED ? "Available" : "Disabled in this build"}</strong></div>
                  <div className="mobile-summary-row"><span>Languages</span><strong>English · தமிழ்</strong></div>
                </div>
                <p className="mobile-help">Tamil text renders using the device&apos;s system Tamil font. Voice recording stays off until you tap the microphone.</p>
              </section>

              <button type="button" className="mobile-danger-outline-button mobile-full-button" onClick={logout}>
                <LogOut size={18} /> Log out
              </button>
              <p className="mobile-version">Lalitha&apos;s Apparel management · mobile view</p>
            </div>
          )}
        </div>

        {/* Mobile customer detail sheet */}
        {mobileCustomerOpen && (
          <div className="mobile-sheet-backdrop" role="presentation">
            <section className="mobile-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-customer-title">
              <div className="mobile-sheet-head">
                <button type="button" className="mobile-icon-button" onClick={() => setMobileCustomerOpen(null)} aria-label="Close customer details">
                  <ArrowLeft size={20} />
                </button>
                <div className="min-w-0">
                  <h2 id="mobile-customer-title">{mobileCustomerOpen.name}</h2>
                  <p>{mobileCustomerOpen.cust_code} · {mobileCustomerOpen.order_count || 0} orders</p>
                </div>
                <button type="button" className="mobile-icon-button" onClick={() => { startEditCustomer(mobileCustomerOpen); setMobileCustomerOpen(null); setMobileCustomerFormOpen(true); }} aria-label="Edit customer">
                  <Pencil size={19} />
                </button>
              </div>

              <div className="mobile-sheet-body">
                <div className="mobile-contact-grid">
                  <a className="mobile-contact-card" href={`tel:${String(mobileCustomerOpen.phone || "").replace(/[^\d+]/g, "")}`}>
                    <Phone size={19} /><span><small>Phone</small><strong>{mobileCustomerOpen.phone}</strong></span>
                  </a>
                  {mobileCustomerOpen.alternate_phone && (
                    <a className="mobile-contact-card" href={`tel:${String(mobileCustomerOpen.alternate_phone || "").replace(/[^\d+]/g, "")}`}>
                      <Phone size={19} /><span><small>Alternate</small><strong>{mobileCustomerOpen.alternate_phone}</strong></span>
                    </a>
                  )}
                </div>

                <div className="mobile-detail-card">
                  <div className="mobile-summary-row"><span>City</span><strong>{mobileCustomerOpen.city || "—"}</strong></div>
                  <div className="mobile-summary-row"><span>Address</span><strong>{mobileCustomerOpen.address || "—"}</strong></div>
                  <div className="mobile-summary-row"><span>Total spent</span><strong>{money(mobileCustomerOpen.total_spent)}</strong></div>
                </div>

                {mobileCustomerOpen.notes && (
                  <div className="mobile-detail-card">
                    <p className="mobile-detail-label">Notes</p>
                    <p className="mobile-detail-text">{mobileCustomerOpen.notes}</p>
                  </div>
                )}

                <div className="mobile-detail-card">
                  <p className="mobile-detail-label">Saved measurements</p>
                  {Object.keys(mobileCustomerOpen.last_measurements || {}).length === 0 ? (
                    <p className="mobile-detail-text">No measurements saved yet.</p>
                  ) : (
                    <div className="mobile-measurement-chips">
                      {Object.entries(mobileCustomerOpen.last_measurements).map(([name, value]) => (
                        <span key={name}>{name}: <strong>{value}&quot;</strong></span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="mobile-detail-card">
                  <p className="mobile-detail-label">Order history</p>
                  {mobileCustomerOrders.length === 0 ? (
                    <p className="mobile-detail-text">No orders for this customer yet.</p>
                  ) : (
                    <div className="mobile-card-list">
                      {mobileCustomerOrders.slice(0, 10).map(order => (
                        <MobileOrderCard key={order.id} order={order} onOpen={item => setMobileOrderOpenId(item.id)} onPay={openPayment} />
                      ))}
                    </div>
                  )}
                </div>

                <div className="mobile-sheet-actions">
                  <button type="button" className="mobile-primary-button" onClick={() => startMobileNewOrderForCustomer(mobileCustomerOpen)}>
                    <FilePlus2 size={18} /> New order
                  </button>
                  <button type="button" className="mobile-danger-outline-button" onClick={() => removeCustomer(mobileCustomerOpen)}>
                    <Trash2 size={18} /> Delete
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}

        {/* Mobile add/edit customer sheet */}
        {(mobileCustomerFormOpen || editingCustomer) && (() => {
          const editing = Boolean(editingCustomer);
          const form = editing ? editCust : newCust;
          const setForm = editing ? setEditCust : setNewCust;
          const duplicate = !editing && form.phone.trim().length === 10
            ? customers.find(customer => customer.phone === form.phone.trim())
            : null;
          return (
            <div className="mobile-sheet-backdrop" role="presentation">
              <section className="mobile-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-customer-form-title">
                <div className="mobile-sheet-head">
                  <button
                    type="button"
                    className="mobile-icon-button"
                    onClick={() => { setMobileCustomerFormOpen(false); setEditingCustomer(null); }}
                    aria-label="Close customer form"
                  >
                    <ArrowLeft size={20} />
                  </button>
                  <div className="min-w-0">
                    <h2 id="mobile-customer-form-title">{editing ? "Edit customer" : "Add customer"}</h2>
                    <p>{editing ? editingCustomer.cust_code : "Name and phone are required"}</p>
                  </div>
                </div>
                <form className="mobile-sheet-body" onSubmit={editing ? saveCustomerEdit : createMobileCustomer}>
                  {(editing ? editCustError : (custFeedback?.type === "error" ? custFeedback.text : "")) && (
                    <div className="mobile-banner mobile-banner-danger" role="alert">
                      {editing ? editCustError : custFeedback.text}
                    </div>
                  )}
                  <label className="mobile-field">
                    <span>Customer name</span>
                    <input required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="Full name" autoComplete="name" />
                  </label>
                  <label className="mobile-field">
                    <span>Phone number <em>10 digits</em></span>
                    <input
                      required
                      type="tel"
                      inputMode="numeric"
                      pattern="[0-9]{10}"
                      maxLength={10}
                      value={form.phone}
                      onChange={event => setForm({ ...form, phone: event.target.value.replace(/\D/g, "").slice(0, 10) })}
                      placeholder="10-digit mobile number"
                      autoComplete="tel"
                    />
                  </label>
                  {duplicate && (
                    <div className="mobile-banner mobile-banner-warning">
                      This number belongs to {duplicate.name}.
                      <button type="button" onClick={() => { startEditCustomer(duplicate); setMobileCustomerFormOpen(true); }}>Edit that customer</button>
                    </div>
                  )}
                  <label className="mobile-field">
                    <span>Alternate phone <em>optional</em></span>
                    <input
                      type="tel"
                      inputMode="numeric"
                      pattern="[0-9]{10}"
                      maxLength={10}
                      value={form.alternate_phone}
                      onChange={event => setForm({ ...form, alternate_phone: event.target.value.replace(/\D/g, "").slice(0, 10) })}
                      placeholder="Alternate number"
                    />
                  </label>
                  <div className="mobile-date-row">
                    <label className="mobile-field">
                      <span>City</span>
                      <input value={form.city} onChange={event => setForm({ ...form, city: event.target.value })} placeholder="City" />
                    </label>
                    <label className="mobile-field">
                      <span>Address / area</span>
                      <input value={form.address} onChange={event => setForm({ ...form, address: event.target.value })} placeholder="Area" />
                    </label>
                  </div>
                  <label className="mobile-field">
                    <span>Special notes <em>optional</em></span>
                    <textarea rows={3} value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} placeholder="Preferences, delivery notes…" />
                  </label>
                  <button type="submit" className="mobile-primary-button mobile-full-button" disabled={savingCustomer}>
                    {savingCustomer ? <><Loader2 size={18} className="spin" /> Saving…</> : <><Check size={18} /> {editing ? "Save changes" : "Save customer"}</>}
                  </button>
                </form>
              </section>
            </div>
          );
        })()}

        {/* Mobile order detail sheet */}
        {mobileOpenOrder && (
          <div className="mobile-sheet-backdrop" role="presentation">
            <section className="mobile-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-order-title">
              <div className="mobile-sheet-head">
                <button type="button" className="mobile-icon-button" onClick={() => setMobileOrderOpenId(null)} aria-label="Close order details">
                  <ArrowLeft size={20} />
                </button>
                <div className="min-w-0">
                  <h2 id="mobile-order-title">{mobileOpenOrder.invoice_number}</h2>
                  <p>{shortDate(mobileOpenOrder.order_date)} · {mobileOpenOrder.status}</p>
                </div>
                <span className={`mobile-status ${statusTone(mobileOpenOrder.status)}`}>{statusLabel(mobileOpenOrder.status)}</span>
              </div>

              <div className="mobile-sheet-body">
                <div className="mobile-detail-card">
                  <p className="mobile-detail-label">Customer</p>
                  <div className="mobile-summary-row"><span>Name</span><strong>{mobileOpenOrder.customer_name}</strong></div>
                  <div className="mobile-summary-row">
                    <span>Phone</span>
                    <a href={`tel:${String(mobileOpenOrder.customer_phone || "").replace(/[^\d+]/g, "")}`} className="mobile-inline-link">
                      {mobileOpenOrder.customer_phone}
                    </a>
                  </div>
                  <div className="mobile-summary-row"><span>Product</span><strong>{mobileOpenOrder.product_name}</strong></div>
                  {mobileOpenOrder.embroidery_category && (
                    <div className="mobile-summary-row"><span>Category</span><strong>{mobileOpenOrder.embroidery_category}</strong></div>
                  )}
                </div>

                {mobileOpenOrder.measurements?.length > 0 && (
                  <div className="mobile-detail-card">
                    <p className="mobile-detail-label">Measurements (inches)</p>
                    <div className="mobile-measurement-chips">
                      {mobileOpenOrder.measurements.map(measurement => (
                        <span key={measurement.field_name}>{measurement.field_name}: <strong>{measurement.value}</strong></span>
                      ))}
                    </div>
                  </div>
                )}

                {mobileOpenOrder.description && (
                  <div className="mobile-detail-card">
                    <p className="mobile-detail-label">Order description</p>
                    <p className="mobile-detail-text">{mobileOpenOrder.description}</p>
                  </div>
                )}

                <div className="mobile-detail-card">
                  <p className="mobile-detail-label">Price and payments</p>
                  <div className="mobile-summary-row"><span>Order total</span><strong>{money(mobileOpenOrder.total_amount)}</strong></div>
                  <div className="mobile-summary-row"><span>Paid</span><strong>{money(mobileOpenOrder.paid_amount)}</strong></div>
                  <div className="mobile-summary-row is-balance"><span>Balance due</span><strong>{money(mobileOpenOrder.balance)}</strong></div>
                  <div className="mobile-summary-row"><span>Delivery</span><strong>{mobileOpenOrder.delivery_date ? shortDate(mobileOpenOrder.delivery_date) : "Not set"}</strong></div>
                  {orderOverdue(mobileOpenOrder) && (
                    <p className="mobile-inline-warning"><AlertTriangle size={15} /> Delivery date passed with a balance due.</p>
                  )}
                </div>

                <div className="mobile-detail-card">
                  <p className="mobile-detail-label">Invoice</p>
                  <div className="mobile-button-grid">
                    <button type="button" className="mobile-secondary-button" onClick={() => openInvoicePdf(mobileOpenOrder.id)}>
                      <FileText size={18} /> View / download PDF
                    </button>
                    <button type="button" className="mobile-secondary-button" onClick={() => sendWhatsAppMsg(mobileOpenOrder, "bill")}>
                      <MessageCircle size={18} /> WhatsApp bill
                    </button>
                    <button type="button" className="mobile-secondary-button" onClick={() => sendInvoicePdfOnWhatsApp(mobileOpenOrder)}>
                      <FileUp size={18} /> Send PDF
                    </button>
                    <button type="button" className="mobile-secondary-button" onClick={() => sendWhatsAppMsg(mobileOpenOrder, "ready")}>
                      <CheckCircle2 size={18} /> Ready message
                    </button>
                  </div>
                </div>

                <div className="mobile-sheet-actions">
                  {Number(mobileOpenOrder.balance) > 0 ? (
                    <button type="button" className="mobile-primary-button" onClick={() => openPayment(mobileOpenOrder)}>
                      <Wallet size={18} /> Collect {money(mobileOpenOrder.balance)}
                    </button>
                  ) : (
                    <span className="mobile-paid-badge"><CheckCircle2 size={18} /> Paid in full</span>
                  )}
                  <button type="button" className="mobile-danger-outline-button" onClick={() => removeOrder(mobileOpenOrder)}>
                    <Trash2 size={18} /> Delete order
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}

        {/* Mobile rate edit sheet */}
        {mobileRateEdit && (
          <div className="mobile-sheet-backdrop" role="presentation">
            <section className="mobile-sheet mobile-sheet-small" role="dialog" aria-modal="true" aria-labelledby="mobile-rate-title">
              <div className="mobile-sheet-head">
                <div className="min-w-0">
                  <h2 id="mobile-rate-title">Edit stitch rate</h2>
                  <p>{mobileRateEdit.category}</p>
                </div>
                <button type="button" className="mobile-icon-button" onClick={() => setMobileRateEdit(null)} aria-label="Close rate editor">
                  <X size={20} />
                </button>
              </div>
              <form className="mobile-sheet-body" onSubmit={saveRateEdit}>
                <label className="mobile-field">
                  <span>Rate per stitch (₹)</span>
                  <input
                    required
                    type="number"
                    inputMode="decimal"
                    min="0.0001"
                    step="0.0001"
                    value={mobileRateEdit.value}
                    onChange={event => setMobileRateEdit({ ...mobileRateEdit, value: event.target.value })}
                  />
                </label>
                <p className="mobile-help">1,000 stitches will cost {money(Number(mobileRateEdit.value || 0) * 1000)}.</p>
                <button type="submit" className="mobile-primary-button mobile-full-button">Save rate</button>
              </form>
            </section>
          </div>
        )}

        {/* AI assistant floats above the bottom navigation */}
        {VOICE_ENABLED && (
          <>
            <button
              type="button"
              onClick={() => setAssistantOpen(current => !current)}
              className="mobile-assistant-button"
              aria-label={assistantOpen ? "Close Lalitha AI Assistant" : "Open Lalitha AI Assistant"}
              aria-expanded={assistantOpen}
            >
              {assistantOpen ? <X size={23} /> : <MessageCircle size={23} />}
            </button>
            {assistantOpen && (
              <Suspense fallback={<div className="mobile-assistant-loading">Loading Lalitha AI Assistant…</div>}>
                <VoiceAssistantPanel
                  variant="mobile"
                  apiFetch={apiFetch}
                  apiBase={API}
                  onOpenInvoice={openInvoicePdf}
                  onDataChanged={loadAll}
                  onClose={() => setAssistantOpen(false)}
                />
              </Suspense>
            )}
          </>
        )}

        <nav className="mobile-bottom-nav" aria-label="Main navigation">
          {BOTTOM_NAV_ITEMS.map(({ target, label }) => {
            const Icon = { dashboard: Home, invoices: Receipt, customers: Users, payments: Wallet, more: Menu }[target];
            const active = tab === target;
            return (
              <button
                key={target}
                type="button"
                className={active ? "is-active" : ""}
                aria-current={active ? "page" : undefined}
                onClick={() => setTab(target)}
              >
                <Icon size={22} />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>

        <input
          ref={restoreInputRef}
          type="file"
          accept=".db,.sqlite,.sqlite3"
          className="hidden"
          onChange={event => {
            restoreBackupFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />

        <PaymentDialog
          order={paymentTarget}
          amount={paymentAmount}
          setAmount={setPaymentAmount}
          method={paymentMethod}
          setMethod={setPaymentMethod}
          note={paymentNote}
          setNote={setPaymentNote}
          error={paymentError}
          busy={paymentBusy}
          onClose={closePayment}
          onSubmit={submitPayment}
        />
        <ConfirmDialog state={confirmState} onResolve={resolveConfirm} />
        <Toast toast={toast} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* SIDEBAR */}
      <aside className="w-full md:w-60 bg-slate-900 border-b md:border-r border-slate-800 p-4 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-2.5 px-2 py-5 mb-2 border-b border-slate-800">
            <img src="/lalithas-apparel-logo.webp" alt="Lalitha's Apparel logo" width="44" height="44" className="h-11 w-11 rounded-full object-cover" />
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

        <div className="sidebar-actions space-y-2 pt-4 border-t border-slate-800">
          <button
            onClick={createBackup}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200"
          >
            <DatabaseBackup size={15} /> Backup Database
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
              onChange={e => {
                setCustSearch(e.target.value);
                if (e.target.value.trim()) setTab("customers");
              }}
              placeholder="Search customers, phone numbers..."
              className="w-full rounded-lg border px-9 py-2 text-sm"
            />
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-slate-500 sm:inline">Local workspace</span>
            <button
              type="button"
              onClick={() => setTab("invoices")}
              title={finance.summary.pending_orders > 0 ? `${finance.summary.pending_orders} order(s) with a balance due` : "No outstanding orders"}
              className="relative flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
              aria-label={finance.summary.pending_orders > 0 ? `View ${finance.summary.pending_orders} orders with a balance due` : "View orders"}
            >
              <Bell size={18} />
              {finance.summary.pending_orders > 0 && (
                <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-orange-500" />
              )}
            </button>
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700">A</div>
          </div>
        </header>
        <div className="mx-auto max-w-[1400px] p-5 pb-32 md:px-8 md:py-7">
        {loadError && (
          <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span>{loadError}</span>
            <button type="button" onClick={() => loadAll()} className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800">
              Retry
            </button>
          </div>
        )}
        {VOICE_ENABLED && (
          <>
            <button
              type="button"
              onClick={() => setAssistantOpen(current => !current)}
              className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600 text-white shadow-xl shadow-indigo-900/30 transition hover:scale-105 hover:bg-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-300"
              aria-label={assistantOpen ? "Close Lalitha AI Assistant" : "Open Lalitha AI Assistant"}
              aria-expanded={assistantOpen}
            >
              {assistantOpen ? <X size={23} /> : <MessageCircle size={23} />}
            </button>
            {assistantOpen && (
              <Suspense fallback={
                <div className="fixed bottom-24 right-6 z-40 w-[min(360px,calc(100vw-32px))] rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500 shadow-2xl">
                  Loading Lalitha AI Assistant…
                </div>
              }>
                <VoiceAssistantPanel
                  apiFetch={apiFetch}
                  apiBase={API}
                  onOpenInvoice={openInvoicePdf}
                  onDataChanged={loadAll}
                  onClose={() => setAssistantOpen(false)}
                />
              </Suspense>
            )}
          </>
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
                    <p className="text-xs font-medium text-slate-400">Order &amp; payment pipeline</p>
                    <h2 className="mt-2 text-xl font-semibold">Keep every job on track</h2>
                    <p className="mt-1 max-w-lg text-sm text-slate-500">See new orders, advances, outstanding balances, and completed payments at a glance.</p>
                  </div>
                  <Palette size={34} className="text-blue-600" />
                </div>
                <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {productionStages.map(stage => {
                    const Icon = stage.icon;
                    return (
                      <div key={stage.label} className={`rounded-xl ${stage.bg} p-3`}>
                        <Icon size={16} className={`mb-2 ${stage.color}`} />
                        <p className="text-xl font-bold">{stage.value}</p>
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
                  aria-label="Select customer"
                  value={orderForm.customer_id}
                  onChange={e => handleSelectCustomerForOrder(e.target.value)}
                  className="w-full mt-1 px-3 py-2.5 rounded-lg bg-slate-950 border border-slate-800"
                >
                  <option value="">-- Choose Customer --</option>
                  {customers.map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({c.phone})</option>
                  ))}
                </select>
                {customers.length === 0 && (
                  <p className="mt-1 text-[11px] text-amber-700">
                    No customers yet.{" "}
                    <button type="button" onClick={() => setTab("customers")} className="font-semibold underline">
                      Add a customer
                    </button>{" "}
                    first.
                  </p>
                )}
              </div>

              <div>
                <label className="text-xs text-slate-400">2. Select Product / Work Type</label>
                <select
                  required
                  aria-label="Select product or work type"
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
                  aria-label="Order date"
                  value={orderForm.order_date}
                  onChange={e => setOrderForm({ ...orderForm, order_date: e.target.value })}
                  className="w-full mt-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800"
                />
              </div>

              <div>
                <label className="text-xs text-slate-400">Delivery Date</label>
                <input
                  type="date"
                  aria-label="Delivery date"
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
                      aria-label="Embroidery rate category"
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
                      aria-label="Number of stitches"
                      min="1"
                      step="1"
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
                        aria-label={`${field} measurement in inches`}
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
                  aria-label="Cloth and design description notes"
                  placeholder="E.g., Dark green raw silk, peacock zardosi on sleeve, deep U back neck with dori, front hook..."
                  value={orderForm.description}
                  onChange={e => setOrderForm({ ...orderForm, description: e.target.value })}
                  className="w-full mt-2 p-3 rounded-lg bg-slate-950 border border-slate-800 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-300">5. Reference Image (Optional)</label>
                <p className="mt-1 text-xs text-slate-400">JPEG or PNG, maximum 4 MB. Used only for the PDF generated now; it is not saved.</p>
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
                        if (file.size > 4 * 1024 * 1024) {
                          alert("Reference image must be 4 MB or smaller.");
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
                            if (!["image/jpeg", "image/png"].includes(file.type) || file.size > 4 * 1024 * 1024) {
                              alert("Choose a JPEG or PNG image up to 4 MB.");
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
                      aria-label="Base price in rupees"
                      min="0"
                      step="0.01"
                      value={orderForm.base_amount}
                      onChange={e => setOrderForm({ ...orderForm, base_amount: e.target.value })}
                      className="w-full mt-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400">Extra Aari / Design Charge (₹)</label>
                    <input
                      type="number"
                      aria-label="Extra design charge in rupees"
                      min="0"
                      step="0.01"
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
                  aria-label="Advance amount paid now in rupees"
                  min="0"
                  step="0.01"
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
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h1 className="text-2xl font-bold">Orders &amp; PDF Invoices</h1>
                <p className="mt-1 text-xs text-slate-400">Search, filter, collect payments, and share invoices.</p>
              </div>
              <button
                type="button"
                onClick={() => setTab("new-order")}
                className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
              >
                + New order
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-800 bg-slate-900 p-3">
              <label className="sr-only" htmlFor="order-search">Search orders</label>
              <input
                id="order-search"
                type="search"
                placeholder="Search invoice, customer, phone, product..."
                value={orderFilter.search}
                onChange={e => setOrderFilter(prev => ({ ...prev, search: e.target.value }))}
                className="min-w-[220px] flex-1 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs"
              />
              <label className="sr-only" htmlFor="order-status-filter">Filter by payment status</label>
              <select
                id="order-status-filter"
                value={orderFilter.status}
                onChange={e => setOrderFilter(prev => ({ ...prev, status: e.target.value }))}
                className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs"
              >
                <option value="ALL">All statuses</option>
                <option value="Pending">Pending</option>
                <option value="Partially Paid">Partially paid</option>
                <option value="Paid">Paid</option>
              </select>
              {(orderFilter.search || orderFilter.status !== "ALL") && (
                <button
                  type="button"
                  onClick={() => setOrderFilter({ search: "", status: "ALL" })}
                  className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800"
                >
                  Clear
                </button>
              )}
              <span className="text-xs text-slate-400">
                {filteredOrders.length} of {orders.length} order(s)
              </span>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 overflow-x-auto">
              {orders.length === 0 ? (
                <div className="py-10 text-center">
                  <Receipt size={28} className="mx-auto text-slate-500" />
                  <p className="mt-3 text-sm font-semibold">No orders yet</p>
                  <p className="mt-1 text-xs text-slate-400">Create your first order to generate an invoice PDF.</p>
                  <button
                    type="button"
                    onClick={() => setTab("new-order")}
                    className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
                  >
                    Create an order
                  </button>
                </div>
              ) : filteredOrders.length === 0 ? (
                <div className="py-10 text-center">
                  <Search size={26} className="mx-auto text-slate-500" />
                  <p className="mt-3 text-sm font-semibold">No orders match this filter</p>
                  <button
                    type="button"
                    onClick={() => setOrderFilter({ search: "", status: "ALL" })}
                    className="mt-4 rounded-lg border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800"
                  >
                    Clear filters
                  </button>
                </div>
              ) : (
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
                    {filteredOrders.map(o => (
                      <tr key={o.id}>
                        <td className="py-3 font-mono text-xs text-indigo-400">{o.invoice_number}</td>
                        <td>{o.order_date}</td>
                        <td>{o.customer_name} ({o.customer_phone})</td>
                        <td>{o.product_name}</td>
                        <td>₹{o.total_amount}</td>
                        <td className="text-emerald-400">₹{o.paid_amount}</td>
                        <td className={o.balance > 0 ? "text-amber-400 font-bold" : "text-slate-500"}>₹{o.balance}</td>
                        <td>
                          <span className={`px-2 py-0.5 rounded text-xs ${
                            o.status === 'Paid'
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : o.status === 'Partially Paid'
                                ? 'bg-blue-500/20 text-blue-300'
                                : 'bg-amber-500/20 text-amber-300'
                          }`}>
                            {o.status}
                          </span>
                        </td>
                        <td className="py-2 flex flex-wrap gap-1.5">
                          <button
                            onClick={() => openInvoicePdf(o.id)}
                            aria-label={`Download PDF invoice ${o.invoice_number}`}
                            className="px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs flex items-center gap-1"
                          >
                            <Download size={13} /> PDF Bill
                          </button>
                          <button
                            onClick={() => sendWhatsAppMsg(o, "bill")}
                            aria-label={`Send WhatsApp bill for ${o.invoice_number}`}
                            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs"
                          >
                            WA Bill
                          </button>
                          <button
                            onClick={() => sendInvoicePdfOnWhatsApp(o)}
                            aria-label={`Send PDF invoice ${o.invoice_number} on WhatsApp`}
                            className="px-2.5 py-1 rounded bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs flex items-center gap-1"
                          >
                            <FileUp size={13} /> Send PDF
                          </button>
                          <button
                            onClick={() => sendWhatsAppMsg(o, "ready")}
                            aria-label={`Send ready message for ${o.invoice_number}`}
                            className="px-2.5 py-1 rounded bg-emerald-600/20 text-emerald-300 text-xs"
                          >
                            WA Ready
                          </button>
                          <button
                            onClick={() => removeOrder(o)}
                            aria-label={`Delete order ${o.invoice_number}`}
                            className="px-2.5 py-1 rounded bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 text-xs flex items-center gap-1"
                          >
                            <Trash2 size={13} /> Delete
                          </button>
                          {o.balance > 0 && (
                            <button
                              onClick={() => openPayment(o)}
                              aria-label={`Collect payment for ${o.invoice_number}`}
                              className="px-2.5 py-1 rounded bg-amber-500/20 text-amber-300 text-xs flex items-center gap-1"
                            >
                              <CheckCircle2 size={13} /> Collect payment
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* 4. CUSTOMERS */}
        {tab === "customers" && (
          <div className="space-y-4">
            <div>
              <h1 className="text-2xl font-bold">Customers</h1>
              <p className="mt-1 text-xs text-slate-400">Add customers, keep phone numbers tidy, and review saved measurements.</p>
            </div>
            <div className="grid items-start gap-6 md:grid-cols-[minmax(240px,280px)_minmax(0,1fr)]">
            <form
              onSubmit={async e => {
                e.preventDefault();
                if (savingCustomer) return;
                setSavingCustomer(true);
                setCustFeedback(null);
                try {
                  const response = await apiFetch(`${API}/customers`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      ...newCust,
                      name: newCust.name.trim(),
                      phone: newCust.phone.trim(),
                      alternate_phone: newCust.alternate_phone.trim(),
                    })
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
                  setCustFeedback({ type: "success", text: `Saved ${result.name || "customer"} successfully.` });
                  await loadAll();
                } catch (error) {
                  setCustFeedback({ type: "error", text: error.message || "Customer could not be saved. Check that the backend is running." });
                } finally {
                  setSavingCustomer(false);
                }
              }}
              className="h-fit space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5"
            >
              <h3 className="font-bold text-base">+ Add Customer</h3>
              {custFeedback && (
                <div
                  role="status"
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    custFeedback.type === "success"
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                      : "border-rose-500/40 bg-rose-500/10 text-rose-300"
                  }`}
                >
                  {custFeedback.text}
                </div>
              )}
              <div>
                <label htmlFor="new-customer-name" className="mb-1 block text-xs text-slate-400">Customer name</label>
                <input
                  id="new-customer-name"
                  required
                  placeholder="Customer Name"
                  value={newCust.name}
                  onChange={e => setNewCust({ ...newCust, name: e.target.value })}
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label htmlFor="new-customer-phone" className="mb-1 block text-xs text-slate-400">Phone number</label>
                <input
                  id="new-customer-phone"
                  required
                  type="tel"
                  inputMode="numeric"
                  pattern="[0-9]{10}"
                  maxLength={10}
                  title="Enter exactly 10 digits, without spaces or country code."
                  placeholder="10-Digit Phone Number"
                  value={newCust.phone}
                  onChange={e => setNewCust({ ...newCust, phone: e.target.value.replace(/\D/g, "").slice(0, 10) })}
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label htmlFor="new-customer-alt-phone" className="mb-1 block text-xs text-slate-400">Alternate phone (optional)</label>
                <input
                  id="new-customer-alt-phone"
                  type="tel"
                  inputMode="numeric"
                  pattern="[0-9]{10}"
                  maxLength={10}
                  title="Enter exactly 10 digits, or leave blank."
                  placeholder="Alternate Phone"
                  value={newCust.alternate_phone}
                  onChange={e => setNewCust({ ...newCust, alternate_phone: e.target.value.replace(/\D/g, "").slice(0, 10) })}
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="new-customer-city" className="mb-1 block text-xs text-slate-400">City</label>
                  <input
                    id="new-customer-city"
                    placeholder="City"
                    value={newCust.city}
                    onChange={e => setNewCust({ ...newCust, city: e.target.value })}
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="new-customer-address" className="mb-1 block text-xs text-slate-400">Address / Area</label>
                  <input
                    id="new-customer-address"
                    placeholder="Address / Area"
                    value={newCust.address}
                    onChange={e => setNewCust({ ...newCust, address: e.target.value })}
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="new-customer-notes" className="mb-1 block text-xs text-slate-400">Special notes</label>
                <textarea
                  id="new-customer-notes"
                  rows={2}
                  placeholder="Special Notes"
                  value={newCust.notes}
                  onChange={e => setNewCust({ ...newCust, notes: e.target.value })}
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
                />
              </div>
              {newCust.phone.trim().length === 10 && customers.find(c => c.phone === newCust.phone.trim()) && (
                <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                  This phone number already belongs to{" "}
                  <span className="font-semibold">{customers.find(c => c.phone === newCust.phone.trim())?.name}</span>.{" "}
                  <button
                    type="button"
                    className="font-semibold underline"
                    onClick={() => startEditCustomer(customers.find(c => c.phone === newCust.phone.trim()))}
                  >
                    Edit that customer
                  </button>{" "}
                  instead of creating a duplicate.
                </p>
              )}
              <button
                type="submit"
                disabled={savingCustomer}
                className="w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {savingCustomer ? "Saving..." : "Save Customer"}
              </button>
            </form>

            <div className="min-w-0 bg-slate-900 border border-slate-800 p-5 rounded-2xl">
              <div className="sticky top-0 z-10 -mx-1 mb-4 flex flex-wrap items-center justify-between gap-3 bg-white px-1 pb-3">
                <div>
                  <h3 className="font-bold">Customer Directory</h3>
                  <p className="mt-1 text-xs text-slate-400">Saved measurements and order history</p>
                </div>
                <div className="w-full max-w-[240px]">
                  <label htmlFor="customer-search" className="sr-only">Search customers by name or phone</label>
                  <input
                    id="customer-search"
                    type="search"
                    placeholder="Search name or phone..."
                    value={custSearch}
                    onChange={e => setCustSearch(e.target.value)}
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs"
                  />
                </div>
              </div>
              <div className="max-h-[calc(100vh-230px)] min-h-[260px] space-y-3 overflow-y-auto pr-2">
                {customers.length === 0 && (
                  <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
                    <Users size={24} className="mx-auto text-slate-400" />
                    <p className="mt-2 text-sm font-semibold text-slate-700">
                      {custSearch ? "No matching customers" : "No customers yet"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {custSearch ? "Try a different name or phone number." : "Use the form to add your first customer."}
                    </p>
                  </div>
                )}
                {customers.map(c => (
                  <div key={c.id} className="grid gap-4 rounded-xl border border-slate-800 bg-slate-950 p-4 sm:grid-cols-[minmax(0,1fr)_150px] sm:items-start">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm">{c.name} <span className="text-xs text-indigo-400">({c.cust_code})</span></p>
                      <p className="mt-1 break-words text-xs text-slate-400">
                        {c.phone}
                        {c.alternate_phone ? ` / ${c.alternate_phone}` : ""}
                        {c.city ? ` • ${c.city}` : ""}
                        {c.address ? ` • ${c.address}` : ""}
                      </p>
                      {c.notes ? (
                        <p className="mt-1 break-words text-[11px] text-slate-500">Notes: {c.notes}</p>
                      ) : null}
                      {Object.keys(c.last_measurements || {}).length > 0 && (
                        <p className="mt-2 break-words text-[11px] leading-5 text-emerald-400">
                          Saved Measurements: {Object.entries(c.last_measurements).map(([k, v]) => `${k}: ${v}"`).join(" | ")}
                        </p>
                      )}
                    </div>
                    <div className="flex items-start justify-between gap-3 border-t border-slate-800 pt-3 sm:block sm:border-t-0 sm:pt-0 sm:text-right">
                      <p className="text-xs text-slate-400">{c.order_count} Orders</p>
                      <p className="font-bold text-sm text-white">Total Spent: ₹{c.total_spent}</p>
                      <div className="mt-2 flex flex-wrap justify-end gap-2">
                        <button
                          onClick={() => startEditCustomer(c)}
                          className="px-2.5 py-1.5 rounded bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 text-xs inline-flex items-center gap-1"
                        >
                          <Pencil size={12} /> Edit customer
                        </button>
                        <button
                          onClick={() => removeCustomer(c)}
                          className="px-2.5 py-1.5 rounded bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 text-xs inline-flex items-center gap-1"
                        >
                          <Trash2 size={12} /> Delete customer
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {editingCustomer && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
                role="dialog"
                aria-modal="true"
                aria-labelledby="edit-customer-title"
              >
                <form
                  onSubmit={saveCustomerEdit}
                  className="max-h-[90vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-2xl"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 id="edit-customer-title" className="text-base font-bold">Edit customer</h3>
                      <p className="mt-0.5 text-xs text-slate-400">{editingCustomer.cust_code}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setEditingCustomer(null)}
                      aria-label="Close edit customer"
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
                    >
                      <X size={16} />
                    </button>
                  </div>
                  {editCustError && (
                    <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                      {editCustError}
                    </div>
                  )}
                  <div>
                    <label htmlFor="edit-customer-name" className="text-xs text-slate-400">Customer Name</label>
                    <input
                      id="edit-customer-name"
                      ref={editCustomerNameRef}
                      required
                      value={editCust.name}
                      onChange={e => setEditCust({ ...editCust, name: e.target.value })}
                      className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor="edit-customer-phone" className="text-xs text-slate-400">Phone Number</label>
                      <input
                        id="edit-customer-phone"
                        required
                        type="tel"
                        inputMode="numeric"
                        pattern="[0-9]{10}"
                        maxLength={10}
                        title="Enter exactly 10 digits, without spaces or country code."
                        value={editCust.phone}
                        onChange={e => setEditCust({ ...editCust, phone: e.target.value.replace(/\D/g, "").slice(0, 10) })}
                        className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label htmlFor="edit-customer-alt-phone" className="text-xs text-slate-400">Alternate Phone</label>
                      <input
                        id="edit-customer-alt-phone"
                        type="tel"
                        inputMode="numeric"
                        pattern="[0-9]{10}"
                        maxLength={10}
                        title="Enter exactly 10 digits, or leave blank."
                        value={editCust.alternate_phone}
                        onChange={e => setEditCust({ ...editCust, alternate_phone: e.target.value.replace(/\D/g, "").slice(0, 10) })}
                        className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor="edit-customer-address" className="text-xs text-slate-400">Address / Area</label>
                      <input
                        id="edit-customer-address"
                        value={editCust.address}
                        onChange={e => setEditCust({ ...editCust, address: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label htmlFor="edit-customer-city" className="text-xs text-slate-400">City</label>
                      <input
                        id="edit-customer-city"
                        value={editCust.city}
                        onChange={e => setEditCust({ ...editCust, city: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="edit-customer-notes" className="text-xs text-slate-400">Special Notes</label>
                    <textarea
                      id="edit-customer-notes"
                      rows={3}
                      value={editCust.notes}
                      onChange={e => setEditCust({ ...editCust, notes: e.target.value })}
                      className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
                    <button
                      type="button"
                      onClick={() => setEditingCustomer(null)}
                      className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={savingCustomer}
                      className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {savingCustomer ? "Saving..." : "Save changes"}
                    </button>
                  </div>
                </form>
              </div>
            )}
            </div>
          </div>
        )}

        {/* 5. PRODUCTS, TEMPLATES & STITCH RATES */}
        {tab === "products" && (
          <div className="space-y-6">
            <div>
              <h1 className="text-2xl font-bold">Products &amp; Measurement Templates</h1>
              <p className="mt-1 text-xs text-slate-400">Manage stitch rates, product pricing, and reusable measurement checklists.</p>
            </div>
            {productFeedback && (
              <div
                role="status"
                className={`rounded-xl border px-4 py-3 text-sm ${
                  productFeedback.type === "success"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : "border-rose-500/40 bg-rose-500/10 text-rose-300"
                }`}
              >
                {productFeedback.text}
              </div>
            )}
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
                        if (!val) return;
                        const numeric = Number(val);
                        if (!Number.isFinite(numeric) || numeric <= 0) {
                          setProductFeedback({ type: "error", text: "Rate must be a number greater than 0." });
                          return;
                        }
                        try {
                          const response = await apiFetch(`${API}/embroidery-rates`, {
                            method: "PUT",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ category: r.category, rate_per_stitch: numeric })
                          });
                          const body = await response.json().catch(() => ({}));
                          if (!response.ok) throw new Error(body.detail || "Rate could not be saved.");
                          setProductFeedback({ type: "success", text: `${r.category} rate updated to ₹${numeric} per stitch.` });
                          await loadAll();
                        } catch (error) {
                          setProductFeedback({ type: "error", text: error.message });
                        }
                      }}
                      aria-label={`Edit rate for ${r.category}`}
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
                  setProductFeedback(null);
                  try {
                    const response = await apiFetch(`${API}/products`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        ...newProd,
                        base_price: Number(newProd.base_price),
                        measurement_template_id: newProd.measurement_template_id ? Number(newProd.measurement_template_id) : null
                      })
                    });
                    const body = await response.json().catch(() => ({}));
                    if (!response.ok) throw new Error(body.detail || "Product could not be saved.");
                    setNewProd({ name: "", pricing_type: "MANUAL", base_price: 500, measurement_template_id: "" });
                    setProductFeedback({ type: "success", text: `Product ${body.name || ""} added.`.trim() });
                    await loadAll();
                  } catch (error) {
                    setProductFeedback({ type: "error", text: error.message });
                  }
                }}
                className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-3"
              >
                <h3 className="font-bold text-sm">+ Add Custom Product</h3>
                <div>
                  <label htmlFor="product-name" className="mb-1 block text-xs text-slate-400">Product name</label>
                  <input id="product-name" required placeholder="Product Name" value={newProd.name} onChange={e => setNewProd({ ...newProd, name: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
                </div>
                <div>
                  <label htmlFor="product-pricing-type" className="mb-1 block text-xs text-slate-400">Pricing method</label>
                  <select id="product-pricing-type" value={newProd.pricing_type} onChange={e => setNewProd({ ...newProd, pricing_type: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm">
                    <option value="MANUAL">Fixed / Manual Price</option>
                    <option value="BASE_PLUS_EXTRA">Base + Extra Work Charge</option>
                    <option value="STITCH_BASED">Embroidery Stitch-Based</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="product-base-price" className="mb-1 block text-xs text-slate-400">Default base price (₹)</label>
                  <input id="product-base-price" type="number" min="0" step="0.01" placeholder="Default Base Price (₹)" value={newProd.base_price} onChange={e => setNewProd({ ...newProd, base_price: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
                </div>
                <div>
                  <label htmlFor="product-template" className="mb-1 block text-xs text-slate-400">Measurement template</label>
                  <select id="product-template" value={newProd.measurement_template_id} onChange={e => setNewProd({ ...newProd, measurement_template_id: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm">
                    <option value="">No Measurement Needed (Saree Falls / Embroidery)</option>
                    {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <p className="text-[11px] text-slate-400">
                  The selected template becomes the required measurement checklist whenever this product is ordered.
                </p>
                <button className="w-full py-2 rounded-xl bg-indigo-600 font-semibold text-sm">Add Product</button>
              </form>

              {/* Add Custom Measurement Template */}
              <form
                onSubmit={async e => {
                  e.preventDefault();
                  setProductFeedback(null);
                  try {
                    const fields = newTmpl.fieldsCSV.split(",").map(field => field.trim()).filter(Boolean);
                    if (fields.length === 0) throw new Error("Add at least one measurement field.");
                    const response = await apiFetch(`${API}/templates`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ name: newTmpl.name, fields })
                    });
                    const body = await response.json().catch(() => ({}));
                    if (!response.ok) throw new Error(body.detail || "Template could not be saved.");
                    setNewTmpl({ name: "", fieldsCSV: "" });
                    setProductFeedback({ type: "success", text: `Measurement template ${body.name || ""} created.`.trim() });
                    await loadAll();
                  } catch (error) {
                    setProductFeedback({ type: "error", text: error.message });
                  }
                }}
                className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-3"
              >
                <h3 className="font-bold text-sm">+ Create Custom Measurement Template</h3>
                <div>
                  <label htmlFor="template-name" className="mb-1 block text-xs text-slate-400">Template name</label>
                  <input id="template-name" required placeholder="Template Name (e.g. Kids Pavadai)" value={newTmpl.name} onChange={e => setNewTmpl({ ...newTmpl, name: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
                </div>
                <div>
                  <label htmlFor="template-fields" className="mb-1 block text-xs text-slate-400">Measurement fields (comma-separated)</label>
                  <textarea id="template-fields" required rows={3} placeholder="Comma-separated fields (e.g. Chest, Waist, Skirt Length, Shoulder)" value={newTmpl.fieldsCSV} onChange={e => setNewTmpl({ ...newTmpl, fieldsCSV: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
                </div>
                <button className="w-full py-2 rounded-xl bg-indigo-600 font-semibold text-sm">Save Measurement Template</button>
              </form>
            </div>

            {/* Product List */}
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
              <h3 className="font-bold mb-3 text-sm">All Products (Activate / Deactivate)</h3>
              {products.length === 0 ? (
                <p className="text-sm text-slate-500">No products yet. Add one using the form above.</p>
              ) : (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {products.map(p => (
                    <div key={p.id} className="p-3 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between">
                      <div>
                        <p className="font-semibold text-sm">{p.name}</p>
                        <p className="text-xs text-slate-400">{p.pricing_type} • Base ₹{p.base_price}</p>
                      </div>
                      <button
                        onClick={async () => {
                          try {
                            const response = await apiFetch(`${API}/products/${p.id}/toggle`, { method: "PATCH" });
                            if (!response.ok) {
                              const body = await response.json().catch(() => ({}));
                              throw new Error(body.detail || "Product status could not be changed.");
                            }
                            await loadAll();
                          } catch (error) {
                            setProductFeedback({ type: "error", text: error.message });
                          }
                        }}
                        aria-label={`${p.active ? "Deactivate" : "Activate"} ${p.name}`}
                        className={`px-2.5 py-1 rounded text-xs font-semibold ${p.active ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"}`}
                      >
                        {p.active ? "Active" : "Deactivated"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Measurement templates */}
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
              <h3 className="font-bold mb-3 text-sm">Measurement Templates</h3>
              {templates.length === 0 ? (
                <p className="text-sm text-slate-500">No templates yet. Create one to collect measurements for a product.</p>
              ) : (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {templates.map(t => (
                    <div key={t.id} className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                      <p className="font-semibold text-sm">{t.name}</p>
                      <p className="mt-1 break-words text-xs text-slate-400">
                        {(t.fields || []).join(", ") || "No fields"}
                      </p>
                    </div>
                  ))}
                </div>
              )}
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
                  <button
                    key={period}
                    type="button"
                    onClick={() => setFinancePeriod(period)}
                    aria-pressed={financePeriod === period}
                    className={`px-3 py-2 rounded-lg text-xs font-semibold transition ${
                      financePeriod === period
                        ? "bg-indigo-600 text-white shadow"
                        : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <button onClick={() => downloadFinanceExport("csv").catch(error => setTxFeedback({ type: "error", text: error.message }))} className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-semibold">
                  Export CSV
                </button>
                <button onClick={() => downloadFinanceExport("pdf").catch(error => setTxFeedback({ type: "error", text: error.message }))} className="px-3 py-2 rounded-lg bg-indigo-600 text-white text-xs font-semibold">
                  Export PDF
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white p-4">
              <span className="text-xs font-semibold text-slate-600">Custom period</span>
              <input aria-label="Finance start date" type="date" value={dateRange.start} onChange={e => { setFinancePeriodState("custom"); setDateRange({ ...dateRange, start: e.target.value }); }} className="px-3 py-2 rounded-lg text-xs" />
              <span className="text-xs text-slate-500">to</span>
              <input aria-label="Finance end date" type="date" value={dateRange.end} onChange={e => { setFinancePeriodState("custom"); setDateRange({ ...dateRange, end: e.target.value }); }} className="px-3 py-2 rounded-lg text-xs" />
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

            <Suspense fallback={<div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Loading charts…</div>}>
              <FinanceCharts finance={finance} />
            </Suspense>

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
                  setTxFeedback(null);
                  try {
                    const response = await apiFetch(`${API}/transactions`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ ...newTx, amount: Number(newTx.amount) })
                    });
                    const body = await response.json().catch(() => ({}));
                    if (!response.ok) throw new Error(body.detail || "Entry could not be saved.");
                    setNewTx({ ...newTx, description: "", amount: "" });
                    setTxFeedback({ type: "success", text: "Ledger entry saved." });
                    await loadAll();
                  } catch (error) {
                    setTxFeedback({ type: "error", text: error.message });
                  }
                }}
                className="bg-slate-900 border border-slate-800 p-5 rounded-2xl space-y-3 h-fit"
              >
                <h3 className="font-bold text-sm">+ Record Expense / Extra Income</h3>
                {txFeedback && (
                  <div
                    role="status"
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      txFeedback.type === "success"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                        : "border-rose-500/40 bg-rose-500/10 text-rose-300"
                    }`}
                  >
                    {txFeedback.text}
                  </div>
                )}
                <label className="block text-xs font-medium text-slate-500" htmlFor="transaction-type">Entry type</label>
                <select id="transaction-type" value={newTx.type} onChange={e => setNewTx({ ...newTx, type: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm">
                  <option value="EXPENSE">DEBIT (Expense Out)</option>
                  <option value="INCOME">CREDIT (Manual Income In)</option>
                </select>
                <label className="block text-xs font-medium text-slate-500" htmlFor="transaction-date">Entry date</label>
                <input id="transaction-date" type="date" value={newTx.date} onChange={e => setNewTx({ ...newTx, date: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
                <label className="block text-xs font-medium text-slate-500" htmlFor="transaction-category">Category</label>
                <input id="transaction-category" required placeholder="Category (Thread, Zari, Rent, Electricity)" value={newTx.category} onChange={e => setNewTx({ ...newTx, category: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
                <label className="block text-xs font-medium text-slate-500" htmlFor="transaction-amount">Amount (₹)</label>
                <input id="transaction-amount" required type="number" min="0.01" step="0.01" placeholder="Amount (₹)" value={newTx.amount} onChange={e => setNewTx({ ...newTx, amount: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
                <label className="block text-xs font-medium text-slate-500" htmlFor="transaction-description">Description / bill reference</label>
                <input id="transaction-description" placeholder="Description / Bill Ref" value={newTx.description} onChange={e => setNewTx({ ...newTx, description: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm" />
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
                    {finance.transactions.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-sm text-slate-500">
                          No ledger entries in this period. Add an expense or income entry to start tracking cash flow.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
        </div>
      </main>

      <PaymentDialog
        order={paymentTarget}
        amount={paymentAmount}
        setAmount={setPaymentAmount}
        method={paymentMethod}
        setMethod={setPaymentMethod}
        error={paymentError}
        busy={paymentBusy}
        onClose={closePayment}
        onSubmit={submitPayment}
      />
      <ConfirmDialog state={confirmState} onResolve={resolveConfirm} />
      <Toast toast={toast} />
    </div>
  );
}

function MobileMetric({ Icon, label, value, hint }) {
  return (
    <div className="mobile-metric">
      <div className="mobile-metric-top">
        <Icon size={18} aria-hidden="true" />
        <span>{label}</span>
      </div>
      <p className="mobile-metric-value">{value}</p>
      {hint && <p className="mobile-metric-hint">{hint}</p>}
    </div>
  );
}

function MobileOrderCard({ order, onOpen, onPay }) {
  if (!order) return null;
  const overdue = orderOverdue(order);
  return (
    <article className="mobile-order-card">
      <button type="button" className="mobile-order-main" onClick={() => onOpen(order)}>
        <span className="mobile-order-top">
          <span className="min-w-0">
            <span className="mobile-order-invoice">{order.invoice_number}</span>
            <strong className="mobile-order-customer">{order.customer_name}</strong>
            <span className="mobile-order-product">{order.product_name}</span>
          </span>
          <span className={`mobile-status ${statusTone(order.status)}`}>{statusLabel(order.status)}</span>
        </span>
        <span className="mobile-order-meta">
          <span><small>Total</small> {money(order.total_amount)}</span>
          <span><small>Paid</small> {money(order.paid_amount)}</span>
          <span className={Number(order.balance) > 0 ? "is-due" : "is-clear"}><small>Balance</small> {money(order.balance)}</span>
        </span>
      </button>
      <div className="mobile-order-footer">
        <span className={overdue ? "mobile-due is-overdue" : "mobile-due"}>
          <CalendarDays size={15} aria-hidden="true" />
          {order.delivery_date ? `Delivery ${shortDate(order.delivery_date)}` : "No delivery date"}
          {overdue ? " · overdue" : ""}
        </span>
        {Number(order.balance) > 0 && onPay && (
          <button type="button" className="mobile-small-button" onClick={() => onPay(order)}>
            Collect
          </button>
        )}
      </div>
    </article>
  );
}

function MobileCustomerCard({ customer, onOpen, onCall }) {
  const initials = String(customer.name || "?").trim().slice(0, 1).toUpperCase();
  return (
    <article className="mobile-customer-card">
      <button type="button" className="mobile-customer-main" onClick={() => onOpen(customer)}>
        <span className="mobile-customer-avatar" aria-hidden="true">{initials}</span>
        <span className="min-w-0">
          <strong>{customer.name}</strong>
          <small>{customer.phone}{customer.city ? ` · ${customer.city}` : ""}</small>
          <span className="mobile-customer-meta">
            {customer.order_count || 0} order(s) · {money(customer.total_spent)}
          </span>
        </span>
        <ChevronRight size={18} aria-hidden="true" />
      </button>
      {customer.phone && (
        <button type="button" className="mobile-call-button" onClick={() => onCall(customer.phone)} aria-label={`Call ${customer.name}`}>
          <Phone size={17} /> Call
        </button>
      )}
    </article>
  );
}

function MobileEmptyState({ Icon, title, text, actionLabel, onAction }) {
  return (
    <div className="mobile-empty">
      <Icon size={28} aria-hidden="true" />
      <p>{title}</p>
      <span>{text}</span>
      {actionLabel && onAction && (
        <button type="button" className="mobile-secondary-button" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}

function MobileLoading({ label }) {
  return (
    <div className="mobile-loading" role="status">
      <div className="mobile-loading-lines" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <span>{label || "Preparing your workspace…"}</span>
    </div>
  );
}

function NotFoundPage({ onHome }) {
  return (
    <div className="not-found-page">
      <div className="not-found-card" role="main">
        <span className="not-found-code">404</span>
        <h1>We could not find that page</h1>
        <p>The page may have moved, or the link may be incorrect. Your saved shop data is safe.</p>
        <button type="button" onClick={onHome}>Back to home</button>
      </div>
    </div>
  );
}

function PaymentDialog({ order, amount, setAmount, method, setMethod, error, busy, onClose, onSubmit }) {
  if (!order) return null;
  const numeric = Number(amount || 0);
  const remaining = Math.max(0, Number(order.balance) - numeric);
  return (
    <div className="mobile-dialog-backdrop" role="presentation">
      <div className="mobile-dialog" role="dialog" aria-modal="true" aria-labelledby="payment-dialog-title">
        <div className="mobile-dialog-head">
          <div>
            <h2 id="payment-dialog-title">Collect payment</h2>
            <p>{order.customer_name} · {order.invoice_number}</p>
          </div>
          <button type="button" className="mobile-icon-button" onClick={onClose} disabled={busy} aria-label="Close payment dialog">
            <X size={20} />
          </button>
        </div>
        <div className="mobile-total-card">
          <div><span>Order total</span><strong>{money(order.total_amount)}</strong></div>
          <div><span>Already paid</span><strong>{money(order.paid_amount)}</strong></div>
          <div className="is-balance"><span>Balance due</span><strong>{money(order.balance)}</strong></div>
        </div>
        <form onSubmit={event => { event.preventDefault(); onSubmit(); }}>
          <label className="mobile-field">
            <span>Amount to collect (₹)</span>
            <input
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={event => setAmount(event.target.value)}
              placeholder="0.00"
            />
          </label>
          <div className="mobile-chip-row">
            <button type="button" className="mobile-chip" onClick={() => setAmount(String(order.balance))}>
              Full balance {money(order.balance)}
            </button>
            <button type="button" className={`mobile-chip ${method === "Cash/UPI" ? "is-active" : ""}`} onClick={() => setMethod("Cash/UPI")}>
              Cash / UPI
            </button>
          </div>
          <div className="mobile-summary-row">
            <span>Balance after this payment</span>
            <strong>{money(remaining)}</strong>
          </div>
          {error && <div className="mobile-banner mobile-banner-danger" role="alert">{error}</div>}
          <p className="mobile-help">The server records this against the order and prevents duplicate submissions.</p>
          <div className="mobile-dialog-actions">
            <button type="button" className="mobile-secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="mobile-primary-button" disabled={busy || !Number.isFinite(numeric) || numeric <= 0}>
              {busy ? <><Loader2 size={18} className="spin" /> Recording…</> : `Confirm ${money(numeric)}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ConfirmDialog({ state, onResolve }) {
  if (!state) return null;
  return (
    <div className="mobile-dialog-backdrop" role="presentation">
      <div className="mobile-dialog mobile-dialog-small" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <div className="mobile-dialog-head">
          <h2 id="confirm-dialog-title">{state.title}</h2>
        </div>
        <p className="mobile-dialog-message">{state.message}</p>
        <div className="mobile-dialog-actions">
          <button type="button" className="mobile-secondary-button" onClick={() => onResolve(false)}>Cancel</button>
          <button
            type="button"
            className={state.danger ? "mobile-danger-button" : "mobile-primary-button"}
            onClick={() => onResolve(true)}
          >
            {state.confirmLabel || "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div className={`mobile-toast ${toast.type === "error" ? "is-error" : ""}`} role="status" aria-live="polite">
      {toast.type === "error" ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
      <span>{toast.text}</span>
    </div>
  );
}
