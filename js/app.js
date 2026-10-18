"use strict";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */
// Starter categories, shown until you've used some: from then on the chips are
// the categories you actually use, most used first ("+" adds a new one).
const CATEGORIES = [
  "Eat out", "Groceries", "Transport", "Shopping",
  "Bills", "Health", "Fun", "Travel", "Other",
];

// Retired category names and where they went. Applied to everything read back,
// so an old name never comes back as a chip.
const RENAMED = { food: "Eat out", drinks: "Eat out", subscriptions: "Bills" };
function canonCats(cats) {
  const out = [];
  (cats || []).forEach((c) => {
    const n = RENAMED[String(c).trim().toLowerCase()] || c;
    if (out.indexOf(n) < 0) out.push(n);
  });
  return out;
}

const LS = {
  url: "saver.sb_url",
  key: "saver.sb_key",
  cats: "saver.used_cats",
  billsOpen: "saver.bills_open",
  reimbFull: "saver.reimb_full",
  tipsHidden: "saver.tips_hidden",
};

// Categories you've used, most used first. Learned from your saved expenses
// (so they sync across devices) and cached locally for an instant render.
let savedCats = loadCachedCats();

function loadCachedCats() {
  try {
    const v = JSON.parse(localStorage.getItem(LS.cats) || "[]");
    return Array.isArray(v) ? canonCats(v.filter((x) => typeof x === "string" && x)) : [];
  } catch (e) { return []; }
}

let sb = null; // supabase client

/* ------------------------------------------------------------------ */
/*  Tiny DOM helpers                                                   */
/* ------------------------------------------------------------------ */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Home-screen app on recent iOS: the viewport can come up short of the screen
// by the status bar + home indicator, and env(safe-area-inset-bottom) reads 0,
// so fixed layers stop above a black band. The app always owns the whole
// screen there, so measure the shortfall and let the CSS stretch into it.
function fitScreen() {
  const standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  const el = document.activeElement;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return; // keyboard up
  const root = document.documentElement.style;
  const portrait = innerHeight >= innerWidth;
  const screenH = portrait ? Math.max(screen.height, screen.width) : Math.min(screen.height, screen.width);
  const gap = standalone ? Math.max(0, Math.round(screenH - innerHeight)) : 0;
  root.setProperty("--vp-gap", gap + "px");
  // a gap only happens on Face ID iPhones, whose home indicator needs 34px
  root.setProperty("--home-bar", gap > 0 && portrait ? "34px" : "0px");
}
fitScreen();
addEventListener("resize", fitScreen);
addEventListener("orientationchange", () => setTimeout(fitScreen, 300));
addEventListener("pageshow", fitScreen);

// Screens reachable from the tab bar, and their tab.
const TABS = { "screen-home": "home", "screen-history": "insights", "screen-bills": "bills", "screen-budget": "settings" };

function showScreen(id) {
  $$(".screen").forEach((s) => s.classList.remove("active"));
  $("#" + id).classList.add("active");
  const tab = TABS[id];
  $("#tabbar").hidden = !tab;
  document.body.classList.toggle("tabbed", !!tab);
  $$(".tab[data-tab]").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
}

// The tab screen showing now (where an entry started from goes back to).
function currentTab() {
  const s = $(".screen.active");
  return s && TABS[s.id] ? s.id : "screen-home";
}

function showStep(id) {
  $$("#screen-entry .step").forEach((s) => s.classList.remove("active"));
  $("#" + id).classList.add("active");
  updateProgress(id);
}

let toastTimer = null;
let toastAction = null;
// action: optional { label, fn }, e.g. Undo. Toasts with an action stay a bit longer.
function toast(msg, isErr, action) {
  const t = $("#toast");
  $("#toast-msg").textContent = msg;
  const btn = $("#toast-act");
  toastAction = action ? action.fn : null;
  btn.hidden = !action;
  if (action) btn.textContent = action.label;
  t.classList.toggle("err", !!isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; toastAction = null; }, action ? 5000 : 2600);
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
  reimbursable: false,
  reimbursed: false,
  reimbAmount: "",  // raw input; empty = fully reimbursable
  date: "",         // YYYY-MM-DD, defaults to today
  createdAt: null,  // original created_at of the expense being edited
  editId: null, // set when editing an existing expense
  quick: false, // prefilled entry (salary): the amount step saves
  prefilled: false, // amount was prefilled: the first key press replaces it
  catsTouched: false, // categories picked by hand: don't overwrite them from a known title
  returnTo: null, // tab screen the entry started from: go back there once saved
  extra: false, // money in: extra (split like the salary) rather than covering bills
};

function resetEntry() {
  entry.amount = 0;
  entry.title = "";
  entry.categories = [];
  entry.kind = null;
  entry.reimbursable = false;
  entry.reimbursed = false;
  entry.reimbAmount = "";
  entry.extra = false;
  entry.date = toDateInput(new Date());
  entry.createdAt = null;
  entry.editId = null;
  entry.quick = false;
  entry.prefilled = false;
  entry.catsTouched = false;
  entry.returnTo = null;
  renderAmount();
  $("#title-input").value = "";
  resetChips();
  updateKindUI();
  updateFlagsUI();
  updateAmountBtn();
}

// The amount step saves directly for prefilled flows (salary).
function updateAmountBtn() {
  $("#amount-next").textContent = entry.quick ? "Save" : "Next";
}

function renderAmount() {
  const el = $("#amount");
  el.textContent = formatEuro(entry.amount);
  el.classList.toggle("zero", entry.amount === 0);
}

function updateProgress(stepId) {
  const map = {
    "step-amount": "Amount",
    "step-details": "Details",
    "step-saved": "",
  };
  let label = map[stepId] || "";
  const mode = { income: "Money in", salary: "New salary" }[entry.kind] || "";
  if (mode && label) label = mode + " · " + label;
  if (entry.editId && label) label = "Edit · " + label;
  $("#progress").textContent = label;
}

/* need/want + flag toggles (reimbursable / received) */
// hint: kind remembered for the typed title, highlighted until you pick one
function updateKindUI(hint) {
  const k = entry.kind || hint;
  $$(".kind-btn").forEach((b) => b.classList.toggle("selected", k === b.dataset.kind));
}
function updateFlagsUI() {
  const r = $("#reimb-toggle");
  if (r) r.classList.toggle("active", !!entry.reimbursable);
  const rec = $("#received-toggle");
  if (rec) {
    rec.hidden = !entry.reimbursable;      // only relevant when reimbursable
    rec.classList.toggle("active", !!entry.reimbursed);
  }
  const ra = $("#reimb-amt-wrap");
  if (ra) {
    ra.hidden = !entry.reimbursable;
    const inp = $("#reimb-amt");
    inp.value = entry.reimbAmount;
    inp.placeholder = "Full · " + formatEuro(entry.amount);
  }
  updateDateUI();
}
function updateDateUI() {
  const today = new Date();
  const inp = $("#entry-date");
  inp.max = toDateInput(today);
  inp.value = entry.date;
  const yest = toDateInput(addDays(today, -1));
  $("#date-label").textContent = entry.date === toDateInput(today) ? "Today"
    : entry.date === yest ? "Yesterday"
    : parseDay(entry.date).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  $(".date-chip").classList.toggle("set", entry.date !== toDateInput(today));
}
function toggleReimb() {
  entry.reimbursable = !entry.reimbursable;
  if (!entry.reimbursable) entry.reimbursed = false; // received only makes sense if reimbursable
  haptic();
  updateFlagsUI();
}
// Money in: "Covers bills" (sub-tenant: comes off needs) or "Extra" (DJ fee,
// eBay: split like the salary). Stored as the "Extra" category on the row.
const EXTRA = "Extra";
function isExtra(r) { return (r.categories || []).includes(EXTRA); }
function updateIncomeUI() {
  $$("#in-kind .pill").forEach((b) => b.classList.toggle("active", (b.dataset.in === "extra") === entry.extra));
}
function setExtra(on) { entry.extra = on; haptic(); updateIncomeUI(); }
function toggleReceived() { entry.reimbursed = !entry.reimbursed; haptic(); updateFlagsUI(); }

// Details step: title, recent entries, categories, flags, need / want.
// Money in only needs a title, so it gets a plain Save button instead.
function enterDetails() {
  const income = entry.kind === "income";
  $("#det-body").hidden = income;
  $("#det-save").hidden = !income;
  $("#in-kind").hidden = !income;
  updateIncomeUI();
  $("#title-input").placeholder = income ? "From who / what?" : "What was it?";
  syncMiniAmount();
  updateKindUI();
  updateFlagsUI();
  renderSuggest();
  showStep("step-details");
  $("#step-details").scrollTop = 0;
  if (!entry.editId && !entry.title) setTimeout(() => $("#title-input").focus(), 60);
}

function syncMiniAmount() {
  $("#det-amount").textContent = formatEuro(entry.amount);
}

/* ---- keypad ---- */
function pressKey(k) {
  haptic();
  if (entry.prefilled && k !== "back") entry.amount = 0; // typing replaces a prefilled amount
  entry.prefilled = false;
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
  entry.catsTouched = true;
  const i = entry.categories.indexOf(name);
  if (i >= 0) { entry.categories.splice(i, 1); b.classList.remove("selected"); }
  else { entry.categories.push(name); b.classList.add("selected"); }
}

