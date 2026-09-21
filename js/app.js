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
// Amounts are whole euros. Cents are shown only if some legacy value has them.
function formatEuro(euros) {
  const n = Number(euros) || 0;
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs);
  const frac = Math.round((abs - whole) * 100);
  const grouped = whole.toLocaleString("en-US"); // 1,234
  const dec = frac ? "." + String(frac).padStart(2, "0") : "";
  return (neg ? "-" : "") + "€" + grouped + dec;
}

/* ------------------------------------------------------------------ */
/*  Entry flow state                                                   */
/* ------------------------------------------------------------------ */
const entry = {
  amount: 0, // whole euros
  title: "",
  categories: [],
  kind: null,
  split: false,
  reimbursable: false,
  reimbursed: false,
  editId: null, // set when editing an existing expense
};

function resetEntry() {
  entry.amount = 0;
  entry.title = "";
  entry.categories = [];
  entry.kind = null;
  entry.split = false;
  entry.reimbursable = false;
  entry.reimbursed = false;
  entry.editId = null;
  renderAmount();
  $("#title-input").value = "";
  resetChips();
  updateKindUI();
  updateFlagsUI();
}

function renderAmount() {
  const el = $("#amount");
  el.textContent = formatEuro(entry.amount);
  el.classList.toggle("zero", entry.amount === 0);
}

function updateProgress(stepId) {
  const map = {
    "step-amount": "Amount",
    "step-title": "Title",
    "step-cats": "Category",
    "step-kind": "Need / Want",
    "step-saved": "",
  };
  let label = map[stepId] || "";
  if (entry.editId && label) label = "Edit · " + label;
  $("#progress").textContent = label;
}

/* need/want + flag toggles (split / reimbursable / received) */
function updateKindUI() {
  $$(".kind-btn").forEach((b) => b.classList.toggle("selected", entry.kind === b.dataset.kind));
}
function updateFlagsUI() {
  const s = $("#split-toggle");
  if (s) s.classList.toggle("active", !!entry.split);
  const r = $("#reimb-toggle");
  if (r) r.classList.toggle("active", !!entry.reimbursable);
  const rec = $("#received-toggle");
  if (rec) {
    rec.hidden = !entry.reimbursable;      // only relevant when reimbursable
    rec.classList.toggle("active", !!entry.reimbursed);
  }
}
function toggleSplit() { entry.split = !entry.split; haptic(); updateFlagsUI(); }
function toggleReimb() {
  entry.reimbursable = !entry.reimbursable;
  if (!entry.reimbursable) entry.reimbursed = false; // received only makes sense if reimbursable
  haptic();
  updateFlagsUI();
}
function toggleReceived() { entry.reimbursed = !entry.reimbursed; haptic(); updateFlagsUI(); }
function enterKindStep() {
  updateKindUI();
  updateFlagsUI();
  showStep("step-kind");
}

function syncMiniAmount() {
  const txt = formatEuro(entry.amount);
  $("#title-amount").textContent = txt;
  $("#cats-amount").textContent = txt;
  $("#kind-amount").textContent = txt;
}

/* ---- keypad ---- */
function pressKey(k) {
  haptic();
  if (k === "clear") {
    entry.amount = 0;
  } else if (k === "back") {
    entry.amount = Math.floor(entry.amount / 10);
  } else {
    const d = parseInt(k, 10);
    if (entry.amount < 1000000) { // cap at 9,999,999 €
      entry.amount = entry.amount * 10 + d;
    }
  }
  renderAmount();
}

/* ---- categories chips ---- */
let otherChip = null;

function makeChip(label) {
  const b = document.createElement("button");
  b.className = "chip";
  b.type = "button";
  b.textContent = label;
  return b;
}

function toggleChip(b, name) {
  haptic();
  const i = entry.categories.indexOf(name);
  if (i >= 0) { entry.categories.splice(i, 1); b.classList.remove("selected"); }
  else { entry.categories.push(name); b.classList.add("selected"); }
}

