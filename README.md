# Saver 💶

The fastest, most minimal euro expense tracker — a home-screen web app (PWA)
hosted on GitHub Pages, with data in your own Supabase project.

**The flow:** type the amount → Next → title + category on one screen → tap Need or Want → saved.
Things you've logged before show up as one-tap chips ("Lidl · Groceries"), so a repeat
expense is just the amount and one tap. The **Today ▾** chip logs it on another day, and
every save, delete or bill payment can be undone from the toast.
Tap the chart icon for Stats: tap a budget bucket or the pending line to filter the list.

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

Tap **Edit budget** on the Stats card (or **⚙** at the top of Stats) to set:

- **Salary received** — each salary starts a new budget month, running until the next one
  lands (so a salary on the 3rd gives a 3rd → 2nd month). Tap **+ New salary** on the Stats
  card when it arrives. Before your first salary, Stats uses calendar months.
- **Split** — Needs / Wants / Save + debt (default 50 / 30 / 20).
- **Bills & subscriptions** — recurring payments with their usual day. Tap the **Need / Want**
  toggle on each: rent and electricity are needs, Spotify is a want. Unpaid ones are reserved
  from their own budget (due on the first occurrence of their day after payday); tap **Paid**
  to log one. Want subscriptions are left out of the day-to-day "pace" so they don't skew it.
- **Debts** — what you still owe. Tap **Pay** to log a repayment (amount only).

**+ New salary** opens the keypad with your last salary; tap **Save** (or type the new amount).

**Extra money in** (a sub-tenant paying you, a refund, a side job): tap **+ Money in** on the
Stats card, type the amount and a title. It's added to this month's income and split like
your salary. If someone pays you back for part of a specific expense, mark that expense
**Reimbursable** instead.

Each expense is now **Need**, **Want**, **Debt** (repaying a debt / overdue invoice) or
**Save** (money put aside). Debt and Save both count toward the savings share.
The Stats screen shows what's left in Wants (and per day), whether you're ahead of pace,
needs after upcoming bills, and how much you're on track to save.

> Upgrading? Re-run [`supabase/schema.sql`](supabase/schema.sql) once — it adds the
> `budgets` table and the new expense kinds. It's safe to run on an existing project.

## Customising

- **Categories:** edit the `CATEGORIES` array at the top of [`js/app.js`](js/app.js). Any category you add with **+ Other** is remembered automatically and shows up as a quick-pick chip from then on.
- **Colours / look:** the CSS variables at the top of [`css/style.css`](css/style.css).
- **App icon:** re-run `python3 scripts/gen_icons.py` after tweaking the colours in that script.

## How your data is protected

- Every expense row is tagged with your user id, and Supabase **Row Level Security**
  only returns/edits rows where `user_id = auth.uid()`. Even though the anon key is public,
  no one can read or write your data without being signed in as you.
- Your session is stored on your device and refreshed automatically, so you sign in once.
