-- ============================================================================
-- AlBills · Fix profiles schema
--
-- The app code (api/extract.js, index.html setUser/redeemPendingCredits, and
-- api/gumroad-webhook.js) all assume profiles has these columns:
--   credits          integer  — remaining processable invoices
--   total_processed  integer  — lifetime count (legacy, no longer the source of truth)
--   first_name       text
--   last_name        text
--
-- If the table was created without them, every credit read returns undefined
-- (which the JS coerces to 3 via fallback) and every credit write fails
-- silently. Run this once to add what's missing. Idempotent — safe to re-run.
-- ============================================================================

alter table public.profiles add column if not exists credits         integer not null default 3;
alter table public.profiles add column if not exists total_processed integer not null default 0;
alter table public.profiles add column if not exists first_name      text;
alter table public.profiles add column if not exists last_name       text;

-- Existing profile rows: backfill credits to 3 if currently NULL (shouldn't be
-- after the NOT NULL DEFAULT, but belt-and-braces).
update public.profiles set credits = 3 where credits is null;
update public.profiles set total_processed = 0 where total_processed is null;

-- Sanity check: if any auth.users row has no profile row, create one.
-- Defaults to 3 free credits. This catches users who signed up while the
-- profiles INSERT in setUser() was silently failing because the columns
-- didn't exist.
insert into public.profiles (id, credits, total_processed)
select u.id, 3, 0
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- Verify
select count(*) as profiles_total,
       count(*) filter (where credits is not null) as profiles_with_credits
from public.profiles;
