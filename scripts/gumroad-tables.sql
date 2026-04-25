-- Run this once in Supabase SQL Editor (Dashboard -> SQL Editor -> New query, paste, Run).
-- Fully idempotent: re-runnable even if a previous run partially created the tables.

-- ============================================================================
-- 1. Idempotency log
--    Every Gumroad sale we successfully process gets one row here.
--    Prevents double-crediting if Gumroad retries the webhook.
-- ============================================================================
create table if not exists public.gumroad_sales (
  sale_id text primary key
);

-- Add columns idempotently (handles older partial runs)
alter table public.gumroad_sales add column if not exists email         text;
alter table public.gumroad_sales add column if not exists user_id       uuid;
alter table public.gumroad_sales add column if not exists credits_added integer default 0;
alter table public.gumroad_sales add column if not exists permalink     text;
alter table public.gumroad_sales add column if not exists created_at    timestamp with time zone default now();

-- FK on user_id (drop+add so it's safe if already there)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'gumroad_sales_user_id_fkey') then
    alter table public.gumroad_sales
      add constraint gumroad_sales_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete set null;
  end if;
end $$;

create index if not exists gumroad_sales_email_idx on public.gumroad_sales(email);


-- ============================================================================
-- 2. Pending credits queue
--    When someone buys before signing up (or with a different email than their
--    AlBills account), credits land here and are auto-redeemed on first sign-in
--    matching that email.
-- ============================================================================
create table if not exists public.pending_credits (
  id uuid primary key default gen_random_uuid()
);

alter table public.pending_credits add column if not exists email            text;
alter table public.pending_credits add column if not exists credits          integer;
alter table public.pending_credits add column if not exists sale_id          text;
alter table public.pending_credits add column if not exists permalink        text;
alter table public.pending_credits add column if not exists created_at       timestamp with time zone default now();
alter table public.pending_credits add column if not exists redeemed_at      timestamp with time zone;
alter table public.pending_credits add column if not exists redeemed_user_id uuid;

-- Tighten NOT NULLs only if every row already has a value (otherwise skip)
do $$ begin
  if not exists (select 1 from public.pending_credits where email is null) then
    begin
      alter table public.pending_credits alter column email set not null;
    exception when others then null; end;
  end if;
  if not exists (select 1 from public.pending_credits where credits is null) then
    begin
      alter table public.pending_credits alter column credits set not null;
    exception when others then null; end;
  end if;
end $$;

-- FK on redeemed_user_id (idempotent)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'pending_credits_redeemed_user_id_fkey') then
    alter table public.pending_credits
      add constraint pending_credits_redeemed_user_id_fkey
      foreign key (redeemed_user_id) references auth.users(id) on delete set null;
  end if;
end $$;

create index if not exists pending_credits_email_unredeemed_idx
  on public.pending_credits(email) where redeemed_at is null;


-- ============================================================================
-- 3. Row-Level Security
--    Webhook uses service-role key (bypasses RLS), so writes always work.
--    Authenticated users can read/update only their own pending_credits.
-- ============================================================================
alter table public.pending_credits enable row level security;
alter table public.gumroad_sales   enable row level security;

drop policy if exists "users read own pending_credits" on public.pending_credits;
create policy "users read own pending_credits"
  on public.pending_credits for select
  to authenticated
  using ( email = (select lower(email) from auth.users where id = auth.uid()) );

drop policy if exists "users update own pending_credits" on public.pending_credits;
create policy "users update own pending_credits"
  on public.pending_credits for update
  to authenticated
  using ( email = (select lower(email) from auth.users where id = auth.uid()) )
  with check ( email = (select lower(email) from auth.users where id = auth.uid()) );

-- gumroad_sales has no select/update policy on purpose — service-role only.


-- ============================================================================
-- 4. invoice_usage: ensure credits_used column exists (used by dashboard history)
-- ============================================================================
alter table public.invoice_usage add column if not exists credits_used integer;