function buildChips() {
  const wrap = $("#cats");
  wrap.innerHTML = "";
  CATEGORIES.forEach((name) => {
    if (name === "Other") {
      const b = makeChip("+ Other");
      b.classList.add("add");
      b.addEventListener("click", () => {
        haptic();
        const w = $("#cat-custom-wrap");
        w.hidden = false;
        const inp = $("#cat-custom");
        inp.value = "";
        setTimeout(() => inp.focus(), 40);
      });
      wrap.appendChild(b);
      otherChip = b;
    } else {
      const b = makeChip(name);
      b.addEventListener("click", () => toggleChip(b, name));
      wrap.appendChild(b);
    }
  });
}

// Create a selected custom-category chip (used by the input and when editing).
function addCustomCategoryDirect(name) {
  if (!name || entry.categories.indexOf(name) >= 0) return;
  const b = makeChip(name);
  b.classList.add("selected");
  b.dataset.custom = "1";
  b.addEventListener("click", () => {
    const i = entry.categories.indexOf(name);
    if (i >= 0) entry.categories.splice(i, 1);
    haptic();
    b.remove();
  });
  $("#cats").insertBefore(b, otherChip);
  entry.categories.push(name);
}

// Tapping "+ Other" reveals an input; the typed name becomes a new selected chip.
function addCustomCategory(rawName) {
  const name = (rawName || "").trim();
  const w = $("#cat-custom-wrap");
  w.hidden = true;
  $("#cat-custom").value = "";
  if (!name) return;
  addCustomCategoryDirect(name);
  haptic();
}

// Pre-select chips for an existing expense's categories (used when editing).
function applyCategories(cats) {
  (cats || []).forEach((name) => {
    if (CATEGORIES.indexOf(name) >= 0 && name !== "Other") {
      const chip = $$("#cats .chip").find((c) => !c.dataset.custom && !c.classList.contains("add") && c.textContent === name);
      if (chip) { chip.classList.add("selected"); if (entry.categories.indexOf(name) < 0) entry.categories.push(name); }
    } else {
      addCustomCategoryDirect(name);
    }
  });
}

function resetChips() {
  $$("#cats .chip").forEach((c) => {
    if (c.dataset.custom) c.remove();
    else c.classList.remove("selected");
  });
  const w = $("#cat-custom-wrap");
  if (w) { w.hidden = true; $("#cat-custom").value = ""; }
}

/* ------------------------------------------------------------------ */
/*  Save                                                               */
/* ------------------------------------------------------------------ */
async function saveExpense() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { toast("Not signed in", true); showScreen("screen-auth"); return; }

  const record = {
    user_id: user.id,
    amount: entry.amount,
    title: entry.title || null,
    categories: entry.categories,
    kind: entry.kind,
    split: entry.split,
    reimbursable: entry.reimbursable,
    reimbursed: entry.reimbursable ? entry.reimbursed : false,
  };

  const editing = !!entry.editId;

  // optimistic confirmation
  $("#saved-amount").textContent = formatEuro(entry.amount);
  showStep("step-saved");
  haptic();

  const q = editing
    ? sb.from("expenses").update(record).eq("id", entry.editId)
    : sb.from("expenses").insert(record);
  const { error } = await q;
  if (error) {
    console.error(error);
    toast("Couldn't save: " + error.message, true);
    showStep("step-kind");
    return;
  }

  setTimeout(() => {
    resetEntry();
    if (editing) {
      showScreen("screen-history");
      loadHistory();
    } else {
      showStep("step-amount");
    }
  }, 900);
}

/* ------------------------------------------------------------------ */
/*  History / stats                                                    */
/* ------------------------------------------------------------------ */
let statsMonth = null; // Date at the first day of the shown month

function monthRange(d) {
  return {
    start: new Date(d.getFullYear(), d.getMonth(), 1),
    end: new Date(d.getFullYear(), d.getMonth() + 1, 1),
  };
}

