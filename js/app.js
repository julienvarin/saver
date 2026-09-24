"use strict";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */
// Edit this list to change your categories.
const CATEGORIES = [
  "Food", "Groceries", "Transport", "Shopping",
  "Bills", "Health", "Fun", "Travel", "Other",
];

// Day your "month" starts (payday). Changeable in Stats → tap the date range.
const DEFAULT_MONTH_START_DAY = 26;

const LS = {
  url: "saver.sb_url",
  key: "saver.sb_key",
  cutoff: "saver.cutoff",
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
let statsMonth = null;                    // Date at the first day of the shown month
let statsRows = [];                        // cached rows for the shown month
let statsFilter = { type: null, value: null }; // null | 'kind'|'need'/'want' | 'category'|name

function matchesFilter(r) {
  if (!statsFilter.type) return true;
  if (statsFilter.type === "kind") return r.kind === statsFilter.value;
  if (statsFilter.type === "category") return (r.categories || []).includes(statsFilter.value);
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

/* ---- salary cycle: a "month" runs from one payday to the next ---- */
// Stored per device: { day: usual start day, overrides: { "YYYY-MM": "YYYY-MM-DD" } }.
// A month is named after where most of its days fall, so with a start day of
// 26 the "October" month runs 26 Sep → 25 Oct. Overrides move a single
// month's start (e.g. salary arrived on the 24th because the 26th was a Sunday).
function getCutoff() {
  let c = null;
  try { c = JSON.parse(localStorage.getItem(LS.cutoff)); } catch (e) {}
  const day = Math.min(31, Math.max(1, parseInt(c && c.day, 10) || DEFAULT_MONTH_START_DAY));
  return { day, overrides: (c && c.overrides) || {} };
}

function setCutoff(c) {
  try { localStorage.setItem(LS.cutoff, JSON.stringify(c)); } catch (e) {}
}

function monthKey(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function dateKey(d) {
  return monthKey(d) + "-" + String(d.getDate()).padStart(2, "0");
}

// Start (local midnight) of the month named by d's year/month.
function periodStart(d) {
  const c = getCutoff();
  const o = c.overrides[monthKey(d)];
  if (o) {
    const [y, m, day] = o.split("-").map(Number);
    return new Date(y, m - 1, day);
  }
  // late start day → the month begins in the previous calendar month
  const m = c.day > 15 ? d.getMonth() - 1 : d.getMonth();
  const len = new Date(d.getFullYear(), m + 1, 0).getDate();
  return new Date(d.getFullYear(), m, Math.min(c.day, len));
}

function monthRange(d) {
  return {
    start: periodStart(d),
    end: periodStart(new Date(d.getFullYear(), d.getMonth() + 1, 1)),
  };
}

// The month (as a Date on its 1st) that today falls in.
function currentPeriod() {
  const now = new Date();
  let d = new Date(now.getFullYear(), now.getMonth(), 1);
  while (now < monthRange(d).start) d = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  while (now >= monthRange(d).end) d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return d;
}

function isCurrentMonth(d) {
  return monthKey(d) === monthKey(currentPeriod());
}

// Days counted for the per-day average: elapsed days for the current month,
// full length for a past month.
function daysElapsed(monthDate) {
  const { start, end } = monthRange(monthDate);
  const DAY = 86400000;
  if (isCurrentMonth(monthDate)) {
    return Math.max(1, Math.floor((new Date() - start) / DAY) + 1);
  }
  return Math.max(1, Math.round((end - start) / DAY));
}

function shortDate(d) {
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function renderMonthRange() {
  const { start, end } = monthRange(statsMonth);
  const last = new Date(end); last.setDate(last.getDate() - 1);
  $("#month-range").textContent = shortDate(start) + " – " + shortDate(last) + " ✎";
}

function toggleCutoffPanel(show) {
  const panel = $("#cutoff-panel");
  show = show === undefined ? panel.hidden : show;
  panel.hidden = !show;
  if (!show) return;
  const c = getCutoff();
  $("#cutoff-day").value = c.day;
  $("#cutoff-date").value = dateKey(monthRange(statsMonth).start);
  $("#cutoff-this-label").firstChild.textContent =
    statsMonth.toLocaleDateString(undefined, { month: "long" }) + " started";
}

function saveCutoff() {
  const c = getCutoff();
  const day = parseInt($("#cutoff-day").value, 10);
  if (!(day >= 1 && day <= 31)) { toast("Pick a day between 1 and 31", true); return; }
  const key = monthKey(statsMonth);
  const picked = $("#cutoff-date").value;
  // untouched date + new usual day → just follow the new usual day
  const dateUntouched = picked === dateKey(monthRange(statsMonth).start);
  const dayChanged = day !== c.day;

  c.day = day;
  delete c.overrides[key];
  setCutoff(c);

  // keep a one-off start only if it differs from what the usual day gives
  if (picked && !(dayChanged && dateUntouched) && picked !== dateKey(periodStart(statsMonth))) {
    c.overrides[key] = picked;
    setCutoff(c);
    // it must stay between the neighbouring months' starts
    const { start, end } = monthRange(statsMonth);
    const prev = monthRange(new Date(statsMonth.getFullYear(), statsMonth.getMonth() - 1, 1));
    if (!(start > prev.start && start < end)) {
      delete c.overrides[key];
      setCutoff(c);
      toast("That date overlaps another month", true);
      return;
    }
  }
  afterCutoffChange();
}

function resetCutoffMonth() {
  const c = getCutoff();
  delete c.overrides[monthKey(statsMonth)];
  setCutoff(c);
  afterCutoffChange();
}

function afterCutoffChange() {
  toggleCutoffPanel(false);
  haptic();
  // stay on the same month, but never past the current one
  if (monthKey(statsMonth) > monthKey(currentPeriod())) statsMonth = currentPeriod();
  loadHistory();
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
  statsMonth = currentPeriod();
  statsFilter = { type: null, value: null };
  toggleCutoffPanel(false);
  showScreen("screen-history");
  loadHistory();
}

function changeMonth(delta) {
  const d = new Date(statsMonth.getFullYear(), statsMonth.getMonth() + delta, 1);
  if (delta > 0 && monthKey(d) > monthKey(currentPeriod())) return; // don't go past the current month
  statsMonth = d;
  statsFilter = { type: null, value: null };
  toggleCutoffPanel(false);
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
  renderMonthRange();
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

  statsRows = data || [];
  renderStats(statsRows);
  renderList(statsRows);
}

function renderStats(rows) {
  const filtered = rows.filter(matchesFilter);
  const kindFilter = statsFilter.type === "kind";
  const catFilter = statsFilter.type === "category";

  // headline total + per-day, over the filtered set
  let total = 0, need = 0, want = 0, pending = 0;
  filtered.forEach((r) => {
    total += netAmount(r);
    if (r.kind === "need") need += netAmount(r);
    else if (r.kind === "want") want += netAmount(r);
  });
  rows.forEach((r) => { pending += pendingReimb(r); }); // pending ignores filter

  const perDay = total / daysElapsed(statsMonth);
  $("#stat-total").textContent = formatEuro(total);
  $("#stat-perday").textContent = formatEuro(perDay) + " / day";

  // label + clear affordance reflect the active filter
  const label = !statsFilter.type ? "Total spent"
    : statsFilter.type === "kind" ? (statsFilter.value === "need" ? "Needs" : "Wants")
    : statsFilter.value;
  $("#stat-label").textContent = label;
  $("#stat-clear").hidden = !statsFilter.type;

  // pending reimbursement line (money still to get back) — not filtered
  const pw = $("#reimb-pending");
  if (pending > 0) {
    pw.hidden = false;
    $("#reimb-pending-amt").textContent = formatEuro(pending);
  } else {
    pw.hidden = true;
  }

  // needs vs wants — reflects the filtered set; clickable to filter by kind
  const nwTotal = need + want;
  const needPct = nwTotal ? Math.round((need / nwTotal) * 100) : 0;
  $("#nw-need").style.width = (nwTotal ? (need / nwTotal) * 100 : 0) + "%";
  $("#nw-want").style.width = (nwTotal ? (want / nwTotal) * 100 : 0) + "%";
  $("#nw-need-amt").textContent = formatEuro(need);
  $("#nw-want-amt").textContent = formatEuro(want);
  $("#nw-need-pct").textContent = nwTotal ? needPct + "%" : "";
  $("#nw-want-pct").textContent = nwTotal ? (100 - needPct) + "%" : "";
  const nItem = $("#nw-need-item"), wItem = $("#nw-want-item");
  nItem.classList.toggle("active", kindFilter && statsFilter.value === "need");
  wItem.classList.toggle("active", kindFilter && statsFilter.value === "want");
  nItem.classList.toggle("dim", kindFilter && statsFilter.value !== "need");
  wItem.classList.toggle("dim", kindFilter && statsFilter.value !== "want");

  // category breakdown — scoped by an active kind filter, but not by a
  // category filter (so you can still switch between categories).
  const catScope = kindFilter ? rows.filter((r) => r.kind === statsFilter.value) : rows;
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
    head.textContent = "By category";
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
  sub.textContent = statsFilter.type ? (shown.length + " expense" + (shown.length > 1 ? "s" : "")) : "All expenses";
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
  $("#month-range").addEventListener("click", () => toggleCutoffPanel());
  $("#cutoff-save").addEventListener("click", saveCutoff);
  $("#cutoff-reset").addEventListener("click", resetCutoffMonth);

  // stats filters
  $("#nw-need-item").addEventListener("click", () => setFilter("kind", "need"));
  $("#nw-want-item").addEventListener("click", () => setFilter("kind", "want"));
  $("#stat-clear").addEventListener("click", () => setFilter(statsFilter.type, statsFilter.value));
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
