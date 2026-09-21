-- Saver — Supabase schema
-- Run this once in your Supabase project:  SQL Editor  ->  New query  ->  paste  ->  Run.

create table if not exists public.expenses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade default auth.uid(),
  amount      numeric(12, 2) not null check (amount >= 0),
  title       text,
  categories    text[] not null default '{}',
  kind          text check (kind in ('need', 'want')),
  split         boolean not null default false,
  reimbursable  boolean not null default false,
  reimbursed    boolean not null default false,
  created_at    timestamptz not null default now()
);

-- Migrations (safe to run anytime on an existing table):
alter table public.expenses add column if not exists split        boolean not null default false;
alter table public.expenses add column if not exists reimbursable boolean not null default false;
alter table public.expenses add column if not exists reimbursed   boolean not null default false;

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
