"use strict";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */
// Edit this list to change your categories.
const CATEGORIES = [
  "Food", "Groceries", "Transport", "Shopping",
  "Bills", "Health", "Fun", "Travel", "Other",
];

const LS = {
  url: "saver.sb_url",
  key: "saver.sb_key",
};

let sb = null; // supabase client

/* ------------------------------------------------------------------ */
/*  Tiny DOM helpers                                                   */
/* ------------------------------------------------------------------ */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showScreen(id) {
  $$(".screen").forEach((s) => s.classList.remove("active"));
  $("#" + id).classList.add("active");
}

function showStep(id) {
  $$("#screen-entry .step").forEach((s) => s.classList.remove("active"));
  $("#" + id).classList.add("active");
  updateProgress(id);
}

let toastTimer = null;
function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", !!isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

function haptic() {
  if (navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
}

/* ------------------------------------------------------------------ */
/*  Money formatting                                                   */
/* ------------------------------------------------------------------ */
function formatEuro(cents) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100);
  const c = String(abs % 100).padStart(2, "0");
  const grouped = euros.toLocaleString("en-US"); // 1,234
  return (neg ? "-" : "") + "€" + grouped + "." + c;
}

/* ------------------------------------------------------------------ */
/*  Entry flow state                                                   */
/* ------------------------------------------------------------------ */
const entry = {
  cents: 0,
  title: "",
  categories: [],
  kind: null,
};

function resetEntry() {
  entry.cents = 0;
  entry.title = "";
  entry.categories = [];
  entry.kind = null;
  renderAmount();
  $("#title-input").value = "";
  $$("#cats .chip").forEach((c) => c.classList.remove("selected"));
}

function renderAmount() {
  const el = $("#amount");
  el.textContent = formatEuro(entry.cents);
  el.classList.toggle("zero", entry.cents === 0);
}

function updateProgress(stepId) {
  const map = {
    "step-amount": "Amount",
    "step-title": "Title",
    "step-cats": "Category",
    "step-kind": "Need / Want",
    "step-saved": "",
  };
  $("#progress").textContent = map[stepId] || "";
}

function syncMiniAmount() {
  const txt = formatEuro(entry.cents);
  $("#title-amount").textContent = txt;
  $("#cats-amount").textContent = txt;
  $("#kind-amount").textContent = txt;
}

/* ---- keypad ---- */
function pressKey(k) {
  haptic();
  if (k === "clear") {
    entry.cents = 0;
  } else if (k === "back") {
    entry.cents = Math.floor(entry.cents / 10);
  } else {
    const d = parseInt(k, 10);
    if (entry.cents < 100000000) { // cap at 1,000,000.00
      entry.cents = entry.cents * 10 + d;
    }
  }
  renderAmount();
}

/* ---- categories chips ---- */
function buildChips() {
  const wrap = $("#cats");
  wrap.innerHTML = "";
  CATEGORIES.forEach((name) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.type = "button";
    b.textContent = name;
    b.addEventListener("click", () => {
      haptic();
      const i = entry.categories.indexOf(name);
      if (i >= 0) { entry.categories.splice(i, 1); b.classList.remove("selected"); }
      else { entry.categories.push(name); b.classList.add("selected"); }
    });
    wrap.appendChild(b);
  });
}

/* ------------------------------------------------------------------ */
/*  Save                                                               */
/* ------------------------------------------------------------------ */
async function saveExpense() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { toast("Not signed in", true); showScreen("screen-auth"); return; }

  const record = {
    user_id: user.id,
    amount: entry.cents / 100,
    title: entry.title || null,
    categories: entry.categories,
    kind: entry.kind,
  };

  // optimistic confirmation
  $("#saved-amount").textContent = formatEuro(entry.cents);
  showStep("step-saved");
  haptic();

  const { error } = await sb.from("expenses").insert(record);
  if (error) {
    console.error(error);
    toast("Couldn't save: " + error.message, true);
    showStep("step-kind");
    return;
  }

  setTimeout(() => {
    resetEntry();
    showStep("step-amount");
  }, 900);
}

