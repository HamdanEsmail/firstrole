-- Isolated test snapshots immediately before migration 8, never production.
create table public.assistance_test_functions as
select oid,proname,proowner,proacl::text function_acl,prosecdef,proconfig::text function_config,
  md5(pg_get_functiondef(oid)) definition_hash
from pg_proc where oid in (
  'public.update_search_run(uuid,jsonb)'::regprocedure,
  'public.create_search_run(uuid,text,uuid,text,text,text,jsonb,boolean,text)'::regprocedure,
  'public.reserve_provider_operation(uuid,text,text,integer,text)'::regprocedure,
  'public.reserve_bounded_agent_operation(uuid,text,text,integer,numeric)'::regprocedure,
  'public.claim_provider_operation(uuid,text)'::regprocedure,
  'public.settle_provider_operation(uuid,text,text,numeric,boolean,boolean)'::regprocedure,
  'public.firstrole_index_jobs(jsonb)'::regprocedure,
  'public.request_search_cancel(uuid,text)'::regprocedure
);
create table public.assistance_test_data as select
  (select to_jsonb(b) from public.budget_guard b where singleton) budget,
  (select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]'::jsonb) from public.search_runs r) runs,
  (select coalesce(jsonb_agg(to_jsonb(d) order by key_kind,key_hash,usage_date),'[]'::jsonb) from public.daily_usage d) usage,
  (select coalesce(jsonb_agg(to_jsonb(o) order by id),'[]'::jsonb) from public.provider_operations o) operations,
  (select coalesce(jsonb_agg(to_jsonb(l) order by id),'[]'::jsonb) from public.budget_ledger l) ledger;
