-- Isolated test runner only. Capture the existing function/security/data state
-- immediately before the monotonic catalog migration. NEVER run in production.
create temp table firstrole_catalog_migration_baseline as
select p.oid as function_oid,p.proowner as owner_oid,p.proacl::text as function_acl,
  p.prosecdef as security_definer,p.proconfig::text as function_config,
  (select to_jsonb(g) from public.budget_guard g where singleton) as budget_state,
  (select count(*) from public.budget_ledger) as ledger_count,
  (select count(*) from public.profiles) as profile_count,
  (select count(*) from public.saved_jobs) as saved_count,
  (select count(*) from auth.users) as user_count
from pg_proc p where p.oid='public.firstrole_index_jobs(jsonb)'::regprocedure;
