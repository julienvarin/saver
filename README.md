# Saver 💶

The fastest, most minimal euro expense tracker — a home-screen web app (PWA)
hosted on GitHub Pages, with data in your own Supabase project.

**Home** is this budget month at a glance: what's left to spend (a ring of how much is gone), what's
safe to spend today, how you compare with last month, your three budgets, the next bills and your
latest entries. The 🔔 lists everything that needs you (overdue or upcoming bills, overspending,
payday, money owed to you) with a count of what's new; the most urgent one also shows on Home.

**Insights** goes month by month (‹ ›): what you spent and how it compares, a day-by-day spending
pace against last month and your budget, where it went against your plan, wants / needs by category
(with the change since last month), the last six months, and every transaction with filters. Tap a
budget, a category or a tile to filter the transactions.

**Bills** is this month's checklist (Mark paid logs one); **Edit** changes the list itself.
**Settings** has your salaries, the split, how reimbursable expenses count, and your account.

**The flow:** tap **+** → type the amount → Next → title + category on one screen → tap Need or Want → saved.
The switch above the keypad turns it into **Money in** or a **Salary**. Things you've logged before
show up as one-tap chips ("Lidl · Groceries"), so a repeat expense is just the amount and one tap.
The **Today ▾** chip logs it on another day. Tap any entry to edit or delete it; every save, delete
or bill payment can be undone from the toast.

No build step, no framework — plain HTML/CSS/JS + the Supabase JS client from a CDN.

---

## 1. Create your Supabase project

1. Go to **https://supabase.com** → **New project**. Pick any name (e.g. `saver`),
   set a database password (you won't need it for the app), choose a region near you,
   and create it. Wait ~1 minute for it to provision.

2. **Create the table.** In the left sidebar open **SQL Editor → New query**, paste the
   contents of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
   This creates the `expenses` table with Row Level Security so you only ever see your own data.

3. **Enable email + password login (no confirmation email).** Go to
   **Authentication → Sign In / Providers → Email** and make sure **Email** is enabled,
   then turn **Confirm email OFF** and save. This lets you set an email + password once and
   sign in instantly — no confirmation emails are ever sent, so you never hit email rate limits.

4. **Grab your keys.** Go to **Project Settings → API** (or **Data API**) and copy:
   - **Project URL** — looks like `https://abcdefgh.supabase.co`
   - **anon public key** — the long `anon` / publishable key
     (never use the `service_role` key here).

   > These two values are safe to use in a public browser app: the anon key only allows
   > what Row Level Security permits, which is "the signed-in user's own rows."

---

## 2. Deploy to GitHub Pages

This repo ships a workflow ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml))
that publishes the site on every push to `main`.

- After this is merged to `main`, open the repo's **Actions** tab and watch the
  **Deploy to GitHub Pages** run finish. Your app will be live at:

  ```
  https://YOURNAME.github.io/saver/
  ```

- If the first run fails asking you to enable Pages, go to **Settings → Pages** and set
  **Source = GitHub Actions**, then re-run the workflow. (The workflow tries to enable this
  automatically, but the one-click setting is the fallback.)

### Automatic schema updates

A second workflow ([`.github/workflows/supabase-schema.yml`](.github/workflows/supabase-schema.yml))
re-runs `supabase/schema.sql` on your database whenever a merge to `main` changes it, so you
don't have to paste it into the SQL Editor again. One-time setup:

