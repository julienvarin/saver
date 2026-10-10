"use strict";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */
// Edit this list to change your categories.
const CATEGORIES = [
  "Eat out", "Groceries", "Transport", "Shopping",
  "Bills", "Health", "Fun", "Travel", "Other",
];

const LS = {
  url: "saver.sb_url",
  key: "saver.sb_key",
  cats: "saver.custom_cats",
  billsOpen: "saver.bills_open",
  reimbFull: "saver.reimb_full",
};

// Custom categories you've used before. Learned from your saved expenses
// (so they sync across devices) and cached locally for an instant render.
let savedCats = loadCachedCats();

function loadCachedCats() {
  try {
    const v = JSON.parse(localStorage.getItem(LS.cats) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];
  } catch (e) { return []; }
}

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
  fromStats: false, // started from the Stats screen: go back there once saved
};

function resetEntry() {
  entry.amount = 0;
  entry.title = "";
  entry.categories = [];
  entry.kind = null;
  entry.reimbursable = false;
  entry.reimbursed = false;
  entry.reimbAmount = "";
  entry.date = toDateInput(new Date());
  entry.createdAt = null;
  entry.editId = null;
  entry.quick = false;
  entry.prefilled = false;
  entry.catsTouched = false;
  entry.fromStats = false;
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
function toggleReceived() { entry.reimbursed = !entry.reimbursed; haptic(); updateFlagsUI(); }

// Details step: title, recent entries, categories, flags, need / want.
// Money in only needs a title, so it gets a plain Save button instead.
function enterDetails() {
  const income = entry.kind === "income";
  $("#det-body").hidden = income;
  $("#det-save").hidden = !income;
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
  const defaults = CATEGORIES.filter((n) => n !== "Other");
  const names = defaults.concat(savedCats, CATEGORIES.indexOf("Other") >= 0 ? ["Other"] : []);
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

// Replace the saved custom categories and redraw the chips, keeping the
// current selection.
function setSavedCats(list) {
  const defaults = CATEGORIES.map((n) => n.toLowerCase());
  const seen = new Set();
  const next = [];
  list.forEach((n) => {
    const k = (n || "").trim().toLowerCase();
    if (!k || defaults.indexOf(k) >= 0 || seen.has(k)) return;
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

// Remember any new custom categories from a just-saved expense.
function rememberCats(cats) {
  setSavedCats(savedCats.concat(cats || []));
}

// Learn custom categories and remembered titles from your expenses, most used first.
async function refreshSavedCats() {
  const { data, error } = await sb
    .from("expenses")
    .select("title, amount, categories, kind, created_at")
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error || !data) return;
  learnTitles(data);
  const count = new Map();
  data.forEach((r) => (r.categories || []).forEach((c) => count.set(c, (count.get(c) || 0) + 1)));
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
    b.appendChild(el("span", "dot " + (k.kind === "income" ? "need" : k.kind)));
    b.appendChild(el("span", "sg-title", k.title));
    if (income) b.appendChild(el("span", "sg-cats", "+" + formatEuro(k.amount)));
    else if (k.categories.length) b.appendChild(el("span", "sg-cats", k.categories.join(" · ")));
    b.addEventListener("click", () => {
      if (!entry.amount) entry.amount = Math.round(k.amount); // money in: same as last time
      entry.title = k.title;
      entry.categories = k.categories.slice();
      entry.kind = k.kind;
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
    categories: entry.categories,
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

  const savedCatsUsed = record.categories.slice();
  const backToStats = editing || entry.fromStats;
  const newId = !editing && data && data[0] ? data[0].id : null;
  rememberTitle(record);
  setTimeout(() => {
    resetEntry();
    rememberCats(savedCatsUsed);
    if (backToStats) {
      showScreen("screen-history");
      loadHistory();
    } else {
      showStep("step-amount");
    }
    if (newId) toast("Saved " + (record.title || formatEuro(record.amount)), false, { label: "Undo", fn: () => undoInsert(newId) });
  }, 650);
}

async function undoInsert(id) {
  const { error } = await sb.from("expenses").delete().eq("id", id);
  if (error) { toast(error.message, true); return; }
  haptic();
  toast("Removed");
  if ($("#screen-history").classList.contains("active")) loadHistory();
}

// Quick salary: the keypad is prefilled with the last salary, Save starts a new month.
async function saveSalary() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { showScreen("screen-auth"); return; }
  const incomes = Object.assign({}, budget.incomes, { [entry.date]: entry.amount });
  const next = {
    user_id: user.id, need_pct: budget.need_pct, want_pct: budget.want_pct, save_pct: budget.save_pct,
    incomes, bills: budget.bills || [], updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from("budgets").upsert(next);
  if (error) { toast(error.message, true); return; }
  budget = Object.assign({}, DEFAULT_BUDGET, next);
  haptic();
  resetEntry();
  toast("Salary saved · new budget month");
  statsPeriod = periodFor(new Date());
  statsFilter = { type: null, value: null };
  showScreen("screen-history");
  loadHistory();
}

async function startSalary() {
  if (!budgetLoaded) await loadBudget();
  if (budgetMissing) { toast("Re-run supabase/schema.sql first", true); return; }
  haptic();
  resetEntry();
  const pays = paydays();
  entry.kind = "salary";
  entry.quick = true;
  entry.fromStats = true;
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
// Extra money in (sub-tenant, refund, side job): adds to the month's income, never spending.
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

async function openHistory() {
  if (entry.editId || entry.fromStats) resetEntry(); // cancel an in-progress edit / prefilled flow
  if (!budgetLoaded) await loadBudget();
  statsPeriod = periodFor(new Date());
  statsFilter = { type: null, value: null };
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
  resetEntry();
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
  applyCategories(r.categories || []);
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

  const { start, end } = statsPeriod;
  let q = sb.from("expenses").select("*").gte("created_at", start.toISOString());
  if (end) q = q.lt("created_at", end.toISOString());
  const { data, error } = await q.order("created_at", { ascending: false });

  if (error) { list.innerHTML = '<div class="hist-empty">Error loading.</div>'; toast(error.message, true); return; }

  statsRows = data || [];
  renderStats(statsRows);
  renderList(statsRows);
  renderBudget(statsRows);
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
          loadHistory();
        } });
        loadHistory();
      });
      sub.appendChild(got);
    }
  }
  const catSpan = document.createElement("span");
  catSpan.className = "cats";
  catSpan.textContent = isIncome(r) ? "Money in" : (r.categories || []).join(" · ") || "—";
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
      loadHistory();
    } });
    loadHistory();
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