/* ------------------------------------------------------------------ */
/*  History                                                            */
/* ------------------------------------------------------------------ */
function dayLabel(d) {
  const now = new Date();
  const isSame = (a, b) => a.toDateString() === b.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (isSame(d, now)) return "Today";
  if (isSame(d, yest)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

async function loadHistory() {
  const list = $("#hist-list");
  list.innerHTML = '<div class="hist-empty">Loading…</div>';

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  $("#hist-month-label").textContent =
    now.toLocaleDateString(undefined, { month: "long", year: "numeric" }) + " spent";

  const { data, error } = await sb
    .from("expenses")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) { list.innerHTML = '<div class="hist-empty">Error loading.</div>'; toast(error.message, true); return; }
  if (!data || data.length === 0) { list.innerHTML = '<div class="hist-empty">No expenses yet.</div>'; $("#hist-total").textContent = formatEuro(0); return; }

  // monthly total
  let monthCents = 0;
  data.forEach((r) => {
    if (new Date(r.created_at) >= new Date(monthStart)) {
      monthCents += Math.round((r.amount || 0) * 100);
    }
  });
  $("#hist-total").textContent = formatEuro(monthCents);

  // group by day
  list.innerHTML = "";
  let lastDay = null;
  data.forEach((r) => {
    const d = new Date(r.created_at);
    const key = d.toDateString();
    if (key !== lastDay) {
      lastDay = key;
      const h = document.createElement("div");
      h.className = "hist-day";
      h.textContent = dayLabel(d);
      list.appendChild(h);
    }
    list.appendChild(renderItem(r));
  });
}

function renderItem(r) {
  const cents = Math.round((r.amount || 0) * 100);
  const el = document.createElement("div");
  el.className = "hist-item";

  const dot = document.createElement("span");
  dot.className = "hi-kind " + (r.kind || "");
  el.appendChild(dot);

  const main = document.createElement("div");
  main.className = "hi-main";
  const title = document.createElement("div");
  title.className = "hi-title";
  title.textContent = r.title || "Untitled";
  const cats = document.createElement("div");
  cats.className = "hi-cats";
  cats.textContent = (r.categories || []).join(" · ") || "—";
  main.appendChild(title);
  main.appendChild(cats);
  el.appendChild(main);

  const amt = document.createElement("div");
  amt.className = "hi-amount";
  amt.textContent = formatEuro(cents);
  el.appendChild(amt);

  const del = document.createElement("button");
  del.className = "hi-del";
  del.textContent = "🗑";
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    const { error } = await sb.from("expenses").delete().eq("id", r.id);
    if (error) { toast(error.message, true); return; }
    haptic();
    el.remove();
    loadHistory();
  });
  el.appendChild(del);

  // tap row to reveal delete
  el.addEventListener("click", () => {
    $$(".hist-item.open").forEach((o) => { if (o !== el) o.classList.remove("open"); });
    el.classList.toggle("open");
  });

  return el;
}

/* ------------------------------------------------------------------ */
/*  Auth                                                               */
/* ------------------------------------------------------------------ */
async function signIn() {
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  if (!email || !email.includes("@")) { toast("Enter a valid email", true); return; }
  if (!password) { toast("Enter your password", true); return; }
  const btn = $("#auth-signin");
  btn.disabled = true; btn.textContent = "Signing in…";
  const { error } = await sb.auth.signInWithPassword({ email, password });
  btn.disabled = false; btn.textContent = "Sign in";
  if (error) {
    const msg = $("#auth-msg");
    if (/invalid login credentials/i.test(error.message)) {
      msg.hidden = false;
      msg.textContent = 'No account matches that email + password. Tap "Create account" to make one.';
    } else {
      toast(error.message, true);
    }
    return;
  }
  startApp();
}

async function signUp() {
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  if (!email || !email.includes("@")) { toast("Enter a valid email", true); return; }
  if (password.length < 6) { toast("Password must be at least 6 characters", true); return; }
  const btn = $("#auth-signup");
  btn.disabled = true; btn.textContent = "Creating…";
  const { data, error } = await sb.auth.signUp({ email, password });
  btn.disabled = false; btn.textContent = "Create account";
  if (error) { toast(error.message, true); return; }
  if (data.session) {
    startApp();
  } else {
    const msg = $("#auth-msg");
    msg.hidden = false;
    msg.textContent = 'Account created. Turn off "Confirm email" in Supabase (Authentication → Sign In / Providers → Email), then tap Sign in.';
  }
}