1. In Supabase, click **Connect** (top bar) and copy the **Session pooler** connection string
   (not "Direct connection" — that one is IPv6-only and GitHub's runners can't reach it).
   Replace `[YOUR-PASSWORD]` with your database password (reset it under
   **Project Settings → Database** if you don't have it).
2. In GitHub, go to **Settings → Secrets and variables → Actions → New repository secret**,
   name it `SUPABASE_DB_URL` and paste the string.
3. Run it once by hand from **Actions → Apply Supabase schema → Run workflow** to check it works.

The script is idempotent and runs in a single transaction, so a failing statement changes nothing.
Keep new changes in the same style (`add column if not exists`, `drop ... if exists` then `create`).

---

## 3. Add it to your iPhone home screen

1. Open the app URL in **Safari** on your iPhone.
2. First launch asks for your **Supabase URL** and **anon key** (from step 1.4) — paste them
   once; they're stored only on your device.
3. Enter an **email + password** and tap **Create account** (first time), then **Sign in**.
   You stay signed in on this device — no emails involved.
4. Tap the **Share** button → **Add to Home Screen**. Now it opens full-screen like a
   native app, straight from your home screen.

---

## Budget

Open the **Settings** tab to set:

- **Salary received** — each salary starts a new budget month, running until the next one
  lands (so a salary on the 3rd gives a 3rd → 2nd month). When it arrives, tap **+** → **Salary**.
  Before your first salary, budget months are calendar months. A budget month is named after the
  month closest to payday: a salary on 26 September starts your **October** budget (tap ⓘ next to
  the month name for a reminder).
- **Split** — how your salary divides into Needs / Wants / Save (default 50 / 30 / 20). Each
  bar's line is exactly that share of your salary (plus any **Extra** money in, see below).
**Bills** live on the Bills tab (**Edit** to change them): recurring payments, subscriptions
included, with their usual day. Tap the **Need / Want** toggle on each: rent and electricity are
needs, Spotify is a want. Unpaid ones are reserved from their own budget (due on the first
occurrence of their day after payday); tap **Mark paid** to log one. Want subscriptions are left
out of the day-to-day "pace" so they don't skew it.

**+** → **Salary** opens the keypad with your last salary; tap **Save** (or type the new amount).

**Money in** (a sub-tenant paying you, a refund, a side job): tap **+** → **Money in**. Sources
you've logged before show up as chips with their last amount — tap **Next** without an amount, then
one tap logs it again. For a new one, type the amount, a title, pick where it goes and tap **Save**:

- **🏠 Flat** (the sub-tenant's rent for a flat you sub-let) — goes on the flat's own balance, see
  below. Nothing in your budget moves.
- **Covers bills** (someone chipping in for rent, internet, electricity) — taken off what you spent
  on Needs, so the Needs bar shows your own share; what's left of it covers the bills still to
  pay. No line moves.
- **Extra · split** (a DJ fee, an eBay sale) — added to your salary and split by the same
  percentages, so every line grows.

Each source remembers its choice, so the chip logs it the same way next time.

**The flat** (a second place you sub-let): its bills and the sub-tenant's rent are tracked apart
from Needs and Wants, so rent that arrives late (or a bill paid early) never makes your own budget
look over. Mark an expense **🏠 Flat** on the details screen (one **Save to flat**, no Need / Want),
log the rent as **Money in → 🏠 Flat**, and set the flat's recurring bills to **Flat** in the Bills
editor (tap Need → Want → Flat). Home's **Flat** card shows the running balance since you started
— money in minus bills, across months — which should sit at **Even ✓**: "€700 to get back" means
you've paid ahead and the rent hasn't come in yet. Tap it for the flat's transactions. Tap **+ €… money in**
on Home to list what came in, and edit or delete it from there. If someone
pays you back for part of a specific expense, mark that expense **Reimbursable** instead.

Each expense is **Need**, **Want** or **Save** (money put aside). A late bill or overdue invoice
is just a **Need**. Home's budgets are three bars — solid is what's spent (or saved), hatched is
what's still planned:

- **Wants** — spent, plus subscriptions still to come. The white line is today: stay left of it.
- **Needs** — your share paid so far (needs minus money in), plus bills still to pay this month
  (less any money in that covers them). The note under it spells this out; the bar turns red when
  those bills alone add up to more than your needs budget.
- **Save** — what you've put aside so far, against your save share. Whatever is left in Needs or
  Wants at the end of the month is yours to move here.

A bar that goes past its line gets an outline: red for Needs / Wants, green for Save.

Reimbursable expenses count as what's left on you after the refund; Settings can switch them to
the full amount. Mark the money as received with the **got it?** badge on the entry.

**By category** on Insights starts on wants — that's where you can cut back. Needs are mostly
fixed bills; switch to them with the toggle.

> Upgrading? Re-run [`supabase/schema.sql`](supabase/schema.sql) once (the workflow does it on
> merge) — it adds the `budgets` table, and turns old **Debt** entries into
> **Need**s. It's safe to run on an existing project.

## Apple Pay: log card payments automatically

Every Apple Pay tap can land in Saver on its own: the 🔔 shows **N card payments to confirm**, with the
title, category and Need / Want guessed from what you logged there before ("LIDL DIENSTLEISTUNG" →
Lidl · Groceries · Need). One tap on **Need** or **Want** logs it at the time you paid; tap the payment
itself to change the details first, or **✕** to drop it. A payment that matches one you already typed in
by hand (same euros, same day) says **Already logged?** so you can dismiss it. Amounts are rounded to
the euro.

Set it up once in **Settings → Apple Pay → Set up**: it shows the steps and the three values to paste
into an iPhone **Shortcuts** automation (**Automation → + → Transaction**, Run Immediately, then
**Get Contents of URL** posting to `log_card_payment`). The token there is your secret: **Make a new
token** if it leaks.

Only Apple Pay taps come through (iOS gives Shortcuts nothing else): online card payments, direct
debits and transfers still need logging by hand — your **Bills** cover most of them.

## Customising

- **Categories:** the chips are the categories you actually use, most used first — one you never
  use doesn't show up. Add one with **+**. Before your first expense you get the starter list in
  `CATEGORIES` at the top of [`js/app.js`](js/app.js); retired names (Food, Drinks, Subscriptions)
  are mapped to their new ones in `RENAMED` just below it.
- **Colours / look:** the CSS variables at the top of [`css/style.css`](css/style.css) — light by
  default, dark when your phone is in dark mode.
- **App icon:** re-run `python3 scripts/gen_icons.py` after tweaking the colours in that script.

## How your data is protected

- Every expense row is tagged with your user id, and Supabase **Row Level Security**
  only returns/edits rows where `user_id = auth.uid()`. Even though the anon key is public,
  no one can read or write your data without being signed in as you.
- Your session is stored on your device and refreshed automatically, so you sign in once.
