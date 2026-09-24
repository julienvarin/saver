# Saver 💶

The fastest, most minimal euro expense tracker — a home-screen web app (PWA)
hosted on GitHub Pages, with data in your own Supabase project.

**The flow:** type the amount → short title → tap categories → Need or Want → saved.
Swipe into the ≡ menu for recent history and this month's total.

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

## Customising

- **Month start (payday):** in Stats, tap the date range under the month name to set the
  day your month starts (default 26 → "October" = 26 Sep – 25 Oct), or move just one month's
  start when your salary lands on a different day. Stored on the device.
- **Categories:** edit the `CATEGORIES` array at the top of [`js/app.js`](js/app.js).
- **Colours / look:** the CSS variables at the top of [`css/style.css`](css/style.css).
- **App icon:** re-run `python3 scripts/gen_icons.py` after tweaking the colours in that script.

## How your data is protected

- Every expense row is tagged with your user id, and Supabase **Row Level Security**
  only returns/edits rows where `user_id = auth.uid()`. Even though the anon key is public,
  no one can read or write your data without being signed in as you.
- Your session is stored on your device and refreshed automatically, so you sign in once.