function buildChips() {
  const wrap = $("#cats");
  wrap.innerHTML = "";
  const starters = CATEGORIES.filter((n) => n !== "Other");
  const names = (savedCats.length ? savedCats : starters).concat(["Other"]);
  names.forEach((name) => {
    if (name === "Other") {
      const b = makeChip("+");
      b.setAttribute("aria-label", "New category");
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

// A regular (default or saved) chip by name, matched case-insensitively.
function findChip(name) {
  const k = name.toLowerCase();
  return $$("#cats .chip").find((c) => !c.dataset.custom && !c.classList.contains("add") && c.textContent.toLowerCase() === k);
}

// Create a selected custom-category chip (used by the input and when editing).
// If a chip with that name already exists, just select it.
function addCustomCategoryDirect(name) {
  if (!name) return;
  const existing = findChip(name);
  if (existing) {
    const n = existing.textContent;
    if (entry.categories.indexOf(n) < 0) { entry.categories.push(n); existing.classList.add("selected"); }
    return;
  }
  if (entry.categories.indexOf(name) >= 0) return;
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

// Tapping "+" reveals an input; the typed name becomes a new selected chip.
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
    const chip = $$("#cats .chip").find((c) => !c.dataset.custom && !c.classList.contains("add") && c.textContent === name);
    if (chip) { chip.classList.add("selected"); if (entry.categories.indexOf(name) < 0) entry.categories.push(name); }
    else addCustomCategoryDirect(name);
  });
}

// Replace the used categories and redraw the chips, keeping the current selection.
function setSavedCats(list) {
  const seen = new Set();
  const next = [];
  canonCats(list).forEach((n) => {
    const k = (n || "").trim().toLowerCase();
    if (!k || k === "other" || seen.has(k)) return;
    seen.add(k); next.push(n.trim());
  });
  if (next.join("\n") === savedCats.join("\n")) return;
  savedCats = next;
  try { localStorage.setItem(LS.cats, JSON.stringify(savedCats)); } catch (e) {}
  const selected = entry.categories.slice();
  entry.categories = [];
  buildChips();
  applyCategories(selected);
}

// Remember any new categories from a just-saved expense.
function rememberCats(cats) {
  setSavedCats(savedCats.concat(cats || []));
}

// Learn the categories and remembered titles from your expenses, most used first.
async function refreshSavedCats() {
  const { data, error } = await sb
    .from("expenses")
    .select("title, amount, categories, kind, created_at")
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error || !data) return;
  data.forEach((r) => { r.categories = canonCats(r.categories); });
  learnTitles(data);
  const count = new Map();
  data.forEach((r) => isIncome(r) || (r.categories || []).forEach((c) => count.set(c, (count.get(c) || 0) + 1)));
  const fromDb = Array.from(count.keys()).sort((a, b) => count.get(b) - count.get(a));
  // the database wins, so renamed / merged categories drop out of the chips
  setSavedCats(fromDb);
}

/* ---- remembered titles: one tap re-logs "Lidl · Groceries · Need" ---- */
let known = new Map(); // norm(title) -> { key, title, amount, categories, kind, count }, most recent first

// Case, accent and spacing-insensitive key ("  loyer " == "Loyer").
function norm(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ").toLowerCase();
}

// rows: newest first, so the first time a title is seen is its latest use.
function learnTitles(rows) {
  const next = new Map();
  rows.forEach((r) => {
    const key = norm(r.title);
    if (!key || !r.kind) return;
    const k = next.get(key);
    if (k) k.count++;
    else next.set(key, { key, title: r.title.trim(), amount: Number(r.amount) || 0, categories: r.categories || [], kind: r.kind, count: 1 });
  });
  known = next;
}

// Put a just-saved entry at the front of the remembered titles.
function rememberTitle(rec) {
  const key = norm(rec.title);
  if (!key || !rec.kind) return;
  const old = known.get(key);
  known.delete(key);
  known = new Map([[key, { key, title: rec.title.trim(), amount: Number(rec.amount) || 0, categories: rec.categories || [], kind: rec.kind, count: (old ? old.count : 0) + 1 }]].concat(Array.from(known)));
}

function renderSuggest() {
  const wrap = $("#suggest");
  wrap.innerHTML = "";
  if (entry.editId) return; // a tap saves: never on an existing expense
  const q = norm(entry.title);
  const income = entry.kind === "income";
  const list = Array.from(known.values())
    .filter((k) => (k.kind === "income") === income && (!q || k.key.includes(q)));
  // starts-with matches first, then most used (ties stay most recent first)
  list.sort((a, b) => (q ? (b.key.startsWith(q) - a.key.startsWith(q)) : 0) || b.count - a.count);
  list.slice(0, 6).forEach((k) => {
    const b = el("button", "sg-chip");
    b.type = "button";
    b.appendChild(el("span", "dot " + (k.kind !== "income" ? k.kind : isExtra(k) ? "save" : "need")));
    b.appendChild(el("span", "sg-title", k.title));
    if (income) b.appendChild(el("span", "sg-cats", "+" + formatEuro(k.amount)));
    else if (k.categories.length) b.appendChild(el("span", "sg-cats", k.categories.join(" · ")));
    b.addEventListener("click", () => {
      if (!entry.amount) entry.amount = Math.round(k.amount); // money in: same as last time
      entry.title = k.title;
      entry.categories = k.categories.slice();
      entry.kind = k.kind;
      if (income) entry.extra = isExtra(k);
      saveExpense();
    });
    wrap.appendChild(b);
  });
}

// Typing a title you've used before preselects its categories and kind.
function onTitleInput(value) {
  entry.title = value;
  renderSuggest();
  const k = known.get(norm(value));
  if (k && entry.kind === "income" && k.kind === "income") { entry.extra = isExtra(k); updateIncomeUI(); }
  if (!k || entry.kind === "income") { updateKindUI(); return; }
  if (!entry.catsTouched) {
    resetChips();
    entry.categories = [];
    applyCategories(k.categories);
  }
  updateKindUI(k.kind);
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
// Partial reimbursement amount, or null when it's the full amount (or unset).
function parseReimbAmount() {
  const raw = String(entry.reimbAmount || "").trim().replace(",", ".");
  if (!raw) return null;
  const n = Math.round(parseFloat(raw) * 100) / 100;
  if (!isFinite(n) || n < 0) return undefined; // invalid
  return n >= entry.amount ? null : n;
}

function toDateInput(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

// created_at for the chosen day, keeping the time of day (the original one
// when editing, now for a new expense). Null when the day is unchanged.
function editedCreatedAt() {
  if (!entry.date) return null;
  const orig = entry.createdAt ? new Date(entry.createdAt) : new Date();
  if (toDateInput(orig) === entry.date) return null; // unchanged
  const [y, m, d] = entry.date.split("-").map(Number);
  const next = new Date(orig);
  next.setFullYear(y, m - 1, d);
  return next.toISOString();
}

async function saveExpense() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { toast("Not signed in", true); showScreen("screen-auth"); return; }

  const record = {
    user_id: user.id,
    amount: entry.amount,
    title: entry.title || null,
    categories: entry.kind === "income" ? (entry.extra ? [EXTRA] : []) : entry.categories,
    kind: entry.kind,
    reimbursable: entry.reimbursable,
    reimbursed: entry.reimbursable ? entry.reimbursed : false,
  };

  if (entry.reimbursable) {
    const ra = parseReimbAmount();
    if (ra === undefined) { toast("Invalid reimbursed amount", true); return; }
    record.reimb_amount = ra;
  }

  const editing = !!entry.editId;
  const createdAt = editedCreatedAt();
  if (createdAt) record.created_at = createdAt;

  // optimistic confirmation
  $("#saved-amount").textContent = formatEuro(entry.amount);
  showStep("step-saved");
  haptic();

  const q = editing
    ? sb.from("expenses").update(record).eq("id", entry.editId)
    : sb.from("expenses").insert(record).select();
  const { data, error } = await q;
  if (error) {
    console.error(error);
    const oldSchema = /kind_check/.test(error.message || "");
    toast(oldSchema ? "Re-run supabase/schema.sql in Supabase to enable this" : "Couldn't save: " + error.message, true);
    if (entry.quick) showStep("step-amount"); else enterDetails();
    return;
  }

  const savedCatsUsed = record.kind === "income" ? [] : record.categories.slice();
  const back = entry.returnTo || "screen-home";
  const newId = !editing && data && data[0] ? data[0].id : null;
  rememberTitle(record);
  setTimeout(() => {
    resetEntry();
    rememberCats(savedCatsUsed);
    showStep("step-amount");
    goScreen(back);
    if (newId) toast("Saved " + (record.title || formatEuro(record.amount)), false, { label: "Undo", fn: () => undoInsert(newId) });
  }, 650);
}

async function undoInsert(id) {
  const { error } = await sb.from("expenses").delete().eq("id", id);
  if (error) { toast(error.message, true); return; }
  haptic();
  toast("Removed");
  refresh();
}

// Quick salary: the keypad is prefilled with the last salary, Save starts a new month.
async function saveSalary() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { showScreen("screen-auth"); return; }
  // the whole row is written back: start from what's stored now, not from
  // a copy loaded hours ago (or on another device)
  if (!(await loadBudget())) { toast("Couldn't load your budget — try again", true); return; }
  const incomes = Object.assign({}, budget.incomes, { [entry.date]: entry.amount });
  const next = {
    user_id: user.id, need_pct: budget.need_pct, want_pct: budget.want_pct, save_pct: budget.save_pct,
    incomes, bills: budget.bills || [], updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from("budgets").upsert(next);
  if (error) { toast(error.message, true); return; }
  budget = Object.assign({}, DEFAULT_BUDGET, next);
  haptic();
  const back = entry.returnTo || "screen-home";
  resetEntry();
  toast("Salary saved · new budget month");
  statsPeriod = periodFor(new Date());
  statsFilter = { type: null, value: null };
  homePick = null;
  goScreen(back);
}

async function startSalary() {
  if (!budgetLoaded) await loadBudget();
  if (budgetMissing) { toast("Re-run supabase/schema.sql first", true); return; }
  haptic();
  const back = currentTab();
  resetEntry();
  const pays = paydays();
  entry.kind = "salary";
  entry.quick = true;
  entry.returnTo = back;
  if (pays.length) { entry.amount = Math.round(pays[pays.length - 1].amount); entry.prefilled = true; }
  renderAmount();
  updateAmountBtn();
  showScreen("screen-entry");
  showStep("step-amount");
}

/* ------------------------------------------------------------------ */
/*  History / stats                                                    */
/* ------------------------------------------------------------------ */
let statsPeriod = null;                   // shown period, see periodFor()
let statsRows = [];                        // cached rows for the shown period
let statsFilter = { type: null, value: null }; // null | 'kind'|'need'/'want'/'saving' | 'category'|name

// Money put aside goes to the savings bucket.
function isSaving(r) { return r.kind === "save"; }
// Money in (sub-tenant, side job…): covers bills (comes off needs) or extra (split like the salary).
function isIncome(r) { return r.kind === "income"; }

function matchesFilter(r) {
  if (!statsFilter.type) return true;
  if (statsFilter.type === "kind") return statsFilter.value === "saving" ? isSaving(r) : r.kind === statsFilter.value;
  if (statsFilter.type === "category") return (r.categories || []).includes(statsFilter.value);
  if (statsFilter.type === "pending") return pendingReimb(r) > 0;
  if (statsFilter.type === "income") return isIncome(r);
  return true;
}

// Toggle a filter (tapping the active one clears it), then re-render in place.
function setFilter(type, value) {
  if (statsFilter.type === type && statsFilter.value === value) {
    statsFilter = { type: null, value: null };
  } else {
    statsFilter = { type, value };
  }
  haptic();
  renderStats(statsRows);
  renderList(statsRows);
}

/* ---- periods: a budget month runs from one payday to the next ---- */
const DAY = 86400000;
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function parseDay(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function daysBetween(a, b) { return Math.round((startOfDay(b) - startOfDay(a)) / DAY); }

// Salaries received, oldest first. Stored as budget.incomes {"YYYY-MM-DD": amount}
// ("YYYY-MM" keys from before paydays count as the 1st of that month).
function paydays() {
  const inc = budget.incomes || {};
  return Object.keys(inc)
    .map((k) => ({ date: k.length === 7 ? k + "-01" : k, amount: Number(inc[k]) || 0 }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// The period containing a date: from the latest payday on/before it until the
// next payday (open-ended while the next salary hasn't arrived — estEnd then
// guesses a month later). Before the first payday, plain calendar months.
function periodFor(date) {
  const pays = paydays();
  let i = -1;
  pays.forEach((p, j) => { if (parseDay(p.date) <= date) i = j; });
  if (i >= 0) {
    const start = parseDay(pays[i].date);
    const end = pays[i + 1] ? parseDay(pays[i + 1].date) : null;
    const est = new Date(start); est.setMonth(est.getMonth() + 1);
    return { start, end, estEnd: end || est, income: pays[i].amount, pay: true };
  }
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  let end = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  if (pays.length && parseDay(pays[0].date) < end) end = parseDay(pays[0].date);
  return { start, end, estEnd: end, income: null, pay: false };
}

function isCurrentPeriod(p) {
  const now = new Date();
  return now >= p.start && (!p.end || now < p.end);
}

// Days counted for the per-day average: elapsed days in the current period,
// full length for a past one.
function daysElapsed(p) {
  return isCurrentPeriod(p) ? daysBetween(p.start, new Date()) + 1 : Math.max(1, daysBetween(p.start, p.end));
}

function periodLabel(p) {
  // a full calendar month (no salary logged yet) reads as "October 2026"
  if (!p.pay && p.end.getDate() === 1) return p.start.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const f = (d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return f(p.start) + " – " + (p.end ? f(addDays(p.end, -1)) : "today");
}

function dayLabel(d) {
  const now = new Date();
  const isSame = (a, b) => a.toDateString() === b.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (isSame(d, now)) return "Today";
  if (isSame(d, yest)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

// filter / period: optional, e.g. from Home ("See all" on a budget opens it filtered).
async function openHistory(filter, period) {
  if (!budgetLoaded) await loadBudget();
  statsPeriod = period || periodFor(new Date());
  statsFilter = filter || { type: null, value: null };
  showScreen("screen-history");
  loadHistory();
}

function changeMonth(delta) {
  if (delta > 0 && isCurrentPeriod(statsPeriod)) return; // don't go past the current period
  statsPeriod = periodFor(delta > 0 ? statsPeriod.end : addDays(statsPeriod.start, -1));
  statsFilter = { type: null, value: null };
  haptic();
  loadHistory();
}

// What you paid out of pocket.
function paidAmount(r) {
  return Number(r.amount) || 0;
}
// How much of the expense gets paid back (null reimb_amount = all of it).
function reimbAmount(r) {
  if (!r.reimbursable) return 0;
  const a = Number(r.amount) || 0;
  return r.reimb_amount == null ? a : Math.min(Number(r.reimb_amount) || 0, a);
}
function isPartialReimb(r) {
  return !!r.reimbursable && r.reimb_amount != null && Number(r.reimb_amount) < (Number(r.amount) || 0);
}
// What counts toward your spend: reimbursed money isn't really yours.
// The Stats card can switch to counting reimbursable expenses in full.
function netAmount(r) {
  return r.reimbursable && !reimbFull ? Math.max(0, paidAmount(r) - reimbAmount(r)) : paidAmount(r);
}
// Money still owed back to you, until marked received.
function pendingReimb(r) {
  return (r.reimbursable && !r.reimbursed) ? reimbAmount(r) : 0;
}

// Open an existing expense in the entry flow, pre-filled and editable.
function openEdit(r) {
  const back = currentTab();
  resetEntry();
  entry.returnTo = back;
  entry.editId = r.id;
  entry.amount = Math.round(Number(r.amount) || 0);
  entry.title = r.title || "";
  entry.kind = r.kind || null;
  entry.reimbursable = !!r.reimbursable;
  entry.reimbursed = !!r.reimbursed;
  entry.reimbAmount = isPartialReimb(r) ? String(Number(r.reimb_amount)) : "";
  entry.createdAt = r.created_at;
  entry.date = toDateInput(new Date(r.created_at));
  entry.catsTouched = true;
  if (isIncome(r)) entry.extra = isExtra(r);
  else applyCategories(r.categories || []);
  renderAmount();
  $("#title-input").value = entry.title;
  syncMiniAmount();
  showScreen("screen-entry");
  showStep("step-amount");
}

async function loadHistory() {
  $("#month-label").textContent = periodLabel(statsPeriod);
  $("#month-next").disabled = isCurrentPeriod(statsPeriod);
  $("#hist-scroll").scrollTop = 0;

  const list = $("#hist-list");
  list.innerHTML = '<div class="hist-empty">Loading…</div>';

  const period = statsPeriod;
  const { data, error } = await fetchRows(period);
  if (period !== statsPeriod) return; // another month was picked meanwhile

  if (error) { list.innerHTML = '<div class="hist-empty">Error loading.</div>'; toast(error.message, true); return; }

  statsRows = data;
  renderStats(statsRows);
  renderList(statsRows);
  renderBudget(statsRows);
}

// Every entry of a period, newest first.
async function fetchRows(p) {
  let q = sb.from("expenses").select("*").gte("created_at", p.start.toISOString());
  if (p.end) q = q.lt("created_at", p.end.toISOString());
  const { data, error } = await q.order("created_at", { ascending: false });
  const rows = data || [];
  rows.forEach((r) => { r.categories = canonCats(r.categories); });
  return { data: rows, error };
}

// Reload whichever tab screen is showing (after a delete, an undo, a bill paid…).
function refresh() {
  const s = $(".screen.active");
  const id = s && s.id;
  if (id === "screen-home") loadHome();
  else if (id === "screen-history") loadHistory();
  else if (id === "screen-bills") loadBills();
}

// Back to a tab screen after an entry: Insights keeps the month it showed.
function goScreen(id) {
  if (id === "screen-history" && statsPeriod) { showScreen(id); loadHistory(); }
  else if (id === "screen-history") openHistory();
  else if (id === "screen-bills") openBills();
  else openHome(true);
}

function renderStats(rows) {
  const filtered = rows.filter(matchesFilter);
  const kindFilter = statsFilter.type === "kind";
  const catFilter = statsFilter.type === "category";

  // headline total + per-day, over the filtered set. Unfiltered, the total is
  // what you spent: money put aside / repaid isn't spending.
  let total = 0, need = 0, want = 0, saved = 0, pending = 0;
  const pendingView = statsFilter.type === "pending";
  filtered.forEach((r) => {
    if (isIncome(r)) { if (statsFilter.type === "income") total += Number(r.amount) || 0; return; }
    if (pendingView) total += pendingReimb(r); // what's still owed back
    else if (statsFilter.type || !isSaving(r)) total += netAmount(r);
    if (r.kind === "need") need += netAmount(r);
    else if (r.kind === "want") want += netAmount(r);
    else if (isSaving(r)) saved += netAmount(r);
  });
  rows.forEach((r) => { pending += pendingReimb(r); }); // pending ignores filter

  const perDay = total / daysElapsed(statsPeriod);
  $("#stat-total").textContent = formatEuro(total);
  $("#stat-perday").textContent = formatEuro(perDay) + " / day";

  // label + clear affordance reflect the active filter
  const label = !statsFilter.type ? "Total spent"
    : statsFilter.type === "kind" ? ({ need: "Needs", want: "Wants", saving: "Saved" }[statsFilter.value])
    : statsFilter.type === "pending" ? "Waiting to get back"
    : statsFilter.type === "income" ? "Money in"
    : statsFilter.value;
  $("#stat-label").textContent = label;
  $("#stat-clear").hidden = !statsFilter.type;

  // pending reimbursement line (money still to get back) — not filtered
  const pw = $("#reimb-pending");
  pw.classList.toggle("active", statsFilter.type === "pending");
  if (pending > 0) {
    pw.hidden = false;
    $("#reimb-pending-amt").textContent = formatEuro(pending);
  } else {
    pw.hidden = true;
  }

  // needs / wants / saved — reflects the filtered set; clickable to filter by kind
  const nwTotal = need + want + saved;
  const parts = { need, want, save: saved };
  const filterKey = { need: "need", want: "want", save: "saving" };
  let pctLeft = 100;
  ["need", "want", "save"].forEach((k, i) => {
    const pct = !nwTotal ? 0 : i === 2 ? pctLeft : Math.round((parts[k] / nwTotal) * 100);
    pctLeft -= pct;
    $("#nw-" + k).style.width = (nwTotal ? (parts[k] / nwTotal) * 100 : 0) + "%";
    $("#nw-" + k + "-amt").textContent = formatEuro(parts[k]);
    $("#nw-" + k + "-pct").textContent = nwTotal ? pct + "%" : "";
    const item = $("#nw-" + k + "-item");
    item.classList.toggle("active", kindFilter && statsFilter.value === filterKey[k]);
    item.classList.toggle("dim", kindFilter && statsFilter.value !== filterKey[k]);
  });
  $$(".b-in").forEach((b) => b.classList.toggle("active", statsFilter.type === "income"));
  // the budget buckets filter too
  $$(".b-bucket[data-filter]").forEach((b) => {
    b.classList.toggle("active", kindFilter && statsFilter.value === b.dataset.filter);
    b.classList.toggle("dim", kindFilter && statsFilter.value !== b.dataset.filter);
  });

  // category breakdown — scoped by an active kind filter, but not by a
  // category filter (so you can still switch between categories).
  // Unfiltered, it shows wants: needs are mostly fixed bills that dwarf
  // everything else, and wants are where money can be saved.
  const catScope = kindFilter ? rows.filter(matchesFilter) : rows.filter((r) => r.kind === "want");
  const byCat = {};
  catScope.forEach((r) => {
    const a = netAmount(r);
    if (a <= 0) return;
    const cats = (r.categories && r.categories.length) ? r.categories : ["Uncategorised"];
    cats.forEach((c) => { byCat[c] = (byCat[c] || 0) + a; });
  });

  const wrap = $("#cat-breakdown");
  wrap.innerHTML = "";
  const cats = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
  if (cats.length) {
    const head = document.createElement("div");
    head.className = "section-label";
    head.textContent = ({ need: "Needs", saving: "Saved" }[kindFilter && statsFilter.value] || "Wants") + " by category";
    wrap.appendChild(head);
    const max = byCat[cats[0]] || 1;
    cats.forEach((c) => {
      const row = document.createElement("div");
      row.className = "cat-row";
      if (catFilter && statsFilter.value === c) row.classList.add("active");
      else if (catFilter) row.classList.add("dim");
      row.innerHTML =
        '<div class="cat-row-top"><span>' + escapeHtml(c) + "</span><b>" + formatEuro(byCat[c]) + "</b></div>" +
        '<div class="cat-track"><div class="cat-fill" style="width:' + ((byCat[c] / max) * 100) + '%"></div></div>';
      row.addEventListener("click", () => setFilter("category", c));
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
  const shown = rows.filter(matchesFilter);
  if (!shown.length) { list.innerHTML = '<div class="hist-empty">No expenses here.</div>'; return; }

  const sub = document.createElement("div");
  sub.className = "hist-sub";
  const noun = statsFilter.type === "income" ? " entr" + (shown.length > 1 ? "ies" : "y") : " expense" + (shown.length > 1 ? "s" : "");
  sub.textContent = statsFilter.type ? shown.length + noun : "All entries";
  list.appendChild(sub);

  let lastDay = null;
  shown.forEach((r) => {
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
  if (r.reimbursable) {
    const part = isPartialReimb(r) ? " " + formatEuro(reimbAmount(r)) : "";
    if (r.reimbursed) sub.appendChild(makeBadge("↩︎" + part + " back", "reimb-done"));
    else {
      // tap the badge once the money is back
      const got = document.createElement("button");
      got.className = "badge reimb-pending";
      got.type = "button";
      got.textContent = "↩︎" + part + " pending · got it?";
      got.addEventListener("click", async (e) => {
        e.stopPropagation();
        const { error } = await sb.from("expenses").update({ reimbursed: true }).eq("id", r.id);
        if (error) { toast(error.message, true); return; }
        haptic();
        toast("Marked as received", false, { label: "Undo", fn: async () => {
          await sb.from("expenses").update({ reimbursed: false }).eq("id", r.id);
          refresh();
        } });
        refresh();
      });
      sub.appendChild(got);
    }
  }
  const catSpan = document.createElement("span");
  catSpan.className = "cats";
  catSpan.textContent = isIncome(r) ? (isExtra(r) ? "Money in · Extra" : "Money in · Bills") : (r.categories || []).join(" · ") || "—";
  sub.appendChild(catSpan);

  main.appendChild(title);
  main.appendChild(sub);
  main.addEventListener("click", () => openEdit(r));
  el.appendChild(main);

  const amt = document.createElement("div");
  if (isIncome(r)) {
    amt.className = "hi-amount income";
    amt.textContent = "+" + formatEuro(r.amount);
    el.appendChild(amt);
    el.appendChild(deleteBtn(r));
    return el;
  }
  // fully reimbursed: struck-through paid amount; partial: what's left on you
  const fullReimb = r.reimbursable && netAmount(r) === 0;
  amt.className = "hi-amount" + (fullReimb ? " reimb" : "");
  amt.textContent = formatEuro(r.reimbursable && !fullReimb ? netAmount(r) : paidAmount(r));
  el.appendChild(amt);

  el.appendChild(deleteBtn(r));
  return el;
}

function deleteBtn(r) {
  const del = document.createElement("button");
  del.className = "hi-act del";
  del.textContent = "🗑";
  del.setAttribute("aria-label", "Delete");
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    const { error } = await sb.from("expenses").delete().eq("id", r.id);
    if (error) { toast(error.message, true); return; }
    haptic();
    toast("Deleted " + (r.title || formatEuro(r.amount)), false, { label: "Undo", fn: async () => {
      const { error: e2 } = await sb.from("expenses").insert(Object.assign({}, r));
      if (e2) { toast(e2.message, true); return; }
      refresh();
    } });
    refresh();
  });
  return del;
}

/* ------------------------------------------------------------------ */
/*  Budget: salary + money in, need / want / savings split, bills      */
/* ------------------------------------------------------------------ */
const DEFAULT_BUDGET = { need_pct: 50, want_pct: 30, save_pct: 20, incomes: {}, bills: [] };
let budget = Object.assign({}, DEFAULT_BUDGET);
let budgetLoaded = false;
let budgetMissing = false; // the budgets table isn't created yet (old schema)
let reimbFull = (() => { try { return !!localStorage.getItem(LS.reimbFull); } catch (e) { return false; } })();
let billsOpen = (() => { try { return !!localStorage.getItem(LS.billsOpen); } catch (e) { return false; } })();

// Budget figures are shown in whole euros.
function euro0(n) { return formatEuro(Math.round(Number(n) || 0)); }

function parseMoney(raw) {
  const n = parseFloat(String(raw || "").trim().replace(/[€\s]/g, "").replace(",", "."));
  return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

// Returns false when it couldn't be read (offline…): saving then would
// overwrite the stored bills and salaries with stale or empty ones.
async function loadBudget() {
  const { data, error } = await sb.from("budgets").select("*").maybeSingle();
  budgetLoaded = true;
  if (error) {
    budgetMissing = /budgets/.test(error.message || "") || error.code === "42P01" || error.code === "PGRST205";
    console.error(error);
    return false;
  }
  budgetMissing = false;
  budget = Object.assign({}, DEFAULT_BUDGET, data || {});
  return true;
}

// An expense belongs to a bill when its title or a category has the same
// name (ignoring case, accents and extra spaces).
function matchesName(r, name) {
  const k = norm(name);
  if (!k) return false;
  if (norm(r.title) === k) return true;
  return (r.categories || []).some((c) => norm(c) === k);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// A progress bar: solid fill, optional reserved segment, optional "today" marker,
// optional outline when it goes past the line ("bad" or "good").
function bar(kind, used, reserved, total, markerPct, past) {
  const track = el("div", "b-track" + (past ? " past " + past : ""));
  const t = total > 0 ? total : 1;
  const usedPct = Math.min(100, (used / t) * 100);
  const resPct = Math.min(100 - usedPct, (reserved / t) * 100);
  const fill = el("div", "b-fill " + kind);
  fill.style.width = usedPct + "%";
  track.appendChild(fill);
  if (resPct > 0) {
    const res = el("div", "b-reserved " + kind);
    res.style.width = resPct + "%";
    track.appendChild(res);
  }
  if (markerPct != null) {
    const m = el("div", "b-marker");
    m.style.left = Math.min(100, markerPct) + "%";
    track.appendChild(m);
  }
  return track;
}

function bucket(kind, label, spent, target, opts) {
  opts = opts || {};
  const b = el("div", "b-bucket");
  // tap a bucket to filter the list below by it
  const filter = { need: "need", want: "want", save: "saving" }[kind];
  b.dataset.filter = filter;
  b.addEventListener("click", () => setFilter("kind", filter));
  const top = el("div", "b-top");
  const name = el("span", "b-name");
  name.appendChild(el("span", "dot " + kind));
  name.appendChild(document.createTextNode(label));
  top.appendChild(name);
  top.appendChild(el("span", "b-amt", euro0(spent) + " / " + euro0(target)));
  b.appendChild(top);
  const past = kind === "save" ? (spent >= target ? "good" : null)
    : spent + (opts.reserved || 0) > target ? "bad" : null;
  b.appendChild(bar(kind, spent, opts.reserved || 0, target, opts.marker, past));
  return b;
}

async function renderBudget(rows) {
  const wrap = $("#budget");
  if (!budgetLoaded) await loadBudget();
  if (statsRows !== rows) return; // a newer month loaded meanwhile
  wrap.innerHTML = "";

  $(".nw").hidden = false; // the budget card replaces this bar once a salary is logged
  if (budgetMissing) {
    const c = el("div", "bcard empty");
    c.appendChild(el("div", "hint", "Budgets need a database update: re-run supabase/schema.sql in the Supabase SQL editor."));
    wrap.appendChild(c);
    return;
  }

  const period = statsPeriod;
  const salary = period.income;
  if (salary == null) {
    const c = el("div", "bcard empty");
    c.appendChild(el("div", "hint", "Log your salary when it lands — your budget month runs from one payday to the next."));
    const btn = el("button", "btn primary small", "+ Salary received");
    btn.addEventListener("click", startSalary);
    c.appendChild(btn);
    const setup = el("button", "btn ghost small", "Bills & budget");
    setup.addEventListener("click", () => openBudgetSettings());
    c.appendChild(setup);
    wrap.appendChild(c);
    return;
  }

  const { current, today, dim, late, wantSpent, saved, extra, needBudget, wantBudget, saveTarget,
    needMine, bills, upcoming, upcomingWant } = budgetFigures(rows, period);

  // Three bars, no prose: solid = spent / saved, hatched = still planned.
  const card = el("div", "bcard");
  $(".nw").hidden = true;
  if (late) card.appendChild(el("div", "b-late", "Payday was expected — log your salary"));

  // wants: spent + subscriptions still to come, with a "today" marker for pace
  card.appendChild(bucket("want", "Wants", wantSpent, wantBudget,
    { reserved: upcomingWant, marker: current ? (today / dim) * 100 : null }));

  // needs: your share paid so far + bills still planned this month
  card.appendChild(bucket("need", "Needs", needMine, needBudget, { reserved: upcoming }));

  // save: what you've put aside against the target; what's left in needs / wants
  // at the end of the month is yours to move here
  card.appendChild(bucket("save", "Save", saved, saveTarget));

  const foot = el("div", "b-foot");
  foot.appendChild(el("span", "", "Salary " + euro0(salary) + " · " +
    period.start.toLocaleDateString(undefined, { day: "numeric", month: "short" })));
  if (extra) {
    // tap to list the money in below (edit or delete it from there)
    const inBtn = el("button", "b-in" + (statsFilter.type === "income" ? " active" : ""), "+ " + euro0(extra) + " in ›");
    inBtn.type = "button";
    inBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setFilter("income", true);
      $("#stat-total").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    foot.appendChild(inBtn);
  }
  card.appendChild(foot);
  const acts = el("div", "b-acts");
  const actBtn = (label, fn) => {
    const b = el("button", "plan-act", label);
    b.type = "button";
    b.addEventListener("click", fn);
    acts.appendChild(b);
  };
  if (current) {
    actBtn("+ Money in", startIncome);
    actBtn("+ Salary", startSalary);
  }
  // reimbursable expenses: count what's left on you, or the full amount
  if (rows.some((r) => r.reimbursable)) {
    // on (highlighted) = refunds taken off
    const t = el("button", "plan-act toggle" + (reimbFull ? "" : " active"), "↩︎");
    t.type = "button";
    t.setAttribute("aria-label", "Take refunds off reimbursable expenses");
    t.addEventListener("click", () => {
      haptic();
      reimbFull = !reimbFull;
      try { localStorage.setItem(LS.reimbFull, reimbFull ? "1" : ""); } catch (e) {}
      toast(reimbFull ? "Reimbursable: full amount" : "Reimbursable: after refund");
      renderStats(statsRows);
      renderList(statsRows);
      renderBudget(statsRows);
    });
    acts.appendChild(t);
  }
  card.appendChild(acts);
  wrap.appendChild(card);

  // bills checklist (current month only), collapsed behind a summary header
  if (current && bills.length) {
    const toPay = bills.filter((b) => !b.paid);
    const head = el("button", "fold-head" + (billsOpen ? " open" : ""));
    head.type = "button";
    head.appendChild(el("span", "", "Bills"));
    head.appendChild(el("span", "fold-sum", toPay.length
      ? toPay.length + " to pay · " + euro0(toPay.reduce((s, b) => s + b.amount, 0)) : "All paid ✓"));
    const list = el("div", "fold-body");
    list.hidden = !billsOpen;
    head.addEventListener("click", () => {
      billsOpen = !billsOpen;
      try { localStorage.setItem(LS.billsOpen, billsOpen ? "1" : ""); } catch (e) {}
      head.classList.toggle("open", billsOpen);
      list.hidden = !billsOpen;
    });
    wrap.appendChild(head);
    wrap.appendChild(list);
    byDue(bills).forEach((b) => list.appendChild(billRow(b)));
  }

}

// Everything the budget views need for a period: spent per bucket, the lines
// and the bills. Without a salary the lines are 0 (callers check salary first).
function budgetFigures(rows, period) {
  const salary = period.income;
  const current = isCurrentPeriod(period);
  const today = daysElapsed(period);                       // day number within the period
  const dim = Math.max(1, daysBetween(period.start, period.estEnd)); // period length (estimated while open)
  const late = current && today > dim;                     // next salary expected but not logged yet

  let needSpent = 0, wantSpent = 0, saved = 0, covers = 0, bonus = 0;
  rows.forEach((r) => {
    const a = netAmount(r);
    if (isIncome(r)) { if (isExtra(r)) bonus += Number(r.amount) || 0; else covers += Number(r.amount) || 0; }
    else if (r.kind === "need") needSpent += a;
    else if (r.kind === "save") saved += a;
    else wantSpent += a; // wants (and anything untagged)
  });

  // the salary (plus extra money in: DJ fee, eBay…) is split by the percentages,
  // fixed. Money in that covers bills (a sub-tenant's rent…) comes off what you
  // spent on needs instead: the Needs bar shows your own share
  const extra = covers + bonus;
  const base = (salary || 0) + bonus;
  const needBudget = salary == null ? 0 : base * budget.need_pct / 100;
  const wantBudget = salary == null ? 0 : base * budget.want_pct / 100;
  const saveTarget = salary == null ? 0 : base * budget.save_pct / 100;
  const needMine = Math.max(0, needSpent - covers);

  // bills: paid this period when a need / want with the same name exists; due on
  // the first occurrence of their day on/after payday. Unpaid ones are reserved
  // from their own bucket (needs, or wants for subscriptions).
  const bills = (budget.bills || []).map((b) => ({
    name: b.name, amount: Number(b.amount) || 0, due: dueDate(b.day, period.start), kind: billKind(b),
    paid: rows.some((r) => (r.kind === "need" || r.kind === "want") && matchesName(r, b.name)),
  }));
  const unpaid = (kind) => current ? bills.filter((b) => b.kind === kind && !b.paid).reduce((s, b) => s + b.amount, 0) : 0;
  const upcoming = unpaid("need");
  const upcomingWant = unpaid("want");

  return { salary, current, today, dim, late, needSpent, wantSpent, saved, covers, bonus, extra,
    needBudget, wantBudget, saveTarget, needMine, bills, upcoming, upcomingWant };
}

// Bills by due date, the ones without a day last.
function byDue(bills) {
  return bills.slice().sort((a, b) => (a.due ? a.due.getTime() : Infinity) - (b.due ? b.due.getTime() : Infinity));
}

// One bill: due date, amount, and a Paid button that logs it.
function billRow(b) {
  const todayDate = startOfDay(new Date());
  const row = el("div", "plan-row" + (b.paid ? " done" : ""));
  const main = el("div", "plan-main");
  const name = el("div", "plan-name");
  name.appendChild(el("span", "dot " + b.kind));
  name.appendChild(document.createTextNode(b.name));
  main.appendChild(name);
  const overdue = !b.paid && b.due && b.due < todayDate;
  main.appendChild(el("div", "plan-sub" + (overdue ? " bad" : ""), b.paid ? "Paid" : dueLabel(b.due, todayDate, "Not paid yet")));
  row.appendChild(main);
  row.appendChild(el("div", "plan-amt", euro0(b.amount)));
  if (b.paid) row.appendChild(el("span", "plan-act done", "✓"));
  else {
    const pay = el("button", "plan-act", "Paid");
    pay.type = "button";
    pay.addEventListener("click", () => logBill(b));
    row.appendChild(pay);
  }
  return row;
}

// The first occurrence of a day of the month on/after payday, or null.
function dueDate(day, start) {
  day = Number(day) || null;
  if (!day) return null;
  let due = new Date(start.getFullYear(), start.getMonth(), day);
  if (due < start) due = new Date(start.getFullYear(), start.getMonth() + 1, day);
  return due;
}

// "Due in 3 days" / "Due today" / "Was due 5 Oct", or the fallback without a day.
function dueLabel(due, today, fallback) {
  if (!due) return fallback;
  const inDays = daysBetween(today, due);
  return inDays < 0 ? "Was due " + due.toLocaleDateString(undefined, { day: "numeric", month: "short" })
    : inDays === 0 ? "Due today" : "Due in " + inDays + " day" + (inDays > 1 ? "s" : "");
}

// Bills are needs unless marked as a want (subscriptions).
function billKind(b) { return b.kind === "want" ? "want" : "need"; }

// One tap: log a planned bill as paid today (edit it from the list if it differed).
async function logBill(b) {
  haptic();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { showScreen("screen-auth"); return; }
  const kind = billKind(b);
  const { data, error } = await sb.from("expenses").insert({
    user_id: user.id, amount: b.amount, title: b.name,
    categories: ["Bills"], kind,
  }).select();
  if (error) { toast(error.message, true); return; }
  const row = data && data[0];
  toast(b.name + " logged · " + euro0(b.amount), false, row ? { label: "Change", fn: () => openEdit(row) } : null);
  refresh();
}

// Extra money in: opens on the details step, where past sources are one tap
// (same amount as last time). A new one: type the title, Save, then the amount.
function startIncome() {
  haptic();
  const back = currentTab();
  resetEntry();
  entry.kind = "income";
  entry.returnTo = back;
  showScreen("screen-entry");
  enterDetails();
}

// Money in saved from the details step: ask for the amount first if it's missing.
function saveIncome() {
  if (!entry.amount) { toast("Enter an amount", true); showStep("step-amount"); return; }
  saveExpense();
}

/* ---- budget settings screen ---- */
function inputCell(cls, value, placeholder, mode) {
  const i = document.createElement("input");
  i.className = cls;
  i.type = "text";
  i.value = value == null ? "" : value;
  i.placeholder = placeholder;
  i.autocomplete = "off";
  if (mode) i.inputMode = mode;
  return i;
}

function removeBtn(row) {
  const x = el("button", "hi-act del", "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Remove");
  x.addEventListener("click", () => row.remove());
  return x;
}

function addBillRow(b) {
  const row = el("div", "edit-row");
  row.appendChild(inputCell("er-name", b.name, "Rent"));
  row.appendChild(inputCell("er-amt", b.amount, "€", "decimal"));
  row.appendChild(inputCell("er-day", b.day, "Day", "numeric"));
  const kind = el("button", "er-kind");
  kind.type = "button";
  const setKind = (k) => { row.dataset.kind = k; kind.textContent = k === "want" ? "Want" : "Need"; kind.className = "er-kind " + k; };
  setKind(billKind(b));
  kind.addEventListener("click", () => { haptic(); setKind(row.dataset.kind === "want" ? "need" : "want"); });
  row.appendChild(kind);
  row.appendChild(removeBtn(row));
  $("#bs-bills").appendChild(row);
}

function updateSplitHint() {
  const sum = ["#bs-need", "#bs-want", "#bs-save"].reduce((s, id) => s + (parseFloat($(id).value) || 0), 0);
  const h = $("#bs-split-hint");
  h.textContent = sum === 100 ? "Adds up to 100% ✓" : "Adds up to " + sum + "% — should be 100%";
  h.classList.toggle("bad", sum !== 100);
}

// Unsaved edits on the budget screen: leaving asks before dropping them.
let budgetDirty = false;
function leaveBudgetSettings() {
  if (budgetDirty && !confirm("Discard your budget changes?")) return false;
  budgetDirty = false;
  return true;
}

// Salaries older than the ones shown in settings, kept untouched on save.
let hiddenPaydays = {};
const SHOWN_PAYDAYS = 6;

function addSalaryRow(p, prepend) {
  const row = el("div", "edit-row");
  const date = document.createElement("input");
  date.type = "date";
  date.className = "er-date";
  date.value = p.date || "";
  date.max = toDateInput(new Date());
  row.appendChild(date);
  row.appendChild(inputCell("er-amt wide", p.amount, "€", "decimal"));
  row.appendChild(removeBtn(row));
  const list = $("#bs-salaries");
  if (prepend) list.insertBefore(row, list.firstChild); else list.appendChild(row);
  return row;
}

async function openBudgetSettings() {
  // always fresh: saving writes back every salary and bill shown here
  const ok = await loadBudget();
  if (budgetMissing) { toast("Re-run supabase/schema.sql first", true); return; }
  if (!ok) { toast("Couldn't load your budget — try again", true); return; }
  const pays = paydays().reverse(); // newest first
  hiddenPaydays = {};
  pays.slice(SHOWN_PAYDAYS).forEach((p) => { hiddenPaydays[p.date] = p.amount; });
  $("#bs-salaries").innerHTML = "";
  pays.slice(0, SHOWN_PAYDAYS).forEach((p) => addSalaryRow(p));
  $("#bs-need").value = budget.need_pct;
  $("#bs-want").value = budget.want_pct;
  $("#bs-save").value = budget.save_pct;
  updateSplitHint();
  $("#bs-bills").innerHTML = "";
  (budget.bills || []).forEach(addBillRow);
  budgetDirty = false;
  showScreen("screen-budget");
  $("#screen-budget .hist-scroll").scrollTop = 0;
}

async function saveBudgetSettings() {
  const pcts = ["#bs-need", "#bs-want", "#bs-save"].map((id) => parseFloat($(id).value) || 0);
  if (pcts[0] + pcts[1] + pcts[2] !== 100) { toast("Split must add up to 100%", true); return; }

  const incomes = Object.assign({}, hiddenPaydays);
  for (const row of $$("#bs-salaries .edit-row")) {
    const date = row.querySelector(".er-date").value;
    const raw = row.querySelector(".er-amt").value.trim();
    if (!date && !raw) continue;
    const amount = parseMoney(raw);
    if (!date || amount == null) { toast("Each salary needs a date and an amount", true); return; }
    incomes[date] = amount;
  }

  const bills = [];
  for (const row of $$("#bs-bills .edit-row")) {
    const name = row.querySelector(".er-name").value.trim();
    if (!name) continue;
    const amount = parseMoney(row.querySelector(".er-amt").value);
    if (amount == null) { toast("Invalid amount for " + name, true); return; }
    const day = parseInt(row.querySelector(".er-day").value, 10);
    bills.push({ name, amount, day: day >= 1 && day <= 31 ? day : null, kind: row.dataset.kind === "want" ? "want" : "need" });
  }

  const { data: { user } } = await sb.auth.getUser();
  if (!user) { showScreen("screen-auth"); return; }
  const next = {
    user_id: user.id, need_pct: pcts[0], want_pct: pcts[1], save_pct: pcts[2],
    incomes, bills, updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from("budgets").upsert(next);
  if (error) { toast(error.message, true); return; }
  budget = Object.assign({}, DEFAULT_BUDGET, next);
  budgetDirty = false;
  haptic();
  toast("Budget saved");
  statsPeriod = periodFor(new Date());
  statsFilter = { type: null, value: null };
  homePick = null;
  openHome();
}

/* ------------------------------------------------------------------ */
/*  Home: the month at a glance                                        */
/* ------------------------------------------------------------------ */
let homePick = null;  // start of a past period picked on Home; null = the current one
let homeSeq = 0;      // drops a slow load when a newer one started

function homePeriod() { return homePick ? periodFor(homePick) : periodFor(new Date()); }

// keepPeriod: stay on a past month picked on Home (coming back from an entry).
async function openHome(keepPeriod) {
  if (!keepPeriod) homePick = null;
  showScreen("screen-home");
  $("#home-scroll").scrollTop = 0;
  loadHome();
}

async function loadHome() {
  const seq = ++homeSeq;
  renderHomeHead();
  if (!budgetLoaded) await loadBudget();
  const period = homePeriod();
  const prev = periodFor(addDays(period.start, -1));
  const [cur, old] = await Promise.all([fetchRows(period), fetchRows(prev)]);
  if (seq !== homeSeq) return;
  if (cur.error) { toast(cur.error.message, true); return; }
  renderHome(period, cur.data, old.error ? null : old.data, prev);
}

function renderHomeHead() {
  const now = new Date();
  const h = now.getHours();
  $("#home-date").textContent = now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  $("#home-hello").textContent = h >= 5 && h < 12 ? "Good morning\u00a0👋" : h >= 12 && h < 18 ? "Good afternoon\u00a0☀️" : "Good evening\u00a0🌙";
  sb.auth.getSession().then(({ data }) => {
    const email = data && data.session && data.session.user ? data.session.user.email || "" : "";
    $("#home-avatar").textContent = (email.trim()[0] || "€").toUpperCase();
  });
}

// "October budget": a payday period is named after the month most of it falls in.
function periodName(p) {
  if (!p.pay && p.end.getDate() !== 1) return periodLabel(p); // the days before your first salary
  const mid = p.pay ? addDays(p.start, 14) : p.start;
  const opts = { month: "long" };
  if (mid.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return mid.toLocaleDateString(undefined, opts) + " budget";
}

// What you spent on needs (your share, after money in that covers bills) and
// wants, optionally only before a date. Savings aren't spending.
function spendOf(rows, until) {
  let need = 0, want = 0, covers = 0;
  rows.forEach((r) => {
    if (until && new Date(r.created_at) >= until) return;
    if (isIncome(r)) { if (!isExtra(r)) covers += Number(r.amount) || 0; }
    else if (r.kind === "need") need += netAmount(r);
    else if (r.kind !== "save") want += netAmount(r);
  });
  return Math.max(0, need - covers) + want;
}

// Big money: whole euros, with cents (if any) set smaller.
function bigEuro(n) {
  const s = formatEuro(Math.round(Math.abs(n) * 100) / 100);
  const frag = document.createDocumentFragment();
  const dot = s.indexOf(".");
  frag.appendChild(document.createTextNode(dot < 0 ? s : s.slice(0, dot)));
  if (dot >= 0) frag.appendChild(el("small", "", s.slice(dot)));
  return frag;
}

// The ring: spent (solid) then bills still to pay (faint), as a share of the line.
function ring(spentPct, reservedPct, over) {
  const C = 2 * Math.PI * 50;
  const s = Math.max(0, Math.min(1, spentPct));
  const r = Math.max(0, Math.min(1 - s, reservedPct));
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 120 120");
  const circle = (cls, len, offset) => {
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", "60"); c.setAttribute("cy", "60"); c.setAttribute("r", "50");
    c.setAttribute("class", cls);
    if (len != null) {
      c.setAttribute("stroke-dasharray", len + " " + C);
      c.setAttribute("stroke-dashoffset", String(-offset));
    }
    svg.appendChild(c);
  };
  circle("ring-track");
  if (r > 0) circle("ring-res", r * C, s * C);
  if (s > 0) circle("ring-fill" + (over ? " over" : ""), s * C, 0);
  return svg;
}

// "On track" / "Ahead of pace" / "Over budget" for the hero card.
function homeStatus(f) {
  const spent = f.needMine + f.wantSpent;
  if (spent + f.upcoming + f.upcomingWant > f.needBudget + f.wantBudget) return ["Over budget", "bad"];
  if (!f.current) return ["Under budget", "good"];
  if (f.late) return ["Payday due", "warn"];
  // wants are the day-to-day money: compare them with the time gone by
  if (f.wantSpent > f.wantBudget * Math.min(1, f.today / f.dim) * 1.1 + 1) return ["Ahead of pace", "warn"];
  return ["On track", "good"];
}

function heroTile(label, value, cls) {
  const t = el("div", "hero-tile");
  t.appendChild(el("div", "ht-label", label));
  t.appendChild(el("div", "ht-val" + (cls ? " " + cls : ""), value));
  return t;
}

// vs. last month: spent so far against the same number of days last period.
function compareTile(rows, prevRows, prev, f) {
  if (!prevRows || !prevRows.length) return heroTile("vs. last month", "—");
  const until = f.current ? addDays(prev.start, f.today) : null;
  const diff = spendOf(rows) - spendOf(prevRows, until);
  if (Math.abs(diff) < 1) return heroTile("vs. last month", "Same");
  return heroTile("vs. last month", (diff < 0 ? "↓ " : "↑ ") + euro0(Math.abs(diff)), diff < 0 ? "good" : "bad");
}

function renderHero(period, rows, prevRows, prev, f) {
  const hero = $("#hero");
  hero.innerHTML = "";
  const top = el("div", "hero-top");
  const pill = el("button", "hero-pill");
  pill.type = "button";
  pill.appendChild(el("span", "", periodName(period)));
  pill.appendChild(el("span", "hero-chev", "⌄"));
  pill.addEventListener("click", openPeriodSheet);
  top.appendChild(pill);
  hero.appendChild(top);

  if (budgetMissing) {
    hero.appendChild(el("p", "hero-note", "Budgets need a database update: re-run supabase/schema.sql in the Supabase SQL editor."));
    return;
  }

  const daysLeft = f.current ? Math.max(1, f.dim - f.today + 1) : 0;
  const mid = el("div", "hero-mid");
  const text = el("div", "hero-text");

  if (f.salary == null) {
    // no salary yet: what went out, per day, and a nudge to set the budget up
    const spent = spendOf(rows);
    text.appendChild(el("div", "hero-label", "Spent so far"));
    const big = el("div", "hero-big");
    big.appendChild(bigEuro(spent));
    text.appendChild(big);
    text.appendChild(el("div", "hero-of", f.current ? daysLeft + " days left in " + period.start.toLocaleDateString(undefined, { month: "long" }) : periodLabel(period)));
    mid.appendChild(text);
    hero.appendChild(mid);
    const tiles = el("div", "hero-tiles");
    tiles.appendChild(heroTile("Per day", euro0(spent / daysElapsed(period))));
    tiles.appendChild(compareTile(rows, prevRows, prev, f));
    hero.appendChild(tiles);
    if (f.current) {
      const cta = el("button", "hero-cta", "Log your salary to set a budget ›");
      cta.type = "button";
      cta.addEventListener("click", startSalary);
      hero.appendChild(cta);
    }
    return;
  }

  const [status, cls] = homeStatus(f);
  top.appendChild(el("span", "hero-status " + cls, status));

  const line = f.needBudget + f.wantBudget;
  const spent = f.needMine + f.wantSpent;
  const reserved = f.upcoming + f.upcomingWant;
  const left = line - spent - reserved;
  const over = left < 0;

  const r = el("div", "ring");
  r.appendChild(ring(line ? spent / line : 0, line ? reserved / line : 0, over));
  const lab = el("div", "ring-label");
  lab.appendChild(el("div", "ring-pct", Math.round(line ? (spent / line) * 100 : 0) + "%"));
  lab.appendChild(el("div", "ring-sub", "spent"));
  r.appendChild(lab);
  mid.appendChild(r);

  text.appendChild(el("div", "hero-label", over ? "Over by" : "Left to spend"));
  const big = el("div", "hero-big" + (over ? " bad" : ""));
  big.appendChild(bigEuro(left));
  text.appendChild(big);
  const when = !f.current ? "closed" : f.late ? "payday expected" : daysLeft + " day" + (daysLeft > 1 ? "s" : "") + " left";
  text.appendChild(el("div", "hero-of", "of " + euro0(line) + " · " + when));
  if (reserved > 0) text.appendChild(el("div", "hero-of faint", euro0(reserved) + " kept for bills"));
  mid.appendChild(text);
  hero.appendChild(mid);

  const tiles = el("div", "hero-tiles");
  if (f.current) tiles.appendChild(heroTile("Safe to spend today", formatEuro(Math.floor(Math.max(0, left) / daysLeft * 100) / 100)));
  else tiles.appendChild(heroTile("Saved", euro0(f.saved) + " / " + euro0(f.saveTarget), f.saved >= f.saveTarget ? "good" : ""));
  tiles.appendChild(compareTile(rows, prevRows, prev, f));
  hero.appendChild(tiles);
}

/* ---- tip card: one useful nudge at a time, dismissable ---- */
function hiddenTips() {
  try { const v = JSON.parse(localStorage.getItem(LS.tipsHidden) || "[]"); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}
function hideTip(key) {
  const list = hiddenTips().filter((k) => k !== key).concat([key]).slice(-40);
  try { localStorage.setItem(LS.tipsHidden, JSON.stringify(list)); } catch (e) {}
}

function homeTips(period, rows, f) {
  const tips = [];
  if (budgetMissing) return tips;
  const todayDate = startOfDay(new Date());
  if (f.salary == null) {
    if (f.current) tips.push({ id: "salary", icon: "💼", title: "Set up your budget",
      body: "Log your salary when it lands — your budget month runs from one payday to the next.", fn: startSalary });
  } else if (f.late) {
    tips.push({ id: "late", icon: "📅", title: "Payday was expected", body: "Log your salary to start a new budget month.", fn: startSalary });
  }
  if (f.current) {
    const late = byDue(f.bills.filter((b) => !b.paid && b.due && b.due < todayDate))[0];
    if (late) tips.push({ id: "bill-" + norm(late.name), icon: "🧾", title: late.name + " is overdue",
      body: dueLabel(late.due, todayDate, "") + " · " + euro0(late.amount) + ". Tap Paid once it's gone out.", fn: openBills });
  }
  if (f.salary != null && f.current && !f.late && f.wantBudget > 0) {
    const used = f.wantSpent / f.wantBudget;
    if (used > 0.25 && used > (f.today / f.dim) * 1.15) {
      const byCat = {};
      rows.forEach((r) => {
        if (r.kind !== "want") return;
        (r.categories.length ? r.categories : ["Uncategorised"]).forEach((c) => { byCat[c] = (byCat[c] || 0) + netAmount(r); });
      });
      const top = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a])[0];
      const daysLeft = Math.max(1, f.dim - f.today + 1);
      const perDay = Math.max(0, f.wantBudget - f.wantSpent - f.upcomingWant) / daysLeft;
      tips.push({ id: "hot", icon: "🔥", title: (top ? top : "Wants") + " " + (top ? "is" : "are") + " running hot",
        body: "You've used " + Math.round(used * 100) + "% of your wants with " + daysLeft + " days to go. " +
          (perDay >= 1 ? "Keep wants under " + euro0(perDay) + " a day to finish on budget."
            : "Every want from here comes out of savings."),
        fn: () => openHistory({ type: "kind", value: "want" }, period) });
    }
  }
  const pending = rows.reduce((s, r) => s + pendingReimb(r), 0);
  if (pending > 0) tips.push({ id: "pending", icon: "↩︎", title: euro0(pending) + " still owed to you",
    body: "From reimbursable expenses. Tap the badge on each one once the money's back.",
    fn: () => openHistory({ type: "pending", value: true }, period) });
  if (f.salary != null && f.current && !f.late && f.dim - f.today < 5 && f.saved < f.saveTarget) {
    const free = f.needBudget + f.wantBudget - f.needMine - f.wantSpent - f.upcoming - f.upcomingWant;
    if (free >= 1) tips.push({ id: "save", icon: "🐷", title: "Move what's left to savings",
      body: euro0(free) + " is still free with " + Math.max(1, f.dim - f.today + 1) + " days to go. Log it as Save to reach your " + euro0(f.saveTarget) + " target.",
      fn: startAdd });
  }
  return tips;
}

function renderTip(period, rows, f) {
  const wrap = $("#home-tip");
  wrap.innerHTML = "";
  const hidden = hiddenTips();
  const tip = homeTips(period, rows, f).find((t) => hidden.indexOf(t.id + "@" + toDateInput(period.start)) < 0);
  if (!tip) return;
  const card = el("div", "tip");
  card.appendChild(el("div", "tip-ico", tip.icon));
  const main = el("button", "tip-main");
  main.type = "button";
  main.appendChild(el("div", "tip-title", tip.title));
  main.appendChild(el("div", "tip-body", tip.body));
  main.addEventListener("click", () => { haptic(); tip.fn(); });
  card.appendChild(main);
  const x = el("button", "tip-x", "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Dismiss");
  x.addEventListener("click", () => { haptic(); hideTip(tip.id + "@" + toDateInput(period.start)); renderTip(period, rows, f); });
  card.appendChild(x);
  wrap.appendChild(card);
}

/* ---- budgets: one card per bucket, tap to see its entries ---- */
function homeBucket(period, kind, label, icon, spent, target, opts) {
  opts = opts || {};
  const filter = { need: "need", want: "want", save: "saving" }[kind];
  const row = el("button", "hb-row");
  row.type = "button";
  row.addEventListener("click", () => openHistory({ type: "kind", value: filter }, period));
  const top = el("div", "hb-top");
  top.appendChild(el("span", "hb-ico " + kind, icon));
  const main = el("div", "hb-main");
  main.appendChild(el("div", "hb-name", label));
  main.appendChild(el("div", "hb-sub", target == null ? "this month" : euro0(spent) + " of " + euro0(target)));
  top.appendChild(main);
  let right = euro0(spent), cls = "";
  if (target != null) {
    const left = target - spent - (opts.reserved || 0);
    if (kind === "save") { right = spent >= target ? "Done ✓" : euro0(target - spent) + " to go"; cls = spent >= target ? "good" : ""; }
    else { right = left >= 0 ? euro0(left) + " left" : euro0(-left) + " over"; cls = left >= 0 ? "" : "bad"; }
  }
  top.appendChild(el("div", "hb-right " + cls, right));
  row.appendChild(top);
  if (target != null) {
    const past = kind === "save" ? (spent >= target ? "good" : null) : spent + (opts.reserved || 0) > target ? "bad" : null;
    row.appendChild(bar(kind, spent, opts.reserved || 0, target, opts.marker, past));
  } else {
    row.appendChild(bar(kind, spent, 0, opts.max || 1));
  }
  return row;
}

function renderHomeBudgets(period, rows, f) {
  const wrap = $("#home-budgets");
  wrap.innerHTML = "";
  if (f.salary == null) {
    // no lines yet: what went where this month
    let need = 0, want = 0, save = 0;
    rows.forEach((r) => {
      if (isIncome(r)) return;
      if (r.kind === "need") need += netAmount(r); else if (r.kind === "save") save += netAmount(r); else want += netAmount(r);
    });
    const max = Math.max(need, want, save, 1);
    wrap.appendChild(homeBucket(period, "want", "Wants", "✦", want, null, { max }));
    wrap.appendChild(homeBucket(period, "need", "Needs", "✓", need, null, { max }));
    wrap.appendChild(homeBucket(period, "save", "Save", "◆", save, null, { max }));
    return;
  }
  wrap.appendChild(homeBucket(period, "want", "Wants", "✦", f.wantSpent, f.wantBudget,
    { reserved: f.upcomingWant, marker: f.current ? (f.today / f.dim) * 100 : null }));
  wrap.appendChild(homeBucket(period, "need", "Needs", "✓", f.needMine, f.needBudget, { reserved: f.upcoming }));
  wrap.appendChild(homeBucket(period, "save", "Save", "◆", f.saved, f.saveTarget));
  if (f.extra) {
    const inBtn = el("button", "link hb-in", "+ " + euro0(f.extra) + " money in this month ›");
    inBtn.type = "button";
    inBtn.addEventListener("click", () => openHistory({ type: "income", value: true }, period));
    wrap.appendChild(inBtn);
  }
}

function renderHome(period, rows, prevRows, prev) {
  const f = budgetFigures(rows, period);
  renderHero(period, rows, prevRows, prev, f);
  renderTip(period, rows, f);
  renderHomeBudgets(period, rows, f);

  // bills: the next ones to pay (current month only)
  const todayDate = startOfDay(new Date());
  const toPay = f.current ? byDue(f.bills.filter((b) => !b.paid)) : [];
  $("#home-bell-dot").hidden = !toPay.some((b) => b.due && daysBetween(todayDate, b.due) <= 3);
  const billsWrap = $("#home-bills-wrap");
  billsWrap.hidden = !(f.current && f.bills.length);
  const bl = $("#home-bills");
  bl.innerHTML = "";
  if (toPay.length) toPay.slice(0, 3).forEach((b) => bl.appendChild(billRow(b)));
  else bl.appendChild(el("div", "plan-row done-all", "All bills paid this month ✓"));

  // recent entries: edit or delete them right here
  const rec = $("#home-recent");
  rec.innerHTML = "";
  if (!rows.length) {
    rec.appendChild(el("div", "hist-empty card", isCurrentPeriod(period) ? "Nothing logged yet — tap + to add an expense." : "Nothing logged that month."));
    return;
  }
  rows.slice(0, 5).forEach((r) => rec.appendChild(renderItem(r)));
}

/* ---- budget month picker ---- */
function openPeriodSheet() {
  haptic();
  const list = $("#sheet-list");
  list.innerHTML = "";
  const shown = toDateInput(homePeriod().start);
  let p = periodFor(new Date());
  for (let i = 0; i < 12; i++) {
    const start = p.start;
    const current = i === 0;
    const b = el("button", "sheet-item" + (toDateInput(start) === shown ? " active" : ""));
    b.type = "button";
    b.appendChild(el("span", "", periodName(p)));
    if (p.pay) b.appendChild(el("span", "sheet-sub", periodLabel(p)));
    b.addEventListener("click", () => {
      homePick = current ? null : start;
      $("#sheet").hidden = true;
      haptic();
      loadHome();
    });
    list.appendChild(b);
    p = periodFor(addDays(p.start, -1));
  }
  $("#sheet").hidden = false;
}

/* ---- bills screen ---- */
async function openBills() {
  showScreen("screen-bills");
  loadBills();
}

async function loadBills() {
  if (!budgetLoaded) await loadBudget();
  const period = periodFor(new Date());
  const { data, error } = await fetchRows(period);
  if (error) { toast(error.message, true); return; }
  const f = budgetFigures(data, period);
  const sum = $("#bills-sum");
  const list = $("#bills-list");
  sum.innerHTML = "";
  list.innerHTML = "";
  if (!f.bills.length) {
    const c = el("div", "bcard empty");
    c.appendChild(el("div", "hint", "Add your rent, subscriptions and other recurring payments: unpaid ones are kept aside from your budget, and one tap logs them."));
    const add = el("button", "btn primary small", "+ Add bills");
    add.addEventListener("click", () => openBudgetSettings());
    c.appendChild(add);
    sum.appendChild(c);
    return;
  }
  const toPay = f.bills.filter((b) => !b.paid);
  const total = f.bills.reduce((s, b) => s + b.amount, 0);
  const left = toPay.reduce((s, b) => s + b.amount, 0);
  const card = el("div", "bcard bills-card");
  card.appendChild(el("div", "stat-total-label", toPay.length ? "Still to pay this month" : "All paid this month"));
  card.appendChild(el("div", "stat-total-amount", euro0(left)));
  card.appendChild(el("div", "stat-perday", (f.bills.length - toPay.length) + " of " + f.bills.length + " paid · " + euro0(total) + " a month"));
  const b = bar("need", total - left, 0, total);
  b.classList.add("bills-bar");
  card.appendChild(b);
  sum.appendChild(card);
  if (toPay.length) {
    list.appendChild(el("div", "section-label", "To pay"));
    byDue(toPay).forEach((x) => list.appendChild(billRow(x)));
  }
  const paid = f.bills.filter((x) => x.paid);
  if (paid.length) {
    list.appendChild(el("div", "section-label", "Paid"));
    paid.forEach((x) => list.appendChild(billRow(x)));
  }
}

/* ---- navigation ---- */
function startAdd() {
  haptic();
  const back = currentTab();
  resetEntry();
  entry.returnTo = back;
  showScreen("screen-entry");
  showStep("step-amount");
}

function navTab(tab) {
  // leaving the budget settings: ask before dropping unsaved changes
  if ($("#screen-budget").classList.contains("active")) {
    if (tab === "settings") return;
    if (!leaveBudgetSettings()) return;
  }
  haptic();
  if (tab === "add") startAdd();
  else if (tab === "home") openHome();
  else if (tab === "insights") openHistory();
  else if (tab === "bills") openBills();
  else if (tab === "settings") openBudgetSettings();
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
  if (!confirm("Sign out of Saver on this device?")) return;
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
  refreshSavedCats();
  resetEntry();
  showStep("step-amount");
  budgetLoaded = false; // fresh after signing in
  openHome();
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

  // amount -> details (or straight to save for prefilled flows)
  $("#amount-next").addEventListener("click", () => {
    if (entry.amount === 0) { toast("Enter an amount", true); return; }
    if (entry.kind === "salary") { saveSalary(); return; }
    if (entry.quick) { saveExpense(); return; }
    enterDetails();
  });

  // details
  $("#det-back").addEventListener("click", () => showStep("step-amount"));
  $("#entry-date").addEventListener("change", (e) => {
    entry.date = e.target.value || toDateInput(new Date());
    updateDateUI();
  });
  $("#title-input").addEventListener("input", (e) => onTitleInput(e.target.value));
  $("#title-input").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (entry.kind === "income") saveIncome(); else e.target.blur();
  });
  $("#det-save").addEventListener("click", saveIncome);
  $$("#in-kind .pill").forEach((b) => b.addEventListener("click", () => setExtra(b.dataset.in === "extra")));
  $("#cat-custom").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addCustomCategory(e.target.value); }
  });
  $("#cat-custom").addEventListener("blur", (e) => {
    if (e.target.value.trim()) addCustomCategory(e.target.value);
  });

  // flags + kind (tapping a kind saves)
  $("#reimb-toggle").addEventListener("click", toggleReimb);
  $("#received-toggle").addEventListener("click", toggleReceived);
  $("#reimb-amt").addEventListener("input", (e) => (entry.reimbAmount = e.target.value));
  $$(".kind-btn").forEach((b) => b.addEventListener("click", () => {
    if (!$("#cat-custom-wrap").hidden) addCustomCategory($("#cat-custom").value);
    entry.kind = b.dataset.kind;
    saveExpense();
  }));
  $("#toast-act").addEventListener("click", () => {
    const fn = toastAction;
    $("#toast").hidden = true;
    toastAction = null;
    if (fn) fn();
  });

  // nav
  $("#sign-out").addEventListener("click", signOut);
  $("#entry-close").addEventListener("click", () => {
    const back = entry.returnTo || "screen-home";
    resetEntry();
    showStep("step-amount");
    goScreen(back);
  });
  $$(".tab[data-tab]").forEach((t) => t.addEventListener("click", () => navTab(t.dataset.tab)));
  $("#tab-add").addEventListener("click", () => navTab("add"));
  $("#q-add").addEventListener("click", startAdd);
  $("#q-in").addEventListener("click", startIncome);
  $("#q-salary").addEventListener("click", startSalary);
  $("#q-bills").addEventListener("click", openBills);
  $("#home-bell").addEventListener("click", openBills);
  $("#home-avatar").addEventListener("click", () => openBudgetSettings());
  $("#home-see-budgets").addEventListener("click", () => openHistory(null, homePeriod()));
  $("#home-see-bills").addEventListener("click", openBills);
  $("#home-see-all").addEventListener("click", () => openHistory(null, homePeriod()));
  $("#bills-edit").addEventListener("click", () => openBudgetSettings());
  $("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") $("#sheet").hidden = true; });
  $("#month-prev").addEventListener("click", () => changeMonth(-1));
  $("#month-next").addEventListener("click", () => changeMonth(1));
  $("#go-budget").addEventListener("click", () => openBudgetSettings());
  $("#budget-back").addEventListener("click", () => { if (leaveBudgetSettings()) openHome(true); });
  $("#screen-budget").addEventListener("input", () => (budgetDirty = true));
  $("#screen-budget .hist-scroll").addEventListener("click", (e) => {
    if (e.target.closest(".er-kind, .hi-act, .add-row")) budgetDirty = true;
  });
  $("#bs-add-bill").addEventListener("click", () => addBillRow({}));
  $("#bs-add-salary").addEventListener("click", () => addSalaryRow({ date: toDateInput(new Date()) }, true));
  $("#bs-save-btn").addEventListener("click", saveBudgetSettings);
  ["#bs-need", "#bs-want", "#bs-save"].forEach((id) => $(id).addEventListener("input", updateSplitHint));

  // stats filters
  $("#nw-need-item").addEventListener("click", () => setFilter("kind", "need"));
  $("#nw-want-item").addEventListener("click", () => setFilter("kind", "want"));
  $("#nw-save-item").addEventListener("click", () => setFilter("kind", "saving"));
  $("#stat-clear").addEventListener("click", () => setFilter(statsFilter.type, statsFilter.value));
  $("#reimb-pending").addEventListener("click", () => setFilter("pending", true));
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
