-- Isolated snapshot before migration 9, never production.
create table public.cancel_assistance_baseline as select
  p.oid,p.proowner,p.proacl::text function_acl,p.prosecdef,p.proconfig::text function_config,
  (select md5(pg_get_functiondef('public.release_unused_agent_allowance(uuid)'::regprocedure))) release_definition,
  (select md5(pg_get_functiondef('public.update_search_run(uuid,jsonb)'::regprocedure))) update_definition,
  (select to_jsonb(g) from public.budget_guard g where singleton) budget,
  (select count(*) from public.daily_usage) usage_rows,
  (select count(*) from public.search_runs) runs,
  (select count(*) from public.provider_operations) operations,
  (select count(*) from public.budget_ledger) ledger
from pg_proc p where oid='public.request_search_cancel(uuid,text)'::regprocedure;
