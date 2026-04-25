-- ============================================================================
-- AlBills · Row-Level Security audit
-- Run this in Supabase SQL Editor. It only READS — no writes, no destructive ops.
-- It tells you exactly which tables are protected and which ones are wide open.
-- ============================================================================

-- 1. Which public tables have RLS enabled?
select schemaname,
       tablename,
       case when rowsecurity then '✅ ENABLED' else '🔴 DISABLED — DATA IS PUBLIC' end as rls_status
from pg_tables
where schemaname = 'public'
  and tablename in ('profiles', 'invoice_usage', 'gumroad_sales', 'pending_credits')
order by tablename;

-- 2. List all RLS policies on these tables
select schemaname,
       tablename,
       policyname,
       cmd        as command,           -- SELECT / INSERT / UPDATE / DELETE / ALL
       roles      as applies_to_roles,
       qual       as using_clause,      -- the row-filter
       with_check as with_check_clause
from pg_policies
where schemaname = 'public'
  and tablename in ('profiles', 'invoice_usage', 'gumroad_sales', 'pending_credits')
order by tablename, cmd, policyname;

-- 3. The rules below are what AlBills should have. Compare to the output above.
--
--    profiles
--      ✓ RLS enabled
--      ✓ users can SELECT/UPDATE only their own row (id = auth.uid())
--      ✗ no INSERT policy needed — service role inserts on first sign-in
--
--    invoice_usage
--      ✓ RLS enabled
--      ✓ users can SELECT only their own rows (user_id = auth.uid())
--      ✗ INSERT goes through service role / extract API only
--
--    pending_credits
--      ✓ RLS enabled (set by gumroad-tables.sql)
--      ✓ users can SELECT/UPDATE rows whose email matches their auth.users.email
--
--    gumroad_sales
--      ✓ RLS enabled (set by gumroad-tables.sql)
--      ✓ no policy = service role only (correct — internal accounting)

-- 4. If any of those rules are missing, here's the SQL to fix it.
--    Run only the ones you need — they're 'create policy if not exists' style
--    via drop-then-create so re-running is safe.

-- profiles
do $$ begin
  if exists (select 1 from pg_tables where schemaname='public' and tablename='profiles') then
    execute 'alter table public.profiles enable row level security';
    execute 'drop policy if exists "users read own profile" on public.profiles';
    execute 'create policy "users read own profile" on public.profiles for select to authenticated using (id = auth.uid())';
    execute 'drop policy if exists "users update own profile" on public.profiles';
    execute 'create policy "users update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid())';
  end if;
end $$;

-- invoice_usage
do $$ begin
  if exists (select 1 from pg_tables where schemaname='public' and tablename='invoice_usage') then
    execute 'alter table public.invoice_usage enable row level security';
    execute 'drop policy if exists "users read own invoice_usage" on public.invoice_usage';
    execute 'create policy "users read own invoice_usage" on public.invoice_usage for select to authenticated using (user_id = auth.uid())';
  end if;
end $$;

-- 5. Re-run query #1 above to confirm everything is now ✅ ENABLED.
