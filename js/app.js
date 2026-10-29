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
  reimbFull: "saver.reimb_full",
  tipsHidden: "saver.tips_hidden",
  alertsSeen: "saver.alerts_seen",
  privacy: "saver.privacy",
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
/*  Privacy: the eye button blurs every amount (except while entering one) */
/* ------------------------------------------------------------------ */
const MONEY_RE = /(?:[-+]\s?)?€\s?[\d,]+(?:\.\d+)?K?/g;

// Wrap the euro amounts in a text node in <span class="money"> so they can be
// blurred; in a chart, the <text> itself gets the class.
function markMoneyText(node) {
  const parent = node.parentNode;
  if (!parent || parent.closest(".money, script, style, #screen-entry")) return;
  const s = node.nodeValue;
  MONEY_RE.lastIndex = 0;
  if (!MONEY_RE.test(s)) return;
  if (parent instanceof SVGElement) { parent.classList.add("money"); return; }
  const frag = document.createDocumentFragment();
  let last = 0;
  s.replace(MONEY_RE, (m, i) => {
    if (i > last) frag.appendChild(document.createTextNode(s.slice(last, i)));
    frag.appendChild(el("span", "money", m));
    last = i + m.length;
  });
  if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
  parent.replaceChild(frag, node);
}

function markMoney(root) {
  if (root.nodeType === Node.TEXT_NODE) { markMoneyText(root); return; }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(markMoneyText);
}

function setPrivacy(on) {
  document.body.classList.toggle("privacy", on);
  const b = $("#home-eye");
  b.setAttribute("aria-pressed", String(on));
  b.setAttribute("aria-label", on ? "Show amounts" : "Hide amounts");
  try { if (on) localStorage.setItem(LS.privacy, "1"); else localStorage.removeItem(LS.privacy); } catch (e) {}
}

