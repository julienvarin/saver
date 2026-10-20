-- Saver — Supabase schema
-- Run this once in your Supabase project:  SQL Editor  ->  New query  ->  paste  ->  Run.

create table if not exists public.expenses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade default auth.uid(),
  amount      numeric(12, 2) not null check (amount >= 0),
  title       text,
  categories    text[] not null default '{}',
  kind          text check (kind in ('need', 'want', 'save', 'income')),
  split         boolean not null default false,
  reimbursable  boolean not null default false,
  reimbursed    boolean not null default false,
  reimb_amount  numeric(12, 2) check (reimb_amount >= 0), -- null = fully reimbursable
  created_at    timestamptz not null default now()
);

-- Migrations (safe to run anytime on an existing table):
alter table public.expenses add column if not exists split        boolean not null default false;
alter table public.expenses add column if not exists reimbursable boolean not null default false;
alter table public.expenses add column if not exists reimbursed   boolean not null default false;
alter table public.expenses add column if not exists reimb_amount numeric(12, 2) check (reimb_amount >= 0);
-- kinds: 'need', 'want', 'save' (money put aside) and 'income' (extra money in on top of
-- salary, e.g. a sub-tenant paying you). The old 'debt' kind is gone: a late bill is just a need.
alter table public.expenses drop constraint if exists expenses_kind_check;
update public.expenses set kind = 'need' where kind = 'debt';
alter table public.expenses add constraint expenses_kind_check check (kind in ('need', 'want', 'save', 'income'));

-- Split is gone: a split expense now just records your half (amount halved once, flag cleared).
update public.expenses set amount = round(amount / 2, 2), split = false where split;

-- Category clean-up: eating out and drinks are "Eat out", and subscriptions are just bills
-- (need / want already tells them apart). Case-insensitive, and safe to re-run.
update public.expenses
  set categories = array(
    select distinct case lower(c) when 'food' then 'Eat out' when 'drinks' then 'Eat out' when 'subscriptions' then 'Bills' else c end
    from unnest(categories) as c)
  where exists (select 1 from unnest(categories) as c where lower(c) in ('food', 'drinks', 'subscriptions'));

-- Fast lookups for the history screen (newest first, per user).
create index if not exists expenses_user_created_idx
  on public.expenses (user_id, created_at desc);

-- Row Level Security: each person only ever sees / edits their own rows.
alter table public.expenses enable row level security;

drop policy if exists "own rows - select" on public.expenses;
create policy "own rows - select" on public.expenses
  for select using (auth.uid() = user_id);

drop policy if exists "own rows - insert" on public.expenses;
create policy "own rows - insert" on public.expenses
  for insert with check (auth.uid() = user_id);

drop policy if exists "own rows - update" on public.expenses;
create policy "own rows - update" on public.expenses
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows - delete" on public.expenses;
create policy "own rows - delete" on public.expenses
  for delete using (auth.uid() = user_id);

-- Budget settings: one row per user.
--   incomes: {"2026-10": 2500, ...}  monthly income; a month without one uses the latest earlier month
--   bills:   [{"name": "Rent", "amount": 800, "day": 5, "kind": "need"}, ...]  planned monthly bills
--            and subscriptions; kind "need" (default) or "want"
--   debts:   no longer used (kept so old data isn't lost)
create table if not exists public.budgets (
  user_id    uuid primary key references auth.users (id) on delete cascade default auth.uid(),
  need_pct   numeric(5, 2) not null default 50,
  want_pct   numeric(5, 2) not null default 30,
  save_pct   numeric(5, 2) not null default 20,
  incomes    jsonb not null default '{}',
  bills      jsonb not null default '[]',
  debts      jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

alter table public.budgets enable row level security;

drop policy if exists "own budget - all" on public.budgets;
create policy "own budget - all" on public.budgets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Card payments to confirm. An iPhone Shortcut (Wallet "Transaction" automation) posts each
-- Apple Pay payment to log_card_payment() below; the app lists them in Notifications, where
-- one tap on Need / Want logs it as an expense (merchant kept, so its guess improves).
alter table public.expenses add column if not exists merchant text;

create table if not exists public.card_inbox (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade default auth.uid(),
  amount     numeric(12, 2) not null check (amount >= 0), -- whole euros, rounded on the way in
  merchant   text,
  card       text,
  created_at timestamptz not null default now()
);
create index if not exists card_inbox_user_created_idx on public.card_inbox (user_id, created_at desc);

alter table public.card_inbox enable row level security;
drop policy if exists "own inbox - all" on public.card_inbox;
create policy "own inbox - all" on public.card_inbox
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The Shortcut's secret: one per user, shown (and renewable) in Settings.
create table if not exists public.card_tokens (
  user_id    uuid primary key references auth.users (id) on delete cascade default auth.uid(),
  token      uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now()
);

alter table public.card_tokens enable row level security;
drop policy if exists "own token - all" on public.card_tokens;
create policy "own token - all" on public.card_tokens
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Called by the Shortcut with the anon key (no sign-in): the token says whose inbox it is.
-- amount is text as Shortcuts sends it ("€12.50", "12,50 €", "1.234,56"…), rounded to the euro.
create or replace function public.log_card_payment(token text, amount text, merchant text default null, card text default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  uid uuid;
  s   text := regexp_replace(coalesce(amount, ''), '[^0-9,.]', '', 'g');
  n   numeric;
begin
  select t.user_id into uid from public.card_tokens t where t.token::text = lower(trim(log_card_payment.token));
  if uid is null then raise exception 'Unknown token' using errcode = '28000'; end if;
  -- the last , or . followed by 1-2 digits is the decimal point; any other one groups thousands
  if s ~ '[,.][0-9]{1,2}$' then
    s := regexp_replace(left(s, length(s) - length(substring(s from '[,.][0-9]{1,2}$'))), '[,.]', '', 'g')
      || '.' || substring(s from '[0-9]{1,2}$');
  else
    s := regexp_replace(s, '[,.]', '', 'g');
  end if;
  if s !~ '[0-9]' then raise exception 'No amount in "%"', amount using errcode = '22023'; end if;
  n := round(s::numeric);
  insert into public.card_inbox (user_id, amount, merchant, card)
    values (uid, n, nullif(left(trim(log_card_payment.merchant), 120), ''), nullif(left(trim(log_card_payment.card), 60), ''));
  return json_build_object('ok', true, 'amount', n);
end $$;

revoke all on function public.log_card_payment(text, text, text, text) from public;
grant execute on function public.log_card_payment(text, text, text, text) to anon, authenticated;
