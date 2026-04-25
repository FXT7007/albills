-- Run this once in Supabase SQL Editor (Dashboard -> SQL Editor -> New query, paste, Run).
-- Safe to re-run: uses "create table if not exists" / "create index if not exists".

-- 1. Idempotency log: every Gumroad sale we successfully process gets one row here.
--    Prevents double-crediting if Gumroad retries the webhook.
create table if not exists public.gumroad_sales (
  sale_id        text primary key,
  email          text not null,
  user_id        uuid references auth.users(id) on delete set null,
  credits_added  integer not null default 0,
  permalink      text,
  created_at     timestamp with time zone default now()
);
create index if not exists gumroad_sales_email_idx on public.gumroad_sales(email);

-- 2. Pending credits queue: when someone buys before signing up (or with a different
--    email than their AlBills account), credits land here and are auto-redeemed on
--    first sign-in matching that email.
create table if not exists public.pending_credits (
  id                 uuid primary key default gen_random_uuid(),
  email              text not null,
  credits            integer not null,
  sale_id            text,
  permalink          text,
  created_at         timestamp with time zone default now(),
  redeemed_at        timestamp with time zone,
  redeemed_user_id   uuid references auth.users(id) on delete set null
);
create index if not exists pending_credits_email_unredeemed_idx
  on public.pending_credits(email) where redeemed_at is null;

-- 3. Row-Level Security:
--    - The webhook uses the service-role key (bypasses RLS), so writes are fine.
--    - Logged-in users should be able to read their own pending_credits to redeem them.
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

-- gumroad_sales is internal/admin-only — no policy = no read for authenticated users.
-- Service role still has full access for the webhook.

-- 4. invoice_usage table — make sure the credits_used column exists (used by the
--    new dashboard history column). Safe to re-run.
alter table public.invoice_usage add column if not exists credits_used integer;