async function signOut() {
  await sb.auth.signOut();
  showScreen("screen-auth");
}

/* ------------------------------------------------------------------ */
/*  Config (Supabase credentials)                                      */
/* ------------------------------------------------------------------ */
function getConfig() {
  return {
    url: localStorage.getItem(LS.url) || "",
    key: localStorage.getItem(LS.key) || "",
  };
}

function saveConfig() {
  const url = $("#cfg-url").value.trim().replace(/\/+$/, "");
  const key = $("#cfg-key").value.trim();
  const err = $("#cfg-error");
  if (!/^https:\/\/.+\.supabase\.co$/.test(url)) {
    err.hidden = false; err.textContent = "That doesn't look like a Supabase URL (https://xxxx.supabase.co)."; return;
  }
  if (key.length < 20) {
    err.hidden = false; err.textContent = "That anon key looks too short."; return;
  }
  localStorage.setItem(LS.url, url);
  localStorage.setItem(LS.key, key);
  err.hidden = true;
  boot();
}

function resetConfig() {
  localStorage.removeItem(LS.url);
  localStorage.removeItem(LS.key);
  location.reload();
}

/* ------------------------------------------------------------------ */
/*  Boot                                                               */
/* ------------------------------------------------------------------ */
function initClient(cfg) {
  sb = window.supabase.createClient(cfg.url, cfg.key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: "saver.auth",
    },
  });
}

async function boot() {
  const cfg = getConfig();
  if (!cfg.url || !cfg.key) {
    $("#cfg-url").value = cfg.url;
    $("#cfg-key").value = cfg.key;
    showScreen("screen-config");
    return;
  }

  showScreen("screen-loading");
  try {
    initClient(cfg);
  } catch (e) {
    toast("Bad Supabase config", true);
    showScreen("screen-config");
    return;
  }

  const { data: { session } } = await sb.auth.getSession();

  if (!session) {
    showScreen("screen-auth");
    return;
  }

  startApp();
}

function startApp() {
  resetEntry();
  showStep("step-amount");
  showScreen("screen-entry");
}

/* ------------------------------------------------------------------ */
/*  Wire up events                                                     */
/* ------------------------------------------------------------------ */
function wire() {
  // config
  $("#cfg-save").addEventListener("click", saveConfig);
  $("#cfg-reset").addEventListener("click", resetConfig);

  // auth
  $("#auth-signin").addEventListener("click", signIn);
  $("#auth-signup").addEventListener("click", signUp);
  $("#auth-password").addEventListener("keydown", (e) => { if (e.key === "Enter") signIn(); });

  // keypad
  $$(".keypad .key").forEach((b) => b.addEventListener("click", () => pressKey(b.dataset.k)));

  // amount -> title
  $("#amount-next").addEventListener("click", () => {
    if (entry.cents === 0) { toast("Enter an amount", true); return; }
    syncMiniAmount();
    showStep("step-title");
    setTimeout(() => $("#title-input").focus(), 60);
  });

  // title
  $("#title-input").addEventListener("input", (e) => (entry.title = e.target.value));
  $("#title-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); goToCats(); } });
  $("#title-next").addEventListener("click", goToCats);
  $("#title-back").addEventListener("click", () => showStep("step-amount"));

  // cats
  $("#cats-next").addEventListener("click", () => { syncMiniAmount(); showStep("step-kind"); });
  $("#cats-back").addEventListener("click", () => showStep("step-title"));

  // kind
  $$(".kind-btn").forEach((b) => b.addEventListener("click", () => {
    entry.kind = b.dataset.kind;
    saveExpense();
  }));
  $("#kind-back").addEventListener("click", () => showStep("step-cats"));

  // nav
  $("#sign-out").addEventListener("click", signOut);
  $("#go-history").addEventListener("click", () => { showScreen("screen-history"); loadHistory(); });
  $("#hist-back").addEventListener("click", () => showScreen("screen-entry"));
}

function goToCats() {
  $("#title-input").blur();
  syncMiniAmount();
  showStep("step-cats");
}

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */
window.addEventListener("DOMContentLoaded", () => {
  buildChips();
  wire();
  boot();

  // register service worker (best-effort)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
});