function isCurrentMonth(d) {
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

function dayLabel(d) {
  const now = new Date();
  const isSame = (a, b) => a.toDateString() === b.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (isSame(d, now)) return "Today";
  if (isSame(d, yest)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function openHistory() {
  if (entry.editId) resetEntry(); // cancel any in-progress edit
  statsMonth = new Date();
  statsMonth.setDate(1);
  showScreen("screen-history");
  loadHistory();
}

function changeMonth(delta) {
  const d = new Date(statsMonth);
  d.setMonth(d.getMonth() + delta);
  if (delta > 0 && d > new Date()) return; // don't go past the current month
  statsMonth = d;
  haptic();
  loadHistory();
}

// What you actually paid out of pocket (a split expense is your half).
function paidAmount(r) {
  const a = Number(r.amount) || 0;
  return r.split ? a / 2 : a;
}
// What counts toward your spend: reimbursable money isn't really yours.
function netAmount(r) {
  return r.reimbursable ? 0 : paidAmount(r);
}
// Money still owed back to you (full amount fronted, until marked received).
function pendingReimb(r) {
  return (r.reimbursable && !r.reimbursed) ? (Number(r.amount) || 0) : 0;
}

// Open an existing expense in the entry flow, pre-filled and editable.
function openEdit(r) {
  resetEntry();
  entry.editId = r.id;
  entry.amount = Math.round(Number(r.amount) || 0);
  entry.title = r.title || "";
  entry.kind = r.kind || null;
  entry.split = !!r.split;
  entry.reimbursable = !!r.reimbursable;
  entry.reimbursed = !!r.reimbursed;
  applyCategories(r.categories || []);
  renderAmount();
  $("#title-input").value = entry.title;
  syncMiniAmount();
  showScreen("screen-entry");
  showStep("step-amount");
}

async function loadHistory() {
  $("#month-label").textContent =
    statsMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  $("#month-next").disabled = isCurrentMonth(statsMonth);
  $("#hist-scroll").scrollTop = 0;

  const list = $("#hist-list");
  list.innerHTML = '<div class="hist-empty">Loading…</div>';

  const { start, end } = monthRange(statsMonth);
  const { data, error } = await sb
    .from("expenses")
    .select("*")
    .gte("created_at", start.toISOString())
    .lt("created_at", end.toISOString())
    .order("created_at", { ascending: false });

  if (error) { list.innerHTML = '<div class="hist-empty">Error loading.</div>'; toast(error.message, true); return; }

  renderStats(data || []);
  renderList(data || []);
}

function renderStats(rows) {
  let total = 0, need = 0, want = 0, pending = 0;
  const byCat = {};
  rows.forEach((r) => {
    const a = netAmount(r); // split -> your half; reimbursable -> 0
    total += a;
    pending += pendingReimb(r);
    if (r.kind === "need") need += a;
    else if (r.kind === "want") want += a;
    if (a > 0) {
      const cats = (r.categories && r.categories.length) ? r.categories : ["Uncategorised"];
      cats.forEach((c) => { byCat[c] = (byCat[c] || 0) + a; });
    }
  });

  $("#stat-total").textContent = formatEuro(total);

  // pending reimbursement line (money still to get back)
  const pw = $("#reimb-pending");
  if (pending > 0) {
    pw.hidden = false;
    $("#reimb-pending-amt").textContent = formatEuro(pending);
  } else {
    pw.hidden = true;
  }

  const nwTotal = need + want;
  const needPct = nwTotal ? Math.round((need / nwTotal) * 100) : 0;
  $("#nw-need").style.width = (nwTotal ? (need / nwTotal) * 100 : 0) + "%";
  $("#nw-want").style.width = (nwTotal ? (want / nwTotal) * 100 : 0) + "%";
  $("#nw-need-amt").textContent = formatEuro(need);
  $("#nw-want-amt").textContent = formatEuro(want);
  $("#nw-need-pct").textContent = nwTotal ? needPct + "%" : "";
  $("#nw-want-pct").textContent = nwTotal ? (100 - needPct) + "%" : "";

  const wrap = $("#cat-breakdown");
  wrap.innerHTML = "";
  const cats = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
  if (cats.length) {
    const head = document.createElement("div");
    head.className = "section-label";
    head.textContent = "By category";
    wrap.appendChild(head);
    const max = byCat[cats[0]] || 1;
    cats.forEach((c) => {
      const row = document.createElement("div");
      row.className = "cat-row";
      row.innerHTML =
        '<div class="cat-row-top"><span>' + escapeHtml(c) + "</span><b>" + formatEuro(byCat[c]) + "</b></div>" +
        '<div class="cat-track"><div class="cat-fill" style="width:' + ((byCat[c] / max) * 100) + '%"></div></div>';
      wrap.appendChild(row);
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function makeBadge(text, cls) {
  const b = document.createElement("span");
  b.className = "badge " + cls;
  b.textContent = text;
  return b;
}

function renderList(rows) {
  const list = $("#hist-list");
  list.innerHTML = "";
  if (!rows.length) { list.innerHTML = '<div class="hist-empty">No expenses this month.</div>'; return; }

  const sub = document.createElement("div");
  sub.className = "hist-sub";
  sub.textContent = "All expenses";
  list.appendChild(sub);

  let lastDay = null;
  rows.forEach((r) => {
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
  const el = document.createElement("div");
  el.className = "hist-item";

  const dot = document.createElement("span");
  dot.className = "hi-kind " + (r.kind || "");
  el.appendChild(dot);

  // main area: tap to edit
  const main = document.createElement("div");
  main.className = "hi-main";
  const title = document.createElement("div");
  title.className = "hi-title";
  title.textContent = r.title || "Untitled";

  const sub = document.createElement("div");
  sub.className = "hi-sub";
  if (r.split) sub.appendChild(makeBadge("½ split", "split"));
  if (r.reimbursable) {
    sub.appendChild(r.reimbursed
      ? makeBadge("↩︎ back", "reimb-done")
      : makeBadge("↩︎ pending", "reimb-pending"));
  }
  const catSpan = document.createElement("span");
  catSpan.className = "cats";
  catSpan.textContent = (r.categories || []).join(" · ") || "—";
  sub.appendChild(catSpan);

  main.appendChild(title);
  main.appendChild(sub);
  main.addEventListener("click", () => openEdit(r));
  el.appendChild(main);

  const amt = document.createElement("div");
  amt.className = "hi-amount" + (r.reimbursable ? " reimb" : "");
  amt.textContent = formatEuro(paidAmount(r));
  el.appendChild(amt);

  // quick split toggle
  const split = document.createElement("button");
  split.className = "hi-act split" + (r.split ? " active" : "");
  split.textContent = "½";
  split.setAttribute("aria-label", "Split with partner");
  split.addEventListener("click", async (e) => {
    e.stopPropagation();
    const { error } = await sb.from("expenses").update({ split: !r.split }).eq("id", r.id);
    if (error) { toast(error.message, true); return; }
    haptic();
    loadHistory();
  });
  el.appendChild(split);

  const del = document.createElement("button");
  del.className = "hi-act del";
  del.textContent = "🗑";
  del.setAttribute("aria-label", "Delete");
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    const { error } = await sb.from("expenses").delete().eq("id", r.id);
    if (error) { toast(error.message, true); return; }
    haptic();
    loadHistory();
  });
  el.appendChild(del);

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
    if (entry.amount === 0) { toast("Enter an amount", true); return; }
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
  $("#cat-custom").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addCustomCategory(e.target.value); }
  });
  $("#cat-custom").addEventListener("blur", (e) => {
    if (e.target.value.trim()) addCustomCategory(e.target.value);
  });
  $("#cats-next").addEventListener("click", () => {
    if (!$("#cat-custom-wrap").hidden) addCustomCategory($("#cat-custom").value);
    syncMiniAmount(); enterKindStep();
  });
  $("#cats-back").addEventListener("click", () => showStep("step-title"));

  // kind + flags
  $("#split-toggle").addEventListener("click", toggleSplit);
  $("#reimb-toggle").addEventListener("click", toggleReimb);
  $("#received-toggle").addEventListener("click", toggleReceived);
  $$(".kind-btn").forEach((b) => b.addEventListener("click", () => {
    entry.kind = b.dataset.kind;
    saveExpense();
  }));
  $("#kind-back").addEventListener("click", () => showStep("step-cats"));

  // nav
  $("#sign-out").addEventListener("click", signOut);
  $("#go-history").addEventListener("click", openHistory);
  $("#hist-back").addEventListener("click", () => showScreen("screen-entry"));
  $("#month-prev").addEventListener("click", () => changeMonth(-1));
  $("#month-next").addEventListener("click", () => changeMonth(1));
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