async function loadBudget() {
  const { data, error } = await sb.from("budgets").select("*").maybeSingle();
  if (error) {
    budgetMissing = /budgets/.test(error.message || "") || error.code === "42P01" || error.code === "PGRST205";
    console.error(error);
  } else {
    budgetMissing = false;
    budget = Object.assign({}, DEFAULT_BUDGET, data || {});
  }
  budgetLoaded = true;
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
  // save shows where the month ends up; needs / wants what's spent
  const shown = opts.total != null ? opts.total : spent;
  top.appendChild(el("span", "b-amt", euro0(shown) + " / " + euro0(target)));
  b.appendChild(top);
  const past = kind === "save" ? (shown >= target ? "good" : null)
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

  const current = isCurrentPeriod(period);
  const today = daysElapsed(period);                       // day number within the period
  const dim = Math.max(1, daysBetween(period.start, period.estEnd)); // period length (estimated while open)
  const late = current && today > dim;                     // next salary expected but not logged yet
  const todayDate = startOfDay(new Date());

  let needSpent = 0, wantSpent = 0, saved = 0, extra = 0;
  rows.forEach((r) => {
    const a = netAmount(r);
    if (isIncome(r)) extra += Number(r.amount) || 0;
    else if (r.kind === "need") needSpent += a;
    else if (r.kind === "save") saved += a;
    else wantSpent += a; // wants (and anything untagged)
  });

  // the salary is split by the percentages; money in (a sub-tenant's rent…) only
  // goes to needs, since it pays bills back out
  const income = salary + extra;
  const needBudget = salary * budget.need_pct / 100 + extra;
  const wantBudget = salary * budget.want_pct / 100;
  const saveTarget = salary * budget.save_pct / 100;

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

  // Three bars, no prose: solid = spent / saved, hatched = still planned.
  const card = el("div", "bcard");
  $(".nw").hidden = true;
  if (late) card.appendChild(el("div", "b-late", "Payday was expected — log your salary"));

  // wants: spent + subscriptions still to come, with a "today" marker for pace
  card.appendChild(bucket("want", "Wants", wantSpent, wantBudget,
    { reserved: upcomingWant, marker: current ? (today / dim) * 100 : null }));

  // needs: paid so far + bills still planned this month
  card.appendChild(bucket("need", "Needs", needSpent, needBudget, { reserved: upcoming }));

  // save: put aside so far + the buffer you'd still have left at payday if
  // wants end on budget (or wherever they are, if already over)
  const projected = current
    ? income - needSpent - upcoming - Math.max(wantSpent + upcomingWant, wantBudget)
    : income - needSpent - wantSpent;
  card.appendChild(bucket("save", "Save", saved, saveTarget,
    { reserved: Math.max(0, projected - saved), total: projected }));

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
    bills.slice().sort((a, b) => (a.due ? a.due.getTime() : Infinity) - (b.due ? b.due.getTime() : Infinity)).forEach((b) => {
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
      list.appendChild(row);
    });
  }

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
  loadHistory();
}

// Extra money in: opens on the details step, where past sources are one tap
// (same amount as last time). A new one: type the title, Save, then the amount.
function startIncome() {
  haptic();
  resetEntry();
  entry.kind = "income";
  entry.fromStats = true;
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
  if (budgetDirty && !confirm("Discard your budget changes?")) return;
  budgetDirty = false;
  showScreen("screen-history");
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
  if (!budgetLoaded) await loadBudget();
  if (budgetMissing) { toast("Re-run supabase/schema.sql first", true); return; }
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
  showScreen("screen-history");
  loadHistory();
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
  loadBudget();
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
  $("#go-history").addEventListener("click", openHistory);
  $("#hist-back").addEventListener("click", () => showScreen("screen-entry"));
  $("#month-prev").addEventListener("click", () => changeMonth(-1));
  $("#month-next").addEventListener("click", () => changeMonth(1));
  $("#go-budget").addEventListener("click", () => openBudgetSettings());
  $("#budget-back").addEventListener("click", leaveBudgetSettings);
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
