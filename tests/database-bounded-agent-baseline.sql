-- Isolated test snapshot immediately before migration 7; never run in production.
create table public.bounded_agent_test_baseline as select
  (select to_jsonb(b) from public.budget_guard b where singleton) budget,
  (select md5(pg_get_functiondef('public.reserve_provider_operation(uuid,text,text,integer,text)'::regprocedure))) legacy_definition,
  (select proacl::text from pg_proc where oid='public.reserve_provider_operation(uuid,text,text,integer,text)'::regprocedure) legacy_acl,
  (select count(*) from public.provider_operations) operations,
  (select count(*) from public.budget_ledger) ledger_entries;