function initPrivacy() {
  markMoney(document.body);
  new MutationObserver((list) => list.forEach((m) => {
    if (m.type === "characterData") markMoneyText(m.target);
    else m.addedNodes.forEach(markMoney);
  })).observe(document.body, { childList: true, subtree: true, characterData: true });
  let on = false;
  try { on = !!localStorage.getItem(LS.privacy); } catch (e) {}
  setPrivacy(on);
  $("#home-eye").addEventListener("click", () => { haptic(); setPrivacy(!document.body.classList.contains("privacy")); });
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
  editRow: null, // the row as it was before editing (Delete's undo puts it back)
  quick: false, // prefilled entry (salary): the amount step saves
  prefilled: false, // amount was prefilled: the first key press replaces it
  catsTouched: false, // categories picked by hand: don't overwrite them from a known title
  returnTo: null, // tab screen the entry started from: go back there once saved
  extra: false, // money in: extra (split like the salary) rather than covering bills
  flat: false, // the sub-let flat's: its own balance, outside needs / wants
  inbox: null, // the card payment being confirmed (removed from the inbox once saved)
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
  entry.flat = false;
  entry.date = toDateInput(new Date());
  entry.createdAt = null;
  entry.editId = null;
  entry.editRow = null;
  entry.quick = false;
  entry.prefilled = false;
  entry.catsTouched = false;
  entry.returnTo = null;
  entry.inbox = null;
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

// What the entry is: an expense (need / want / save), money in or a salary.
function entryMode() {
  return entry.kind === "income" ? "income" : entry.kind === "salary" ? "salary" : "expense";
}

// The top bar: the Expense / Money in / Salary switch on a new entry's amount
// step, a title otherwise, and Delete while editing.
function updateProgress(stepId) {
  const what = { expense: "expense", income: "money in", salary: "salary" }[entryMode()];
  let label = "";
  if (stepId !== "step-saved") {
    if (entry.editId) label = "Edit " + what;
    else if (entry.inbox) label = "Card payment";
    else if (stepId === "step-details") label = entry.kind === "income" ? "Money in" : "New expense";
  }
  $("#progress").textContent = label;
  $("#mode").hidden = stepId !== "step-amount" || !!entry.editId || !!entry.inbox;
  $$("#mode button").forEach((b) => {
    const on = b.dataset.mode === entryMode();
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  $("#entry-delete").hidden = !entry.editId || stepId === "step-saved";
}

// Switch a new entry between expense, money in and salary. The salary starts
// from the last one (the first key press replaces it); a typed amount is kept.
async function setMode(mode) {
  if (entry.editId || mode === entryMode()) return;
  if (mode === "salary") {
    if (!budgetLoaded) await loadBudget();
    if (budgetMissing) { toast("Re-run supabase/schema.sql first", true); return; }
  }
  haptic();
  if (entry.prefilled) entry.amount = 0;
  entry.prefilled = false;
  entry.kind = mode === "expense" ? null : mode;
  entry.quick = mode === "salary";
  const pays = paydays();
  if (mode === "salary" && !entry.amount && pays.length) {
    entry.amount = Math.round(pays[pays.length - 1].amount);
    entry.prefilled = true;
  }
  renderAmount();
  updateAmountBtn();
  updateProgress("step-amount");
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
  updateFlatUI();
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
// Money in: "Flat" (the sub-tenant's rent: the flat's balance), "Covers bills"
// (comes off needs) or "Extra" (DJ fee, eBay: split like the salary). Extra is
// stored as the "Extra" category on the row, flat as the flat column.
const EXTRA = "Extra";
function isExtra(r) { return (r.categories || []).includes(EXTRA); }
function incomeKind() { return entry.flat ? "flat" : entry.extra ? "extra" : "bills"; }
function updateIncomeUI() {
  $$("#in-kind .pill").forEach((b) => b.classList.toggle("active", b.dataset.in === incomeKind()));
}
function setIncomeKind(k) { entry.extra = k === "extra"; entry.flat = k === "flat"; haptic(); updateIncomeUI(); }

// An expense for the flat skips Need / Want: one Save puts it on the flat's balance.
function updateFlatUI() {
  const t = $("#flat-toggle");
  if (!t) return;
  const income = entry.kind === "income";
  t.classList.toggle("active", entry.flat);
  $$("#det-body .kind-grid, #det-body .kind-row").forEach((n) => (n.hidden = entry.flat && !income));
  $("#det-save").hidden = !income && !entry.flat;
  $("#det-save").textContent = !income && entry.flat ? "Save to flat" : "Save";
}
function toggleFlat() { entry.flat = !entry.flat; haptic(); updateFlatUI(); }
function toggleReceived() { entry.reimbursed = !entry.reimbursed; haptic(); updateFlagsUI(); }

// Details step: title, recent entries, categories, flags, need / want.
// Money in only needs a title, so it gets a plain Save button instead.
function enterDetails() {
  const income = entry.kind === "income";
  $("#det-body").hidden = income;
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
  const query = (cols) => sb.from("expenses").select(cols).order("created_at", { ascending: false }).limit(2000);
  let { data, error } = await query("title, amount, categories, kind, created_at, merchant, flat");
  if (error) ({ data, error } = await query("title, amount, categories, kind, created_at, merchant"));
  if (error) ({ data, error } = await query("title, amount, categories, kind, created_at")); // old schema
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
let byMerchant = new Map(); // merchantKey(merchant) -> what a card payment there was last logged as

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
    else next.set(key, { key, title: r.title.trim(), amount: Number(r.amount) || 0, categories: r.categories || [], kind: r.kind, flat: !!r.flat, count: 1 });
  });
  known = next;
  byMerchant = new Map();
  rows.slice().reverse().forEach(rememberMerchant); // oldest first: the latest use wins
}

// Put a just-saved entry at the front of the remembered titles.
function rememberTitle(rec) {
  const key = norm(rec.title);
  if (!key || !rec.kind) return;
  const old = known.get(key);
  known.delete(key);
  known = new Map([[key, { key, title: rec.title.trim(), amount: Number(rec.amount) || 0, categories: rec.categories || [], kind: rec.kind, flat: !!rec.flat, count: (old ? old.count : 0) + 1 }]].concat(Array.from(known)));
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
    b.appendChild(el("span", "dot " + (k.flat ? "flat" : k.kind !== "income" ? k.kind : isExtra(k) ? "save" : "need")));
    b.appendChild(el("span", "sg-title", k.title));
    if (income) b.appendChild(el("span", "sg-cats", "+" + formatEuro(k.amount)));
    else if (k.categories.length) b.appendChild(el("span", "sg-cats", k.categories.join(" · ")));
    b.addEventListener("click", () => {
      if (!entry.amount) entry.amount = Math.round(k.amount); // money in: same as last time
      entry.title = k.title;
      entry.categories = k.categories.slice();
      entry.kind = k.kind;
      entry.flat = k.flat;
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
  if (k && entry.kind === "income" && k.kind === "income") { entry.extra = isExtra(k); entry.flat = k.flat; updateIncomeUI(); }
  if (!k || entry.kind === "income") { updateKindUI(); return; }
  if (k.flat !== entry.flat) { entry.flat = k.flat; updateFlatUI(); }
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
  // only sent when it matters, so saving still works before the flat column exists
  if (entry.flat || (entry.editRow && entry.editRow.flat)) record.flat = entry.flat;

  if (entry.reimbursable) {
    const ra = parseReimbAmount();
    if (ra === undefined) { toast("Invalid reimbursed amount", true); return; }
    record.reimb_amount = ra;
  }

  const editing = !!entry.editId;
  const createdAt = editedCreatedAt();
  if (createdAt) record.created_at = createdAt;
  const card = entry.inbox;
  if (card) {
    record.merchant = card.merchant;
    if (!createdAt) record.created_at = card.created_at; // when you paid, not when you confirmed
  }

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
    const oldSchema = /kind_check|flat/.test(error.message || "");
    toast(oldSchema ? "Re-run supabase/schema.sql in Supabase to enable this" : "Couldn't save: " + error.message, true);
    if (entry.quick) showStep("step-amount"); else enterDetails();
    return;
  }

  const savedCatsUsed = record.kind === "income" ? [] : record.categories.slice();
  const back = entry.returnTo || "screen-home";
  const newId = !editing && data && data[0] ? data[0].id : null;
  rememberTitle(record);
  rememberMerchant(record);
  if (card) await removeFromInbox(card);
  setTimeout(() => {
    resetEntry();
    rememberCats(savedCatsUsed);
    showStep("step-amount");
    goScreen(back);
    if (newId) toast("Saved " + (record.title || formatEuro(record.amount)), false, { label: "Undo", fn: () => undoInsert(newId, card) });
  }, 650);
}

// card: the card payment it came from goes back to the inbox
async function undoInsert(id, card) {
  const { error } = await sb.from("expenses").delete().eq("id", id);
  if (error) { toast(error.message, true); return; }
  if (card) await sb.from("card_inbox").insert(card);
  haptic();
  toast("Removed");
  refresh();
}

// Quick salary: the keypad is prefilled with the last salary, Save starts a new month.
async function saveSalary() {
  if (!(await saveBudget((b) => ({ incomes: Object.assign({}, b.incomes, { [entry.date]: entry.amount }) })))) return;
  haptic();
  const back = entry.returnTo || "screen-home";
  resetEntry();
  toast("Salary saved · new budget month");
  statsPeriod = periodFor(new Date());
  statsFilter = { type: null, value: null };
  goScreen(back);
}

// The entry flow, switched to Salary (from the payday prompts).
function startSalary() {
  startAdd();
  setMode("salary");
}

// Delete the expense being edited; the toast can put it back.
async function deleteEntry() {
  const r = entry.editRow;
  if (!r) return;
  const { error } = await sb.from("expenses").delete().eq("id", r.id);
  if (error) { toast(error.message, true); return; }
  haptic();
  const back = entry.returnTo || "screen-home";
  resetEntry();
  showStep("step-amount");
  goScreen(back);
  toast("Deleted " + (r.title || formatEuro(r.amount)), false, { label: "Undo", fn: async () => {
    const { error: e2 } = await sb.from("expenses").insert(Object.assign({}, r));
    if (e2) { toast(e2.message, true); return; }
    refresh();
  } });
}

/* ------------------------------------------------------------------ */
/*  Periods, amounts, entries                                          */
/* ------------------------------------------------------------------ */
// Money put aside goes to the savings bucket.
function isSaving(r) { return r.kind === "save"; }
// Money in (sub-tenant, side job…): covers bills (comes off needs) or extra (split like the salary).
function isIncome(r) { return r.kind === "income"; }
// The sub-let flat's bills and rent: kept on the flat's own balance, never in the budget.
function isFlat(r) { return !!r.flat; }

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
// guesses a month later). Before the first payday, plain calendar months; the
// days just before it that already fall in its month join the month before
// (no 2-day "month" of its own).
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
  let start = new Date(date.getFullYear(), date.getMonth(), 1);
  let end = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  if (pays.length) {
    const first = parseDay(pays[0].date);
    const named = nearestMonth(first); // the month the first salary starts
    if (date >= named) start = new Date(named.getFullYear(), named.getMonth() - 1, 1);
    if (end >= named) end = first;
  }
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

// The 1st of the month closest to a day: 26 Sep → 1 Oct, 3 Oct → 1 Oct.
function nearestMonth(d) {
  const a = new Date(d.getFullYear(), d.getMonth(), 1);
  const b = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return d - a <= b - d ? a : b;
}

// "October": a payday period is named after the month closest to payday (a
// salary on 26 Sep starts the October budget); a calendar one after its month.
function periodMonth(p, short) {
  const m = p.pay ? nearestMonth(p.start) : p.start;
  const opts = { month: short ? "short" : "long" };
  if (!short && m.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return m.toLocaleDateString(undefined, opts);
}

// What the ⓘ next to a month name says: how budget months work, with this one's dates.
function openMonthInfo(p) {
  haptic();
  const body = el("div", "info-body");
  const para = (t) => body.appendChild(el("p", "", t));
  para(p.pay ? "Your " + periodMonth(p) + " budget runs " + periodLabel(p) + "." : periodMonth(p) + " runs " + periodLabel(p) + ".");
  para("A budget month starts on payday and is named after the closest month: a salary on 26 September starts your October budget, and everything you spend from then on counts toward October.");
  para("The trade-off: those last days of September show up in October, not September. Before your first salary, months follow the calendar, and the few days just before it count in the month before.");
  openSheet("How budget months work", [body]);
}

function infoBtn(p, cls) {
  const b = el("button", "info-btn" + (cls ? " " + cls : ""));
  b.type = "button";
  b.setAttribute("aria-label", "How budget months work");
  b.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 11v6M12 7.5v.01"/></svg>';
  b.addEventListener("click", (e) => { e.stopPropagation(); openMonthInfo(p); });
  return b;
}

function dayLabel(d) {
  const now = new Date();
  const isSame = (a, b) => a.toDateString() === b.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (isSame(d, now)) return "Today";
  if (isSame(d, yest)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
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
// Settings can switch to counting reimbursable expenses in full.
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
  entry.editRow = r;
  entry.amount = Math.round(Number(r.amount) || 0);
  entry.title = r.title || "";
  entry.kind = r.kind || null;
  entry.reimbursable = !!r.reimbursable;
  entry.reimbursed = !!r.reimbursed;
  entry.reimbAmount = isPartialReimb(r) ? String(Number(r.reimb_amount)) : "";
  entry.createdAt = r.created_at;
  entry.date = toDateInput(new Date(r.created_at));
  entry.catsTouched = true;
  entry.flat = !!r.flat;
  if (isIncome(r)) entry.extra = isExtra(r);
  else applyCategories(r.categories || []);
  renderAmount();
  $("#title-input").value = entry.title;
  syncMiniAmount();
  showScreen("screen-entry");
  showStep("step-amount");
}

// Every entry of a period (or any { start, end } span), newest first.
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
  if (id === "screen-history" && statsPeriod) { showScreen(id); loadHistory(true); }
  else if (id === "screen-history") openHistory();
  else if (id === "screen-bills") openBills();
  else if (id === "screen-budget") openBudgetSettings();
  else openHome();
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

// One entry: tap it to edit (and delete from there).
function renderItem(r) {
  const row = el("button", "hist-item");
  row.type = "button";
  row.appendChild(el("span", "hi-kind " + (r.kind || "") + (isFlat(r) ? " flat" : "")));

  const main = el("div", "hi-main");
  main.appendChild(el("div", "hi-title", r.title || "Untitled"));
  const sub = el("div", "hi-sub");
  if (r.reimbursable) {
    const part = isPartialReimb(r) ? " " + formatEuro(reimbAmount(r)) : "";
    if (r.reimbursed) sub.appendChild(makeBadge("↩︎" + part + " back", "reimb-done"));
    else {
      // tap the badge once the money is back
      const got = el("span", "badge reimb-pending", "↩︎" + part + " owed · got it?");
      got.setAttribute("role", "button");
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
  if (isFlat(r)) sub.appendChild(makeBadge("🏠 Flat", "flat"));
  sub.appendChild(el("span", "cats", isIncome(r) ? (isFlat(r) ? "Money in" : isExtra(r) ? "Money in · Extra" : "Money in · Covers bills") : (r.categories || []).join(" · ") || "—"));
  main.appendChild(sub);
  row.appendChild(main);
  row.addEventListener("click", () => openEdit(r));

  if (isIncome(r)) {
    row.appendChild(el("div", "hi-amount income", "+" + formatEuro(r.amount)));
    return row;
  }
  // fully reimbursed: struck-through paid amount; partial: what's left on you
  const fullReimb = r.reimbursable && netAmount(r) === 0;
  row.appendChild(el("div", "hi-amount" + (fullReimb ? " reimb" : ""),
    formatEuro(r.reimbursable && !fullReimb ? netAmount(r) : paidAmount(r))));
  return row;
}

/* ------------------------------------------------------------------ */
/*  Insights                                                           */
/* ------------------------------------------------------------------ */
let statsPeriod = null;                        // shown period, see periodFor()
let statsRows = [];                            // its rows
let statsHistory = [];                         // [{ period, rows }]: the shown period, then the 5 before it
let statsFilter = { type: null, value: null }; // transactions filter: kind | category | pending | income
let catKind = "want";                          // categories card: wants or needs

const KIND_FILTER = { need: "need", want: "want", save: "saving" };
const KIND_LABEL = { need: "Needs", want: "Wants", saving: "Saved" };

function matchesFilter(r) {
  if (!statsFilter.type) return true;
  if (statsFilter.type === "flat") return isFlat(r);
  if (statsFilter.type === "pending") return pendingReimb(r) > 0;
  if (isFlat(r)) return false;
  if (statsFilter.type === "kind") return statsFilter.value === "saving" ? isSaving(r) : r.kind === statsFilter.value;
  if (statsFilter.type === "category") return !isIncome(r) && (r.categories || []).includes(statsFilter.value);
  if (statsFilter.type === "income") return isIncome(r);
  return true;
}

// Toggle a transactions filter (tapping the active one clears it). From a
// card higher up, scroll down to the list it filters.
function setFilter(type, value, scroll) {
  const same = statsFilter.type === type && statsFilter.value === value;
  statsFilter = same || !type ? { type: null, value: null } : { type, value };
  haptic();
  renderInsights();
  if (scroll && !same) $("#tx-anchor").scrollIntoView({ behavior: "smooth", block: "start" });
}

// filter / period: optional, e.g. from Home (a budget opens its transactions).
// toTx: scroll straight to the transactions.
async function openHistory(filter, period, toTx) {
  await loadBudget();
  statsPeriod = period || periodFor(new Date());
  statsFilter = filter || { type: null, value: null };
  showScreen("screen-history");
  await loadHistory();
  if (toTx) $("#tx-anchor").scrollIntoView({ block: "start" });
}

function changeMonth(delta) {
  if (delta > 0 && isCurrentPeriod(statsPeriod)) return; // don't go past the current period
  statsPeriod = periodFor(delta > 0 ? statsPeriod.end : addDays(statsPeriod.start, -1));
  statsFilter = { type: null, value: null };
  haptic();
  loadHistory();
}

// keepScroll: reloading in place (after an edit), not a new month.
async function loadHistory(keepScroll) {
  const period = statsPeriod;
  $("#month-label").textContent = periodMonth(period);
  $("#month-sub").textContent = period.pay || period.end.getDate() !== 1 ? periodLabel(period) : "";
  const info = $("#month-info");
  info.replaceWith(Object.assign(infoBtn(period), { id: "month-info" }));
  $("#month-next").disabled = isCurrentPeriod(period);
  if (!keepScroll) $("#hist-scroll").scrollTop = 0;
  if (!statsRows.length) $("#hist-list").innerHTML = '<div class="hist-empty">Loading…</div>';

  // the shown period and the five before it, in one query
  const periods = [period];
  for (let i = 0; i < 5; i++) periods.push(periodFor(addDays(periods[i].start, -1)));
  const { data, error } = await fetchRows({ start: periods[5].start, end: period.end });
  if (period !== statsPeriod) return; // another month was picked meanwhile
  if (error) { $("#hist-list").innerHTML = '<div class="hist-empty">Couldn\'t load this month.</div>'; toast(error.message, true); return; }

  statsHistory = periods.map((p) => ({ period: p, rows: data.filter((r) => {
    const d = new Date(r.created_at);
    return d >= p.start && (!p.end || d < p.end);
  }) }));
  statsRows = statsHistory[0].rows;
  renderInsights();
}

function renderInsights() {
  const f = budgetFigures(statsRows, statsPeriod);
  renderInsSummary(f);
  renderPace(f);
  renderSplit(f);
  renderInsFlat(f);
  renderCats();
  renderTrend();
  renderTxFilters();
  renderList(statsRows);
}

// A small labelled figure; with fn it's a button.
function statTile(cls, label, value, valCls, fn) {
  const t = el(fn ? "button" : "div", cls);
  if (fn) { t.type = "button"; t.addEventListener("click", fn); }
  t.appendChild(el("div", "ht-label", label));
  t.appendChild(el("div", "ht-val" + (valCls ? " " + valCls : ""), value));
  return t;
}

// Spent so far against the same number of days last period: [text, class].
function compareValue(rows, prevRows, prev, f) {
  if (!prevRows || !prevRows.length) return ["—", ""];
  const until = f.current ? addDays(prev.start, f.today) : null;
  const diff = spendOf(rows) - spendOf(prevRows, until);
  if (Math.abs(diff) < 1) return ["Same", ""];
  return [(diff < 0 ? "↓ " : "↑ ") + euro0(Math.abs(diff)), diff < 0 ? "good" : "bad"];
}

function insCard(title, sub) {
  const card = el("div", "bcard ins-card");
  if (title) {
    const head = el("div", "ins-head");
    head.appendChild(el("div", "ins-title", title));
    if (sub) head.appendChild(el("div", "ins-desc", sub));
    card.appendChild(head);
  }
  return card;
}

// Headline: what you spent (your share of needs + wants), per day, and how it compares.
function renderInsSummary(f) {
  const wrap = $("#ins-summary");
  wrap.innerHTML = "";
  const period = statsPeriod;
  const spent = f.needMine + f.wantSpent;
  const card = insCard();
  card.classList.add("ins-sum");
  card.appendChild(el("div", "ins-label", f.current ? "Spent so far" : "Spent"));
  const big = el("div", "ins-big");
  big.appendChild(bigEuro(spent));
  card.appendChild(big);
  let sub = euro0(spent / daysElapsed(period)) + " a day";
  let subCls = "";
  if (f.current) sub += " · day " + Math.min(f.today, f.dim) + " of " + f.dim;
  else if (f.salary != null) {
    const left = f.needBudget + f.wantBudget - spent;
    sub += " · " + (left >= 0 ? euro0(left) + " under budget" : euro0(-left) + " over budget");
    subCls = left >= 0 ? " good" : " bad";
  }
  card.appendChild(el("div", "ins-sub" + subCls, sub));

  const prev = statsHistory[1];
  const [cmp, cmpCls] = compareValue(statsRows, prev.rows, prev.period, f);
  const tiles = el("div", "ins-tiles");
  tiles.appendChild(statTile("ins-tile", "vs. last month", cmp, cmpCls));
  const income = (f.salary || 0) + f.extra;
  tiles.appendChild(statTile("ins-tile", "Money in", euro0(income), "",
    f.extra ? () => setFilter("income", true, true) : null));
  tiles.appendChild(statTile("ins-tile", "Saved", euro0(f.saved), f.salary != null && f.saved >= f.saveTarget && f.saved > 0 ? "good" : "",
    f.saved ? () => setFilter("kind", "saving", true) : null));
  card.appendChild(tiles);
  wrap.appendChild(card);
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs, text) {
  const e = document.createElementNS(SVG_NS, tag);
  Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
  if (text != null) e.textContent = text;
  return e;
}

// A round axis maximum whose half is round too: 1, 2, 3, 4, 6 or 8 × a power of ten.
function niceMax(v) {
  if (v <= 0) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 2, 3, 4, 6, 8, 10].map((m) => m * p).find((m) => m >= v);
}

function compactEuro(n) {
  return n >= 1000 ? "€" + (Math.round(n / 100) / 10) + "K" : "€" + Math.round(n);
}

// Spending pace: cumulative needs + wants by day, against last month and the budget.
function renderPace(f) {
  const wrap = $("#ins-pace");
  wrap.innerHTML = "";
  const period = statsPeriod;
  const prev = statsHistory[1];
  const days = Math.max(1, daysBetween(period.start, period.estEnd));
  const shown = f.current ? Math.min(f.today, days) : days;
  const cumul = (rows, start, n) => {
    const out = [];
    for (let i = 1; i <= n; i++) out.push(spendOf(rows, addDays(start, i)));
    return out;
  };
  const cur = cumul(statsRows, period.start, shown);
  const prevDays = Math.min(days, Math.max(1, daysBetween(prev.period.start, prev.period.end)));
  const old = prev.rows.length ? cumul(prev.rows, prev.period.start, prevDays) : null;
  if (!cur[cur.length - 1] && !old) return;

  const line = f.salary != null ? f.needBudget + f.wantBudget : null;
  const yMax = niceMax(Math.max(cur[cur.length - 1], old ? Math.max.apply(null, old) : 0, line || 0) * 1.05);

  const card = insCard("Spending pace", "Needs + wants, day by day");
  const legend = el("div", "legend");
  const key = (cls, label) => { const k = el("span", "lg-item"); k.appendChild(el("span", "lg-line " + cls)); k.appendChild(document.createTextNode(label)); legend.appendChild(k); };
  key("cur", "This month");
  if (old) key("old", "Last month");
  if (line) key("budget", "Budget");
  card.appendChild(legend);

  const W = 340, H = 168, L = 40, R = 10, T = 10, B = 24;
  const pw = W - L - R, ph = H - T - B;
  const x = (i) => L + (days > 1 ? (i / (days - 1)) * pw : pw / 2);
  const y = (v) => T + ph - (v / yMax) * ph;
  const svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "chart", role: "img",
    "aria-label": "Spent " + euro0(cur[cur.length - 1]) + " by day " + shown + (old ? ", last month " + euro0(old[Math.min(shown, old.length) - 1]) + " by the same day" : "") });
  [0, yMax / 2, yMax].forEach((v) => {
    svg.appendChild(svgEl("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid" }));
    svg.appendChild(svgEl("text", { x: L - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, compactEuro(v)));
  });
  const fmt = (d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  svg.appendChild(svgEl("text", { x: L, y: H - 6, class: "tick" }, fmt(period.start)));
  svg.appendChild(svgEl("text", { x: W - R, y: H - 6, class: "tick", "text-anchor": "end" }, fmt(addDays(period.start, days - 1))));
  if (line) svg.appendChild(svgEl("line", { x1: L, x2: W - R, y1: y(line), y2: y(line), class: "ref" }));
  const path = (vals) => vals.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
  if (old) svg.appendChild(svgEl("path", { d: path(old), class: "ln old" }));
  svg.appendChild(svgEl("path", { d: path(cur) + " L" + x(cur.length - 1).toFixed(1) + " " + y(0) + " L" + x(0) + " " + y(0) + " Z", class: "area" }));
  svg.appendChild(svgEl("path", { d: path(cur), class: "ln cur" }));
  const end = cur.length - 1;
  svg.appendChild(svgEl("circle", { cx: x(end), cy: y(cur[end]), r: 4.5, class: "end-dot" }));

  // hover / drag: a crosshair and the values of that day
  const cross = svgEl("line", { y1: T, y2: T + ph, class: "cross", visibility: "hidden" });
  const dotCur = svgEl("circle", { r: 4.5, class: "end-dot", visibility: "hidden" });
  const dotOld = svgEl("circle", { r: 4.5, class: "old-dot", visibility: "hidden" });
  svg.appendChild(cross); svg.appendChild(dotOld); svg.appendChild(dotCur);
  const hit = svgEl("rect", { x: L, y: T, width: pw, height: ph, class: "hit" });
  svg.appendChild(hit);
  const box = el("div", "chart-box");
  box.appendChild(svg);
  const tip = el("div", "chart-tip");
  tip.hidden = true;
  box.appendChild(tip);
  const show = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(days - 1, Math.round(((px - L) / pw) * (days - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    const place = (dot, v) => { if (v == null) { dot.setAttribute("visibility", "hidden"); return; } dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(v)); dot.setAttribute("visibility", "visible"); };
    place(dotCur, cur[i]);
    place(dotOld, old ? old[i] : null);
    tip.innerHTML = "";
    tip.appendChild(el("div", "tt-head", fmt(addDays(period.start, i))));
    const tline = (cls, label, v) => { const l = el("div", "tt-row"); l.appendChild(el("span", "lg-line " + cls)); l.appendChild(el("span", "", label)); l.appendChild(el("b", "", euro0(v))); tip.appendChild(l); };
    if (cur[i] != null) tline("cur", "This month", cur[i]);
    if (old && old[i] != null) tline("old", "Last month", old[i]);
    tip.hidden = false;
    const left = (x(i) / W) * r.width;
    tip.style.left = Math.max(0, Math.min(r.width - tip.offsetWidth, left - tip.offsetWidth / 2)) + "px";
  };
  const hide = () => { tip.hidden = true; [cross, dotCur, dotOld].forEach((n) => n.setAttribute("visibility", "hidden")); };
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerdown", show);
  hit.addEventListener("pointerleave", hide);
  card.appendChild(box);

  // the one sentence the chart is about
  const i = cur.length - 1;
  if (old && old[Math.min(i, old.length - 1)] != null) {
    const diff = cur[i] - old[Math.min(i, old.length - 1)];
    card.appendChild(el("div", "ins-note", Math.abs(diff) < 1 ? "Same as last month by this day."
      : euro0(Math.abs(diff)) + (diff < 0 ? " less" : " more") + " than last month by " + (f.current ? "this day" : "the end") + "."));
  }
  wrap.appendChild(card);
}

// Where it went: needs / wants / saved, as a share of income against the plan.
function renderSplit(f) {
  const wrap = $("#ins-split");
  wrap.innerHTML = "";
  const parts = [["need", "Needs", f.needMine, budget.need_pct], ["want", "Wants", f.wantSpent, budget.want_pct], ["save", "Saved", f.saved, budget.save_pct]];
  const total = parts.reduce((s, p) => s + p[2], 0);
  if (!total) return;
  const base = f.salary != null ? f.salary + f.bonus : null;
  const card = insCard("Where it went", base ? "Share of your income, against your plan" : "Share of what went out");
  const stack = el("div", "stack-bar");
  parts.forEach(([k, , v]) => {
    if (v <= 0) return;
    const seg = el("div", "stack-seg " + k);
    seg.style.flexGrow = String(v);
    stack.appendChild(seg);
  });
  card.appendChild(stack);
  parts.forEach(([k, label, v, plan]) => {
    const filter = KIND_FILTER[k];
    const kindOn = statsFilter.type === "kind";
    const row = el("button", "split-row" + (kindOn && statsFilter.value === filter ? " active" : kindOn ? " dim" : ""));
    row.type = "button";
    row.addEventListener("click", () => setFilter("kind", filter, true));
    const name = el("span", "split-name");
    name.appendChild(el("span", "dot " + k));
    name.appendChild(document.createTextNode(label));
    row.appendChild(name);
    const pct = Math.round((v / (base || total)) * 100);
    let note = pct + "%";
    let cls = "";
    if (base) {
      note += " · plan " + Math.round(plan) + "%";
      cls = k === "save" ? (pct >= plan ? "good" : "") : (pct > plan ? "bad" : "");
    }
    row.appendChild(el("span", "split-pct " + cls, note));
    row.appendChild(el("b", "split-amt", euro0(v)));
    card.appendChild(row);
  });
  wrap.appendChild(card);
}

// The flat this month: what came in and went out, outside the budget.
function renderInsFlat(f) {
  const wrap = $("#ins-flat");
  wrap.innerHTML = "";
  if (!f.flatIn && !f.flatOut) return;
  const card = insCard("Flat", "Kept out of your budget");
  const net = f.flatIn - f.flatOut;
  const on = statsFilter.type === "flat";
  [["need", "Money in", "+" + euro0(f.flatIn)], ["want", "Bills paid", euro0(f.flatOut)]].forEach(([k, label, v]) => {
    const row = el("button", "split-row" + (on ? " active" : ""));
    row.type = "button";
    row.addEventListener("click", () => setFilter("flat", true, true));
    const name = el("span", "split-name");
    name.appendChild(el("span", "dot " + k));
    name.appendChild(document.createTextNode(label));
    row.appendChild(name);
    row.appendChild(el("span", "split-pct"));
    row.appendChild(el("b", "split-amt", v));
    card.appendChild(row);
  });
  card.appendChild(el("div", "ins-note", Math.abs(net) < 1 ? "Even this month."
    : net < 0 ? euro0(-net) + " more went out than came in this month."
    : euro0(net) + " more came in than went out this month."));
  wrap.appendChild(card);
}

// By category, wants or needs, with the change since last month.
function renderCats() {
  const wrap = $("#ins-cats");
  wrap.innerHTML = "";
  const sum = (rows) => {
    const by = {};
    rows.forEach((r) => {
      if (r.kind !== catKind || isFlat(r)) return;
      const a = netAmount(r);
      if (a <= 0) return;
      ((r.categories && r.categories.length) ? r.categories : ["Uncategorised"]).forEach((c) => { by[c] = (by[c] || 0) + a; });
    });
    return by;
  };
  const now = sum(statsRows);
  const before = sum(statsHistory[1].rows);
  const card = insCard("By category");
  const seg = el("div", "seg small");
  [["want", "Wants"], ["need", "Needs"]].forEach(([k, label]) => {
    const b = el("button", k === catKind ? "active" : "", label);
    b.type = "button";
    b.addEventListener("click", () => { if (catKind === k) return; catKind = k; haptic(); renderCats(); });
    seg.appendChild(b);
  });
  card.querySelector(".ins-head").appendChild(seg);
  const cats = Object.keys(now).sort((a, b) => now[b] - now[a]);
  if (!cats.length) {
    card.appendChild(el("div", "ins-empty", "No " + (catKind === "want" ? "wants" : "needs") + " logged this month."));
    wrap.appendChild(card);
    return;
  }
  const max = now[cats[0]];
  const catOn = statsFilter.type === "category";
  cats.forEach((c) => {
    const row = el("button", "cat-row" + (catOn && statsFilter.value === c ? " active" : catOn ? " dim" : ""));
    row.type = "button";
    row.addEventListener("click", () => setFilter("category", c, true));
    const top = el("div", "cat-row-top");
    top.appendChild(el("span", "cat-name", c));
    const diff = now[c] - (before[c] || 0);
    if (!before[c]) top.appendChild(el("span", "cat-delta", "new"));
    else if (Math.abs(diff) >= 1) top.appendChild(el("span", "cat-delta " + (diff > 0 ? "bad" : "good"), (diff > 0 ? "↑ " : "↓ ") + euro0(Math.abs(diff))));
    top.appendChild(el("b", "", euro0(now[c])));
    row.appendChild(top);
    const track = el("div", "cat-track");
    const fill = el("div", "cat-fill " + catKind);
    fill.style.width = (now[c] / max) * 100 + "%";
    track.appendChild(fill);
    row.appendChild(track);
    card.appendChild(row);
  });
  card.appendChild(el("div", "ins-note", "Arrows compare with last month."));
  wrap.appendChild(card);
}

// The last six months, side by side. Tap one to open it.
function renderTrend() {
  const wrap = $("#ins-trend");
  wrap.innerHTML = "";
  const list = statsHistory.slice().reverse(); // oldest first
  const vals = list.map((h) => spendOf(h.rows));
  if (vals.filter((v) => v > 0).length < 2) return;
  const card = insCard("Last 6 months", "Needs + wants spent each month");
  const W = 340, H = 150, T = 22, B = 24;
  const slot = W / list.length;
  const bw = Math.min(24, slot * 0.5);
  const yMax = Math.max.apply(null, vals) || 1;
  const svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "chart", role: "img",
    "aria-label": list.map((h, i) => periodMonth(h.period, true) + " " + euro0(vals[i])).join(", ") });
  svg.appendChild(svgEl("line", { x1: 0, x2: W, y1: H - B, y2: H - B, class: "grid" }));
  list.forEach((h, i) => {
    const cx = slot * i + slot / 2;
    const bh = Math.max(vals[i] > 0 ? 4 : 0, (vals[i] / yMax) * (H - T - B));
    const x0 = cx - bw / 2, y0 = H - B - bh, rr = Math.min(4, bh);
    const selected = i === list.length - 1;
    const g = svgEl("g", { class: "col" + (selected ? " sel" : ""), tabindex: "0", role: "button" });
    g.appendChild(svgEl("title", {}, periodMonth(h.period) + ": " + euro0(vals[i])));
    g.appendChild(svgEl("rect", { x: cx - slot / 2, y: 0, width: slot, height: H, class: "hit" }));
    if (bh > 0) g.appendChild(svgEl("path", { class: "bar",
      d: "M" + x0 + " " + (H - B) + " V" + (y0 + rr) + " Q" + x0 + " " + y0 + " " + (x0 + rr) + " " + y0 +
        " H" + (x0 + bw - rr) + " Q" + (x0 + bw) + " " + y0 + " " + (x0 + bw) + " " + (y0 + rr) + " V" + (H - B) + " Z" }));
    if (selected || vals[i] === yMax) g.appendChild(svgEl("text", { x: cx, y: y0 - 6, class: "val", "text-anchor": "middle" }, compactEuro(vals[i])));
    g.appendChild(svgEl("text", { x: cx, y: H - 7, class: "tick" + (selected ? " strong" : ""), "text-anchor": "middle" }, periodMonth(h.period, true)));
    const go = () => {
      if (selected) return;
      statsPeriod = h.period;
      statsFilter = { type: null, value: null };
      haptic();
      loadHistory();
    };
    g.addEventListener("click", go);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    svg.appendChild(g);
  });
  card.appendChild(svg);
  wrap.appendChild(card);
}

// Filter chips above the transactions, and their count and total.
function renderTxFilters() {
  const wrap = $("#tx-filters");
  wrap.innerHTML = "";
  const chip = (label, type, value, cls) => {
    const on = type ? statsFilter.type === type && statsFilter.value === value : !statsFilter.type;
    const b = el("button", "fchip" + (on ? " active" : "") + (cls ? " " + cls : ""), label);
    b.type = "button";
    b.addEventListener("click", () => setFilter(on ? null : type, value));
    wrap.appendChild(b);
  };
  chip("All", null, null);
  if (statsFilter.type === "category") chip(statsFilter.value + "  ✕", "category", statsFilter.value);
  chip("Needs", "kind", "need");
  chip("Wants", "kind", "want");
  chip("Saved", "kind", "saving");
  if (statsRows.some((r) => isIncome(r) && !isFlat(r))) chip("Money in", "income", true);
  if (statsRows.some(isFlat)) chip("Flat", "flat", true, "flat");
  const owed = statsRows.reduce((s, r) => s + pendingReimb(r), 0);
  if (owed > 0) chip("Owed to you · " + euro0(owed), "pending", true, "owed");

  const shown = statsRows.filter(matchesFilter);
  const total = shown.reduce((s, r) => s + (statsFilter.type === "pending" ? pendingReimb(r)
    : statsFilter.type === "flat" ? (isIncome(r) ? Number(r.amount) || 0 : -netAmount(r))
    : isIncome(r) ? (statsFilter.type === "income" ? Number(r.amount) || 0 : 0) : netAmount(r)), 0);
  const sumText = statsFilter.type === "flat" ? (total >= 0 ? "+" : "") + euro0(total) : euro0(total);
  $("#tx-sum").textContent = !shown.length ? "" : statsFilter.type ? shown.length + " · " + sumText
    : shown.length + " entr" + (shown.length > 1 ? "ies" : "y");
}

function renderList(rows) {
  const list = $("#hist-list");
  list.innerHTML = "";
  const shown = rows.filter(matchesFilter);
  if (!shown.length) {
    list.appendChild(el("div", "hist-empty card", statsFilter.type ? "Nothing matches this filter." : "Nothing logged this month."));
    return;
  }
  let lastDay = null;
  shown.forEach((r) => {
    const d = new Date(r.created_at);
    const key = d.toDateString();
    if (key !== lastDay) {
      lastDay = key;
      list.appendChild(el("div", "hist-day", dayLabel(d)));
    }
    list.appendChild(renderItem(r));
  });
}

/* ------------------------------------------------------------------ */
/*  Budget: salary + money in, need / want / savings split, bills      */
/* ------------------------------------------------------------------ */
const DEFAULT_BUDGET = { need_pct: 50, want_pct: 30, save_pct: 20, incomes: {}, bills: [] };
let budget = Object.assign({}, DEFAULT_BUDGET);
let budgetLoaded = false;
let budgetMissing = false; // the budgets table isn't created yet (old schema)
let reimbFull = (() => { try { return !!localStorage.getItem(LS.reimbFull); } catch (e) { return false; } })();

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

// Write the budget row: what's stored now (read fresh, so another device's
// changes survive) with `changes` on top.
// `changes` can be a function of the fresh budget.
async function saveBudget(changes) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { showScreen("screen-auth"); return false; }
  if (!(await loadBudget())) { toast("Couldn't load your budget — try again", true); return false; }
  if (typeof changes === "function") changes = changes(budget);
  const next = Object.assign({
    user_id: user.id, need_pct: budget.need_pct, want_pct: budget.want_pct, save_pct: budget.save_pct,
    incomes: budget.incomes || {}, bills: budget.bills || [],
  }, changes, { updated_at: new Date().toISOString() });
  const { error } = await sb.from("budgets").upsert(next);
  if (error) { toast(error.message, true); return false; }
  budget = Object.assign({}, DEFAULT_BUDGET, next);
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

// Everything the budget views need for a period: spent per bucket, the lines
// and the bills. Without a salary the lines are 0 (callers check salary first).
function budgetFigures(rows, period) {
  const salary = period.income;
  const current = isCurrentPeriod(period);
  const today = daysElapsed(period);                       // day number within the period
  const dim = Math.max(1, daysBetween(period.start, period.estEnd)); // period length (estimated while open)
  const late = current && today > dim;                     // next salary expected but not logged yet

  let needSpent = 0, wantSpent = 0, saved = 0, covers = 0, bonus = 0, flatIn = 0, flatOut = 0;
  rows.forEach((r) => {
    const a = netAmount(r);
    if (isFlat(r)) { if (isIncome(r)) flatIn += Number(r.amount) || 0; else flatOut += a; }
    else if (isIncome(r)) { if (isExtra(r)) bonus += Number(r.amount) || 0; else covers += Number(r.amount) || 0; }
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

  // bills: paid this period when a need / want (a flat expense, for the flat's
  // bills) with the same name exists; due on the first occurrence of their day
  // on/after payday. Unpaid ones are reserved from their own bucket (needs, or
  // wants for subscriptions); the flat's come off the flat's balance instead.
  const bills = (budget.bills || []).map((b) => {
    const kind = billKind(b);
    return { name: b.name, amount: Number(b.amount) || 0, due: dueDate(b.day, period.start), kind,
      paid: rows.some((r) => (r.kind === "need" || r.kind === "want") && isFlat(r) === (kind === "flat") && matchesName(r, b.name)) };
  });
  const unpaid = (kind) => current ? bills.filter((b) => b.kind === kind && !b.paid).reduce((s, b) => s + b.amount, 0) : 0;
  const upcoming = unpaid("need");
  const upcomingWant = unpaid("want");
  const upcomingFlat = unpaid("flat");

  return { salary, current, today, dim, late, needSpent, wantSpent, saved, covers, bonus, extra,
    needBudget, wantBudget, saveTarget, needMine, bills, upcoming, upcomingWant, flatIn, flatOut, upcomingFlat };
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
  if (b.paid) {
    const done = el("span", "plan-act done", "✓");
    done.setAttribute("aria-label", "Paid");
    row.appendChild(done);
  } else {
    const pay = el("button", "plan-act", "Mark paid");
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
    : inDays === 0 ? "Due today" : inDays === 1 ? "Due tomorrow" : "Due in " + inDays + " days";
}

// Bills are needs unless marked as a want (subscriptions) or the flat's.
function billKind(b) { return b.kind === "want" || b.kind === "flat" ? b.kind : "need"; }

// One tap: log a planned bill as paid today (edit it from the list if it differed).
async function logBill(b) {
  haptic();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { showScreen("screen-auth"); return; }
  const kind = billKind(b);
  const rec = { user_id: user.id, amount: b.amount, title: b.name, categories: ["Bills"], kind: kind === "flat" ? "need" : kind };
  if (kind === "flat") rec.flat = true;
  const { data, error } = await sb.from("expenses").insert(rec).select();
  if (error) { toast(error.message, true); return; }
  const row = data && data[0];
  toast(b.name + " paid · " + euro0(b.amount), false, row ? { label: "Undo", fn: () => undoInsert(row.id) } : null);
  refresh();
}

// Money in saved from the details step: ask for the amount first if it's missing.
function saveIncome() {
  if (!entry.amount) { toast("Enter an amount", true); showStep("step-amount"); return; }
  saveExpense();
}

// The details step's Save: money in, or an expense for the flat (no Need / Want
// to pick; it's stored as a need).
function saveDetails() {
  if (entry.kind === "income") { saveIncome(); return; }
  if (!$("#cat-custom-wrap").hidden) addCustomCategory($("#cat-custom").value);
  if (entry.kind !== "want" && entry.kind !== "save") entry.kind = "need";
  saveExpense();
}

/* ---- edit lists (salaries, bills) ---- */
function inputCell(cls, value, placeholder, mode, label) {
  const i = document.createElement("input");
  i.className = cls;
  i.type = "text";
  i.value = value == null ? "" : value;
  i.placeholder = placeholder;
  i.autocomplete = "off";
  if (label) i.setAttribute("aria-label", label);
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

/* ---- settings: salaries, split, preferences, account ---- */
function updateSplitHint() {
  const sum = ["#bs-need", "#bs-want", "#bs-save"].reduce((s, id) => s + (parseFloat($(id).value) || 0), 0);
  const h = $("#bs-split-hint");
  h.textContent = sum === 100 ? "Adds up to 100% ✓" : "Adds up to " + sum + "% — should be 100%";
  h.classList.toggle("bad", sum !== 100);
}

// Unsaved edits (settings, or the bills list): leaving asks before dropping them.
let budgetDirty = false;
function setBudgetDirty(on) {
  budgetDirty = on;
  $("#bs-save-btn").disabled = !on;
}
let billsDirty = false;
function confirmLeave() {
  const active = $(".screen.active");
  const dirty = active && ((active.id === "screen-budget" && budgetDirty) || (active.id === "screen-bills" && billsDirty));
  if (dirty && !confirm("Discard your changes?")) return false;
  setBudgetDirty(false);
  billsDirty = false;
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
  date.setAttribute("aria-label", "Date");
  row.appendChild(date);
  row.appendChild(inputCell("er-amt wide", p.amount, "€", "decimal", "Amount"));
  row.appendChild(removeBtn(row));
  const list = $("#bs-salaries");
  if (prepend) list.insertBefore(row, list.firstChild); else list.appendChild(row);
  return row;
}

function updateReimbPref() {
  $$("#pref-reimb button").forEach((b) => b.classList.toggle("active", !!b.dataset.full === reimbFull));
}

async function openBudgetSettings() {
  showScreen("screen-budget");
  $("#screen-budget .hist-scroll").scrollTop = 0;
  updateReimbPref();
  sb.auth.getSession().then(({ data }) => {
    $("#acct-email").textContent = data && data.session && data.session.user ? data.session.user.email || "" : "";
  });
  // always fresh: saving writes back every salary shown here
  const ok = await loadBudget();
  if (budgetMissing) { toast("Re-run supabase/schema.sql first", true); return; }
  if (!ok) { toast("Couldn't load your budget — try again", true); return; }
  const pays = paydays().reverse(); // newest first
  hiddenPaydays = {};
  pays.slice(SHOWN_PAYDAYS).forEach((p) => { hiddenPaydays[p.date] = p.amount; });
  $("#bs-salaries").innerHTML = "";
  pays.slice(0, SHOWN_PAYDAYS).forEach((p) => addSalaryRow(p));
  if (!pays.length) $("#bs-salaries").appendChild(el("div", "edit-empty", "No salary logged yet. Add one, or use + → Salary when it lands."));
  $("#bs-need").value = budget.need_pct;
  $("#bs-want").value = budget.want_pct;
  $("#bs-save").value = budget.save_pct;
  updateSplitHint();
  setBudgetDirty(false);
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

  if (!(await saveBudget({ need_pct: pcts[0], want_pct: pcts[1], save_pct: pcts[2], incomes }))) return;
  haptic();
  toast("Budget saved");
  statsPeriod = null;
  openBudgetSettings();
}

/* ------------------------------------------------------------------ */
/*  Card payments: Apple Pay → Shortcut → inbox → one tap              */
/* ------------------------------------------------------------------ */
// An iPhone Shortcut (Wallet "Transaction" automation) posts each Apple Pay
// payment to log_card_payment() in Supabase. They wait in card_inbox until
// you tap Need / Want; the title, categories and kind are guessed from what
// you logged there (or under that name) before.
let inbox = [];     // card payments to confirm, newest first
let homeRows = [];  // this month's entries, to spot a payment you already logged by hand

async function loadInbox() {
  const { data, error } = await sb.from("card_inbox").select("*").order("created_at", { ascending: false }).limit(50);
  inbox = error ? [] : data || []; // no table yet (old schema): nothing to confirm
}

// "LIDL*1234 PARIS" → "lidl 1234 paris": what's compared between merchants and titles.
function merchantKey(s) {
  return norm(s).replace(/[^a-z0-9]+/g, " ").trim();
}

function rememberMerchant(r) {
  if (!r.merchant || !r.kind || r.kind === "income") return;
  byMerchant.set(merchantKey(r.merchant), { title: r.title || r.merchant, categories: r.categories || [], kind: r.kind });
}

// "CARREFOUR CITY" → "Carrefour City"; mixed case is left alone.
function tidyMerchant(m) {
  const t = String(m || "").trim().replace(/\s+/g, " ");
  return t === t.toUpperCase() ? t.toLowerCase().replace(/(^|[\s'-])\S/g, (c) => c.toUpperCase()) : t;
}

// { title, categories, kind } for a card payment: what this merchant was last
// logged as, else a title you use that matches it word for word ("Lidl" in
// "LIDL DIENSTLEISTUNG"), most used first. kind is null when there's no clue.
function guessFor(item) {
  const m = merchantKey(item.merchant);
  const fresh = { title: tidyMerchant(item.merchant) || "Card payment", categories: [], kind: null };
  if (!m) return fresh;
  const seen = byMerchant.get(m);
  if (seen) return { title: seen.title, categories: seen.categories.slice(), kind: seen.kind };
  const words = (s) => " " + s + " ";
  const hit = Array.from(known.values())
    .filter((k) => k.kind !== "income")
    .map((k) => ({ k, t: merchantKey(k.title) }))
    .filter(({ t }) => t.length >= 3 && (words(m).includes(words(t)) || (m.length >= 3 && words(t).includes(words(m)))))
    .sort((a, b) => b.k.count - a.k.count)[0];
  return hit ? { title: hit.k.title, categories: hit.k.categories.slice(), kind: hit.k.kind } : fresh;
}

// An entry you logged by hand for the same amount within a day: probably this payment.
function alreadyLogged(item) {
  const when = new Date(item.created_at);
  return homeRows.find((r) => !r.merchant && !isIncome(r) && Math.round(Number(r.amount)) === Math.round(Number(item.amount))
    && Math.abs(new Date(r.created_at) - when) < DAY);
}

function inboxAlert() {
  const n = inbox.length;
  const names = inbox.slice(0, 3).map((i) => guessFor(i).title + " " + euro0(i.amount)).join(", ") + (n > 3 ? "…" : "");
  return { id: "inbox-" + inbox[0].id + "-" + n, icon: "💳",
    title: n === 1 ? "Confirm " + guessFor(inbox[0]).title + " · " + euro0(inbox[0].amount) : n + " card payments to confirm",
    body: (n === 1 ? "Paid with Apple Pay " + dayLabel(new Date(inbox[0].created_at)).toLowerCase() : names) + ". Tap Need or Want to log " + (n === 1 ? "it." : "them."),
    fn: openInbox };
}

async function removeFromInbox(item) {
  inbox = inbox.filter((i) => i.id !== item.id);
  const { error } = await sb.from("card_inbox").delete().eq("id", item.id);
  if (error) console.error(error);
}

// One tap: log it with the guessed title and categories as a need or a want.
async function confirmCard(item, kind) {
  haptic();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { showScreen("screen-auth"); return; }
  const g = guessFor(item);
  const record = { user_id: user.id, amount: Math.round(Number(item.amount) || 0), title: g.title, categories: g.categories,
    kind, merchant: item.merchant, created_at: item.created_at };
  const { data, error } = await sb.from("expenses").insert(record).select();
  if (error) { toast("Couldn't save: " + error.message, true); return; }
  rememberTitle(record);
  rememberMerchant(record);
  rememberCats(record.categories);
  await removeFromInbox(item);
  afterInboxChange();
  const id = data && data[0] && data[0].id;
  toast("Logged " + record.title + " · " + (kind === "need" ? "Need" : "Want"), false, id ? { label: "Undo", fn: () => undoInsert(id, item) } : null);
}

// Not an expense (or already logged by hand): drop it.
async function dismissCard(item) {
  haptic();
  await removeFromInbox(item);
  afterInboxChange();
  toast("Dismissed", false, { label: "Undo", fn: async () => {
    const { error } = await sb.from("card_inbox").insert(item);
    if (error) { toast(error.message, true); return; }
    refresh();
  } });
}

// Tap the payment itself to change the title, categories, day or amount first.
function editCard(item) {
  haptic();
  $("#sheet").hidden = true;
  const g = guessFor(item);
  const back = currentTab();
  resetEntry();
  entry.returnTo = back;
  entry.inbox = item;
  entry.amount = Math.round(Number(item.amount) || 0);
  entry.title = g.title;
  entry.createdAt = item.created_at;
  entry.date = toDateInput(new Date(item.created_at));
  entry.catsTouched = g.categories.length > 0;
  applyCategories(g.categories);
  renderAmount();
  $("#title-input").value = entry.title;
  showScreen("screen-entry");
  enterDetails();
  updateKindUI(g.kind);
}

function afterInboxChange() {
  if (!$("#sheet").hidden && $("#sheet").dataset.view === "inbox") {
    if (inbox.length) openInbox(); else $("#sheet").hidden = true;
  }
  refresh();
}

function inboxRow(item) {
  const g = guessFor(item);
  const dup = alreadyLogged(item);
  const row = el("div", "ib-row");
  const top = el("button", "ib-top");
  top.type = "button";
  const main = el("div", "hi-main");
  main.appendChild(el("div", "hi-title", g.title));
  const when = new Date(item.created_at);
  const sub = [dayLabel(when) + " " + when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })];
  sub.push(g.categories.length ? g.categories.join(" · ") : "No category yet");
  main.appendChild(el("div", "ib-sub", sub.join(" · ")));
  if (dup) main.appendChild(el("div", "ib-dup", "Already logged as " + (dup.title || "an entry") + "?"));
  top.appendChild(main);
  top.appendChild(el("div", "hi-amount", euro0(item.amount)));
  top.addEventListener("click", () => editCard(item));
  row.appendChild(top);
  const acts = el("div", "ib-acts");
  [["need", "Need"], ["want", "Want"]].forEach(([k, label]) => {
    const b = el("button", "ib-btn " + k + (g.kind === k && !dup ? " guess" : ""), label);
    b.type = "button";
    b.addEventListener("click", () => confirmCard(item, k));
    acts.appendChild(b);
  });
  const x = el("button", "ib-btn x" + (dup ? " guess" : ""), dup ? "Dismiss" : "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Dismiss");
  x.addEventListener("click", () => dismissCard(item));
  acts.appendChild(x);
  row.appendChild(acts);
  return row;
}

function openInbox() {
  const list = el("div", "ib-list");
  list.appendChild(el("p", "hint small-hint ib-hint", "Tap Need or Want to log a payment as guessed, or tap it to change the details first."));
  inbox.forEach((i) => list.appendChild(inboxRow(i)));
  openSheet("Card payments to confirm", [list]);
  $("#sheet").dataset.view = "inbox";
}

/* ---- settings: the Shortcut that sends Apple Pay payments here ---- */
// The Shortcut's secret, created on first use. renew: a new one (the old one stops working).
async function cardToken(renew) {
  if (renew) {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return { error: { message: "Not signed in" } };
    const { error } = await sb.from("card_tokens").delete().eq("user_id", user.id);
    if (error) return { error };
  }
  const { data, error } = await sb.from("card_tokens").select("token").maybeSingle();
  if (error) return { error };
  if (data) return { token: data.token };
  const ins = await sb.from("card_tokens").insert({}).select("token").single();
  return ins.error ? { error: ins.error } : { token: ins.data.token };
}

function copyRow(label, value, note) {
  const row = el("div", "cp-row");
  const main = el("div", "cp-main");
  main.appendChild(el("div", "cp-label", label));
  main.appendChild(el("div", "cp-value", value));
  if (note) main.appendChild(el("div", "cp-note", note));
  row.appendChild(main);
  const b = el("button", "plan-act", "Copy");
  b.type = "button";
  b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(value); haptic(); b.textContent = "Copied ✓"; b.classList.add("done"); }
    catch (e) { toast("Couldn't copy — select it instead", true); }
  });
  row.appendChild(b);
  return row;
}

async function openCardSetup() {
  haptic();
  const { token, error } = await cardToken(false);
  if (error) { toast("Re-run supabase/schema.sql first", true); return; }
  const cfg = getConfig();
  const body = el("div", "info-body card-setup");
  const step = (html) => { const li = el("li"); li.innerHTML = html; return li; };
  body.appendChild(el("p", "", "Every Apple Pay payment lands in Notifications with its title, category and Need / Want guessed. One tap logs it."));
  const ol = el("ol", "cs-steps");
  ol.appendChild(step("In <b>Shortcuts</b>, open <b>Automation</b> → <b>+</b> → <b>Transaction</b>. Pick your N26 card, then <b>Run Immediately</b> (turn <b>Notify When Run</b> off) → <b>Next</b> → <b>New Blank Automation</b>."));
  ol.appendChild(step("Add <b>Get Contents of URL</b> and paste the <b>URL</b> below."));
  ol.appendChild(step("Tap <b>›</b> to show more: <b>Method</b> POST. Under <b>Headers</b> add <b>apikey</b> = the key below."));
  ol.appendChild(step("<b>Request Body</b> JSON, four Text fields: <b>token</b> = the token below, <b>amount</b> = Shortcut Input → <i>Amount</i>, <b>merchant</b> = Shortcut Input → <i>Merchant</i>, <b>card</b> = Shortcut Input → <i>Card</i>. <b>Done</b>."));
  body.appendChild(ol);
  body.appendChild(copyRow("URL", cfg.url + "/rest/v1/rpc/log_card_payment"));
  body.appendChild(copyRow("apikey", cfg.key));
  body.appendChild(copyRow("token", token, "Your secret: anyone with it can add payments to confirm."));
  body.appendChild(el("p", "hint small-hint", "Only Apple Pay taps come through: online card payments, direct debits and transfers still need logging by hand (bills cover most of those). Amounts are rounded to the euro."));
  const renew = el("button", "link cs-renew", "Make a new token");
  renew.type = "button";
  renew.addEventListener("click", async () => {
    if (!confirm("Make a new token? The Shortcut stops working until you paste the new one.")) return;
    const r = await cardToken(true);
    if (r.error) { toast(r.error.message, true); return; }
    toast("New token made");
    openCardSetup();
  });
  body.appendChild(renew);
  openSheet("Log Apple Pay automatically", [body]);
}

/* ------------------------------------------------------------------ */
/*  Home: this budget month at a glance                                */
/* ------------------------------------------------------------------ */
let homeSeq = 0; // drops a slow load when a newer one started

async function openHome() {
  showScreen("screen-home");
  $("#home-scroll").scrollTop = 0;
  loadHome();
}

async function loadHome() {
  const seq = ++homeSeq;
  renderHomeHead();
  // read fresh every time: a salary or bill saved on another device (or while
  // the app sat open in the background) changes the month
  await loadBudget();
  const period = periodFor(new Date());
  const prev = periodFor(addDays(period.start, -1));
  const [cur, old, , flat] = await Promise.all([fetchRows(period), fetchRows(prev), loadInbox(), flatBalance()]);
  if (seq !== homeSeq) return;
  if (cur.error) { toast(cur.error.message, true); return; }
  renderHome(period, cur.data, old.error ? null : old.data, prev, flat);
}

// The flat's balance since you started tracking it: rent in minus its bills.
// It's the running total that should sit at zero, whichever month the money
// moves in. Null without the flat column (old schema).
async function flatBalance() {
  const { data, error } = await sb.from("expenses").select("amount, kind, reimbursable, reimb_amount").eq("flat", true);
  if (error) return null;
  return (data || []).reduce((s, r) => s + (isIncome(r) ? Number(r.amount) || 0 : -netAmount(r)), 0);
}

// "Even ✓", "€850 to get back" (you've paid ahead for the flat) or "€40 ahead".
function flatStatus(balance) {
  if (Math.abs(balance) < 1) return ["Even ✓", "good"];
  return balance < 0 ? [euro0(-balance) + " to get back", "warn"] : [euro0(balance) + " ahead", "good"];
}

// Home's flat card: the running balance, and this month's money in and out.
function renderHomeFlat(period, f, balance) {
  const wrap = $("#home-flat");
  wrap.innerHTML = "";
  const any = f.flatIn || f.flatOut || f.bills.some((b) => b.kind === "flat") || (balance != null && Math.abs(balance) >= 1);
  $("#home-flat-wrap").hidden = !any;
  if (!any) return;
  const row = el("button", "hb-row");
  row.type = "button";
  row.addEventListener("click", () => openHistory({ type: "flat", value: true }, period, true));
  const top = el("div", "hb-top");
  top.appendChild(el("span", "hb-ico flat", "🏠"));
  const main = el("div", "hb-main");
  main.appendChild(el("div", "hb-name", "Flat"));
  main.appendChild(el("div", "hb-sub", "+" + euro0(f.flatIn) + " in · " + euro0(f.flatOut) + " out this month"));
  top.appendChild(main);
  const [status, cls] = flatStatus(balance || 0);
  top.appendChild(el("div", "hb-right " + cls, status));
  row.appendChild(top);
  const notes = [];
  if (f.upcomingFlat > 0) notes.push(euro0(f.upcomingFlat) + " of flat bills still to pay");
  notes.push("Kept out of your needs and wants");
  row.appendChild(el("div", "hb-note", notes.join(" · ")));
  wrap.appendChild(row);
}

function renderHomeHead() {
  const now = new Date();
  const h = now.getHours();
  $("#home-date").textContent = now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  $("#home-hello").textContent = h >= 5 && h < 12 ? "Good morning" : h >= 12 && h < 18 ? "Good afternoon" : "Good evening";
}

// What you spent on needs (your share, after money in that covers bills) and
// wants, optionally only before a date. Savings aren't spending.
function spendOf(rows, until) {
  let need = 0, want = 0, covers = 0;
  rows.forEach((r) => {
    if ((until && new Date(r.created_at) >= until) || isFlat(r)) return;
    if (isIncome(r)) { if (!isExtra(r)) covers += Number(r.amount) || 0; }
    else if (r.kind === "need") need += netAmount(r);
    else if (r.kind !== "save") want += netAmount(r);
  });
  return Math.max(0, need - covers) + want;
}

// Big money: whole euros, with cents (if any) set smaller.
function bigEuro(n) {
  const s = formatEuro(Math.round(Math.abs(n) * 100) / 100);
  const frag = el("span", "money");
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
  const svg = svgEl("svg", { viewBox: "0 0 120 120", "aria-hidden": "true" });
  const circle = (cls, len, offset) => {
    const c = svgEl("circle", { cx: 60, cy: 60, r: 50, class: cls });
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
  if (f.late) return ["Payday due", "warn"];
  // wants are the day-to-day money: compare them with the time gone by
  if (f.wantSpent > f.wantBudget * Math.min(1, f.today / f.dim) * 1.1 + 1) return ["Ahead of pace", "warn"];
  return ["On track", "good"];
}

function renderHero(period, rows, prevRows, prev, f) {
  const hero = $("#hero");
  hero.innerHTML = "";
  const top = el("div", "hero-top");
  const pill = el("span", "hero-pill", f.salary == null ? periodMonth(period) : periodMonth(period) + " budget");
  pill.appendChild(infoBtn(period, "on-hero"));
  top.appendChild(pill);
  hero.appendChild(top);

  if (budgetMissing) {
    hero.appendChild(el("p", "hero-note", "Budgets need a database update: re-run supabase/schema.sql in the Supabase SQL editor."));
    return;
  }

  const daysLeft = Math.max(1, f.dim - f.today + 1);
  const mid = el("div", "hero-mid");
  const text = el("div", "hero-text");
  const [cmp, cmpCls] = compareValue(rows, prevRows, prev, f);

  if (f.salary == null) {
    // no salary yet: what went out, per day, and the one step that sets up a budget
    const spent = spendOf(rows);
    text.appendChild(el("div", "hero-label", "Spent so far"));
    const big = el("div", "hero-big");
    big.appendChild(bigEuro(spent));
    text.appendChild(big);
    text.appendChild(el("div", "hero-of", daysLeft + " days left in " + period.start.toLocaleDateString(undefined, { month: "long" })));
    mid.appendChild(text);
    hero.appendChild(mid);
    const tiles = el("div", "hero-tiles");
    tiles.appendChild(statTile("hero-tile", "Per day", euro0(spent / daysElapsed(period))));
    tiles.appendChild(statTile("hero-tile", "vs. last month", cmp, cmpCls));
    hero.appendChild(tiles);
    const cta = el("button", "hero-cta", "Log your salary to set a budget ›");
    cta.type = "button";
    cta.addEventListener("click", startSalary);
    hero.appendChild(cta);
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
  const when = f.late ? "payday expected" : daysLeft + " day" + (daysLeft > 1 ? "s" : "") + " left";
  text.appendChild(el("div", "hero-of", "of " + euro0(line) + " · " + when));
  if (reserved > 0) text.appendChild(el("div", "hero-of faint", euro0(reserved) + " kept for bills"));
  mid.appendChild(text);
  hero.appendChild(mid);

  const tiles = el("div", "hero-tiles");
  tiles.appendChild(statTile("hero-tile", "Safe to spend today", formatEuro(Math.floor(Math.max(0, left) / daysLeft * 100) / 100)));
  tiles.appendChild(statTile("hero-tile", "vs. last month", cmp, cmpCls));
  hero.appendChild(tiles);
}

/* ---- notifications: everything that needs you this month ---- */
// Each alert: { id, icon, title, body, fn }. Most urgent first. The id is
// stable for as long as the situation lasts, so "seen" and "dismissed" stick.
function homeAlerts(period, rows, f) {
  const out = [];
  if (inbox.length) out.push(inboxAlert());
  if (budgetMissing) return out;
  const todayDate = startOfDay(new Date());
  const pid = "@" + toDateInput(period.start);
  if (f.late) out.push({ id: "late" + pid, icon: "📅", title: "Payday was expected",
    body: "No salary since " + period.start.toLocaleDateString(undefined, { day: "numeric", month: "short" }) +
      ". Log it with + → Salary (or in Settings) to start a new budget month.", fn: startSalary });
  const unpaid = byDue(f.bills.filter((b) => !b.paid && b.due));
  unpaid.filter((b) => b.due < todayDate).forEach((b) => out.push({ id: "overdue-" + norm(b.name) + pid, icon: "🧾",
    title: b.name + " is overdue", body: dueLabel(b.due, todayDate, "") + " · " + euro0(b.amount) + ". Mark it paid once it's gone out.", fn: openBills }));
  if (f.salary != null) {
    const left = f.needBudget + f.wantBudget - f.needMine - f.wantSpent - f.upcoming - f.upcomingWant;
    if (left < 0) out.push({ id: "over" + pid, icon: "⚠️", title: "You're " + euro0(-left) + " over budget",
      body: "Spending plus the bills still to pay is past this month's needs + wants budget.", fn: () => openHistory(null, period) });
    else if (!f.late && f.wantBudget > 0) {
      const used = f.wantSpent / f.wantBudget;
      if (used > 0.25 && used > (f.today / f.dim) * 1.15) {
        const byCat = {};
        rows.forEach((r) => {
          if (r.kind !== "want" || isFlat(r)) return;
          (r.categories.length ? r.categories : ["Uncategorised"]).forEach((c) => { byCat[c] = (byCat[c] || 0) + netAmount(r); });
        });
        const top = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a])[0];
        const daysLeft = Math.max(1, f.dim - f.today + 1);
        const perDay = Math.max(0, f.wantBudget - f.wantSpent - f.upcomingWant) / daysLeft;
        out.push({ id: "hot" + pid, icon: "🔥", title: "Wants are running hot",
          body: "You've used " + Math.round(used * 100) + "% of your wants with " + daysLeft + " days to go" + (top ? ", most on " + top : "") + ". " +
            (perDay >= 1 ? "Keep wants under " + euro0(perDay) + " a day to finish on budget." : "Every want from here comes out of savings."),
          fn: () => openHistory({ type: "kind", value: "want" }, period) });
      }
    }
  }
  unpaid.filter((b) => b.due >= todayDate && daysBetween(todayDate, b.due) <= 3).forEach((b) => out.push({
    id: "soon-" + norm(b.name) + pid, icon: "🗓️", title: b.name + " · " + euro0(b.amount),
    body: dueLabel(b.due, todayDate, "") + (b.kind === "flat" ? ". It's the flat's, so it's not in your budget." : ". It's already kept aside from your budget."), fn: openBills }));
  const pending = rows.reduce((s, r) => s + pendingReimb(r), 0);
  if (pending > 0) out.push({ id: "pending-" + Math.round(pending) + pid, icon: "↩︎", title: euro0(pending) + " still owed to you",
    body: "From reimbursable expenses. Tap “got it?” on each one once the money's back.",
    fn: () => openHistory({ type: "pending", value: true }, period, true) });
  if (f.salary != null && !f.late && f.dim - f.today < 5 && f.saved < f.saveTarget) {
    const free = f.needBudget + f.wantBudget - f.needMine - f.wantSpent - f.upcoming - f.upcomingWant;
    if (free >= 1) out.push({ id: "save" + pid, icon: "🐷", title: "Move what's left to savings",
      body: euro0(free) + " is still free with " + Math.max(1, f.dim - f.today + 1) + " days to go. Log it as Save to reach your " + euro0(f.saveTarget) + " target.",
      fn: startAdd });
  }
  return out;
}

function lsList(key) {
  try { const v = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}
function lsAdd(key, ids) {
  const list = lsList(key).filter((k) => ids.indexOf(k) < 0).concat(ids).slice(-80);
  try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) {}
}

let homeAlertList = [];

// The bell's count: alerts you haven't seen yet.
function renderBell() {
  const seen = lsList(LS.alertsSeen);
  const n = homeAlertList.filter((a) => seen.indexOf(a.id) < 0).length;
  const c = $("#home-bell-count");
  c.hidden = !n;
  c.textContent = n > 9 ? "9+" : String(n);
  $("#home-bell").setAttribute("aria-label", n ? "Notifications, " + n + " new" : "Notifications");
}

function alertRow(a, cls, onGo) {
  const row = el("button", cls);
  row.type = "button";
  row.appendChild(el("span", "tip-ico", a.icon));
  const main = el("div", "tip-main");
  main.appendChild(el("div", "tip-title", a.title));
  main.appendChild(el("div", "tip-body", a.body));
  row.appendChild(main);
  row.addEventListener("click", () => { haptic(); if (onGo) onGo(); a.fn(); });
  return row;
}

// The bottom sheet: a title and its content.
function openSheet(title, nodes) {
  $("#sheet-title").textContent = title;
  const list = $("#sheet-list");
  list.innerHTML = "";
  nodes.forEach((n) => list.appendChild(n));
  $("#sheet").dataset.view = "";
  $("#sheet").hidden = false;
}

function openAlerts() {
  haptic();
  const list = el("div");
  if (!homeAlertList.length) {
    const empty = el("div", "sheet-empty");
    empty.appendChild(el("div", "sheet-empty-ico", "✓"));
    empty.appendChild(el("div", "tip-title", "You're all caught up"));
    empty.appendChild(el("div", "tip-body", "Card payments to confirm, bills due soon or overdue, overspending, payday and money owed to you show up here."));
    list.appendChild(empty);
  }
  homeAlertList.forEach((a) => list.appendChild(alertRow(a, "alert-row", () => { $("#sheet").hidden = true; })));
  openSheet("Notifications", [list]);
  lsAdd(LS.alertsSeen, homeAlertList.map((a) => a.id));
  renderBell();
}

// Home shows the most urgent alert you haven't dismissed; the bell has them all.
function renderTip() {
  const wrap = $("#home-tip");
  wrap.innerHTML = "";
  const hidden = lsList(LS.tipsHidden);
  const tip = homeAlertList.find((t) => hidden.indexOf(t.id) < 0);
  if (!tip) return;
  const card = el("div", "tip");
  card.appendChild(alertRow(tip, "tip-btn"));
  const x = el("button", "tip-x", "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Dismiss");
  x.addEventListener("click", () => { haptic(); lsAdd(LS.tipsHidden, [tip.id]); lsAdd(LS.alertsSeen, [tip.id]); renderTip(); renderBell(); });
  card.appendChild(x);
  wrap.appendChild(card);
  const more = homeAlertList.length - 1;
  if (more > 0) {
    const all = el("button", "link tip-more", more + " more in notifications ›");
    all.type = "button";
    all.addEventListener("click", openAlerts);
    wrap.appendChild(all);
  }
}

/* ---- budgets: one card per bucket, tap to see its transactions ---- */
function homeBucket(period, kind, label, icon, spent, target, opts) {
  opts = opts || {};
  const row = el("button", "hb-row");
  row.type = "button";
  row.addEventListener("click", () => openHistory({ type: "kind", value: KIND_FILTER[kind] }, period, true));
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
      if (isIncome(r) || isFlat(r)) return;
      if (r.kind === "need") need += netAmount(r); else if (r.kind === "save") save += netAmount(r); else want += netAmount(r);
    });
    const max = Math.max(need, want, save, 1);
    wrap.appendChild(homeBucket(period, "want", "Wants", "✦", want, null, { max }));
    wrap.appendChild(homeBucket(period, "need", "Needs", "✓", need, null, { max }));
    wrap.appendChild(homeBucket(period, "save", "Save", "◆", save, null, { max }));
    return;
  }
  wrap.appendChild(homeBucket(period, "want", "Wants", "✦", f.wantSpent, f.wantBudget,
    { reserved: f.upcomingWant, marker: (f.today / f.dim) * 100 }));
  wrap.appendChild(homeBucket(period, "need", "Needs", "✓", f.needMine, f.needBudget, { reserved: f.upcoming }));
  wrap.appendChild(homeBucket(period, "save", "Save", "◆", f.saved, f.saveTarget));
  if (f.extra) {
    const inBtn = el("button", "link hb-in", "+ " + euro0(f.extra) + " money in this month ›");
    inBtn.type = "button";
    inBtn.addEventListener("click", () => openHistory({ type: "income", value: true }, period, true));
    wrap.appendChild(inBtn);
  }
}

function renderHome(period, rows, prevRows, prev, flat) {
  homeRows = rows;
  const f = budgetFigures(rows, period);
  renderHero(period, rows, prevRows, prev, f);
  homeAlertList = homeAlerts(period, rows, f);
  renderBell();
  renderTip();
  renderHomeBudgets(period, rows, f);
  renderHomeFlat(period, f, flat);

  // the next bills to pay
  const toPay = byDue(f.bills.filter((b) => !b.paid));
  $("#home-bills-wrap").hidden = !f.bills.length;
  const bl = $("#home-bills");
  bl.innerHTML = "";
  if (toPay.length) toPay.slice(0, 3).forEach((b) => bl.appendChild(billRow(b)));
  else bl.appendChild(el("div", "plan-row done-all", "All bills paid this month ✓"));

  // latest entries: tap one to edit it
  const rec = $("#home-recent");
  rec.innerHTML = "";
  if (!rows.length) {
    rec.appendChild(el("div", "hist-empty card", "Nothing logged yet — tap + to add an expense."));
    return;
  }
  rows.slice(0, 5).forEach((r) => rec.appendChild(renderItem(r)));
}

/* ---- bills screen: this month's checklist, and editing the list ---- */
let billsEditing = false;

async function openBills() {
  billsEditing = false;
  billsDirty = false;
  showScreen("screen-bills");
  $("#bills-scroll").scrollTop = 0;
  loadBills();
}

async function loadBills() {
  if (!billsEditing) await loadBudget();
  renderBillsMode();
  if (billsEditing) return;
  const period = periodFor(new Date());
  const { data, error } = await fetchRows(period);
  if (error) { toast(error.message, true); return; }
  const f = budgetFigures(data, period);
  const sum = $("#bills-sum");
  const list = $("#bills-list");
  sum.innerHTML = "";
  list.innerHTML = "";
  $("#bills-edit").hidden = !f.bills.length;
  if (!f.bills.length) {
    const c = el("div", "bcard empty");
    c.appendChild(el("div", "empty-ico", "🧾"));
    c.appendChild(el("div", "tip-title", "No bills yet"));
    c.appendChild(el("div", "hint", "Add rent, subscriptions and other payments that come back every month. Unpaid ones are kept aside from your budget, and one tap marks them paid."));
    const add = el("button", "btn primary small", "+ Add your bills");
    add.type = "button";
    add.addEventListener("click", () => editBills(true));
    c.appendChild(add);
    sum.appendChild(c);
    return;
  }
  const todayDate = startOfDay(new Date());
  // the flat's bills get their own section: they don't come out of your budget
  const mine = f.bills.filter((b) => b.kind !== "flat");
  const flat = byDue(f.bills.filter((b) => b.kind === "flat"));
  const toPay = byDue(mine.filter((b) => !b.paid));
  const total = mine.reduce((s, b) => s + b.amount, 0);
  const left = toPay.reduce((s, b) => s + b.amount, 0);
  const section = (label, bills) => {
    if (!bills.length) return;
    list.appendChild(el("div", "section-label", label));
    bills.forEach((x) => list.appendChild(billRow(x)));
  };
  if (mine.length) {
    const card = el("div", "bcard bills-card");
    card.appendChild(el("div", "ins-label", toPay.length ? "Still to pay this month" : "All paid this month"));
    const big = el("div", "ins-big");
    big.appendChild(bigEuro(left));
    card.appendChild(big);
    card.appendChild(el("div", "ins-sub", (mine.length - toPay.length) + " of " + mine.length + " paid · " + euro0(total) + " a month"));
    const b = bar("need", total - left, 0, total);
    b.classList.add("bills-bar");
    card.appendChild(b);
    sum.appendChild(card);
    section("Overdue", toPay.filter((x) => x.due && x.due < todayDate));
    section("Coming up", toPay.filter((x) => !x.due || x.due >= todayDate));
    section("Paid", mine.filter((x) => x.paid));
  }
  if (flat.length) {
    const flatLeft = flat.filter((x) => !x.paid).reduce((s, x) => s + x.amount, 0);
    list.appendChild(el("div", "section-label", "Flat · " + (flatLeft ? euro0(flatLeft) + " still to pay" : "all paid")));
    list.appendChild(el("p", "hint small-hint", "Paid from the flat's balance, not your budget."));
    flat.forEach((x) => list.appendChild(billRow(x)));
  }
}

function renderBillsMode() {
  $("#bills-view").hidden = billsEditing;
  $("#bills-editor").hidden = !billsEditing;
  $("#bills-edit").textContent = billsEditing ? "Cancel" : "Edit";
  if (billsEditing) $("#bills-edit").hidden = false;
}

function addBillRow(b) {
  const row = el("div", "edit-row");
  row.appendChild(inputCell("er-name", b.name, "Rent", null, "Name"));
  row.appendChild(inputCell("er-amt", b.amount, "€", "decimal", "Amount"));
  row.appendChild(inputCell("er-day", b.day, "Day", "numeric", "Day of the month"));
  const kind = el("button", "er-kind");
  kind.type = "button";
  const LABEL = { need: "Need", want: "Want", flat: "Flat" };
  const NEXT = { need: "want", want: "flat", flat: "need" };
  const setKind = (k) => { row.dataset.kind = k; kind.textContent = LABEL[k]; kind.className = "er-kind " + k; };
  setKind(billKind(b));
  kind.addEventListener("click", () => { haptic(); setKind(NEXT[row.dataset.kind]); });
  row.appendChild(kind);
  row.appendChild(removeBtn(row));
  $("#bs-bills").appendChild(row);
  return row;
}

// Edit mode: the bills as rows of name / amount / day / need-want.
function editBills(on) {
  if (!on && !confirmLeave()) return;
  haptic();
  billsEditing = on;
  billsDirty = false;
  if (on) {
    $("#bs-bills").innerHTML = "";
    (budget.bills || []).forEach(addBillRow);
    if (!(budget.bills || []).length) addBillRow({}).querySelector("input").focus();
  }
  $("#bills-scroll").scrollTop = 0;
  loadBills();
}

async function saveBills() {
  const bills = [];
  for (const row of $$("#bs-bills .edit-row")) {
    const name = row.querySelector(".er-name").value.trim();
    if (!name) continue;
    const amount = parseMoney(row.querySelector(".er-amt").value);
    if (amount == null) { toast("Invalid amount for " + name, true); return; }
    const day = parseInt(row.querySelector(".er-day").value, 10);
    bills.push({ name, amount, day: day >= 1 && day <= 31 ? day : null, kind: billKind({ kind: row.dataset.kind }) });
  }
  if (!(await saveBudget({ bills }))) return;
  haptic();
  toast("Bills saved");
  billsDirty = false;
  billsEditing = false;
  loadBills();
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
  const active = $(".screen.active");
  if (active && TABS[active.id] === tab && tab !== "home") return;
  if (!confirmLeave()) return;
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
    // money in can go on without one: a past source's chip brings its amount
    if (entry.amount === 0 && entry.kind !== "income") { toast("Enter an amount", true); return; }
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
  $("#det-save").addEventListener("click", saveDetails);
  $$("#in-kind .pill").forEach((b) => b.addEventListener("click", () => setIncomeKind(b.dataset.in)));
  $("#cat-custom").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addCustomCategory(e.target.value); }
  });
  $("#cat-custom").addEventListener("blur", (e) => {
    if (e.target.value.trim()) addCustomCategory(e.target.value);
  });

  // flags + kind (tapping a kind saves)
  $("#reimb-toggle").addEventListener("click", toggleReimb);
  $("#flat-toggle").addEventListener("click", toggleFlat);
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
  $("#entry-close").addEventListener("click", () => {
    const back = entry.returnTo || "screen-home";
    resetEntry();
    showStep("step-amount");
    goScreen(back);
  });
  $("#entry-delete").addEventListener("click", deleteEntry);
  $$("#mode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $$(".tab[data-tab]").forEach((t) => t.addEventListener("click", () => navTab(t.dataset.tab)));
  $("#tab-add").addEventListener("click", () => navTab("add"));

  // home
  initPrivacy();
  $("#home-bell").addEventListener("click", openAlerts);
  $("#home-see-bills").addEventListener("click", () => navTab("bills"));
  $("#home-see-all").addEventListener("click", () => openHistory(null, null, true));
  $("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") $("#sheet").hidden = true; });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && sb && $("#screen-home").classList.contains("active")) loadHome();
  });

  // insights
  $("#month-prev").addEventListener("click", () => changeMonth(-1));
  $("#month-next").addEventListener("click", () => changeMonth(1));

  // bills
  $("#bills-edit").addEventListener("click", () => editBills(!billsEditing));
  $("#bs-add-bill").addEventListener("click", () => { billsDirty = true; addBillRow({}).querySelector("input").focus(); });
  $("#bills-save").addEventListener("click", saveBills);
  $("#bills-editor").addEventListener("input", () => (billsDirty = true));
  $("#bills-editor").addEventListener("click", (e) => { if (e.target.closest(".er-kind, .hi-act")) billsDirty = true; });

  // settings
  $("#screen-budget").addEventListener("input", (e) => { if (e.target.closest("#bs-salaries, .split-grid")) setBudgetDirty(true); });
  $("#bs-salaries").addEventListener("click", (e) => { if (e.target.closest(".hi-act")) setBudgetDirty(true); });
  $("#bs-add-salary").addEventListener("click", () => {
    const empty = $("#bs-salaries .edit-empty");
    if (empty) empty.remove();
    addSalaryRow({ date: toDateInput(new Date()) }, true);
    setBudgetDirty(true);
  });
  $("#bs-save-btn").addEventListener("click", saveBudgetSettings);
  ["#bs-need", "#bs-want", "#bs-save"].forEach((id) => $(id).addEventListener("input", updateSplitHint));
  $$("#pref-reimb button").forEach((b) => b.addEventListener("click", () => {
    reimbFull = !!b.dataset.full;
    try { localStorage.setItem(LS.reimbFull, reimbFull ? "1" : ""); } catch (e) {}
    haptic();
    updateReimbPref();
  }));
  $("#card-setup").addEventListener("click", openCardSetup);
  $("#sign-out").addEventListener("click", signOut);
  $("#acct-supabase").addEventListener("click", () => {
    if (confirm("Disconnect this Supabase project? You'll paste the URL and key again.")) resetConfig();
  });
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
