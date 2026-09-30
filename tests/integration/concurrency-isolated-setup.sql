-- REVIEW BEFORE RUNNING. Disposable PostgreSQL concurrency test, not a migration.
-- Creates ONLY firstrole_concurrency_qa20260930 and ONE uniquely named public RPC.
-- Copies table STRUCTURE, never production rows. Three existing function bodies
-- are copied exactly, replacing only "public." with the private QA namespace.
-- Fictional balances/ledger records cannot authorize any FirstRole/TinyFish work:
-- the deployed app uses public.search_runs/public.budget_guard, never this schema.
-- No auth bootstrap, users, production budget updates, provider calls, or purchases.
-- After the test, run concurrency-isolated-cleanup.sql, including after a failure.
begin;
create schema firstrole_concurrency_qa20260930;
comment on schema firstrole_concurrency_qa20260930 is 'FirstRole disposable concurrency QA 20260930; fictional funds only';
revoke all on schema firstrole_concurrency_qa20260930 from public,anon,authenticated,service_role;

create table firstrole_concurrency_qa20260930.budget_guard (like public.budget_guard including all);
create table firstrole_concurrency_qa20260930.daily_usage (like public.daily_usage including all);
create table firstrole_concurrency_qa20260930.search_runs (like public.search_runs including all);
create table firstrole_concurrency_qa20260930.provider_operations (like public.provider_operations including all);
create table firstrole_concurrency_qa20260930.budget_ledger (like public.budget_ledger including all);
create table firstrole_concurrency_qa20260930.search_cache (like public.search_cache including all);
create table firstrole_concurrency_qa20260930.provenance (name text primary key,source_hash text not null,clone_hash text not null);
alter table firstrole_concurrency_qa20260930.budget_guard enable row level security;
alter table firstrole_concurrency_qa20260930.daily_usage enable row level security;
alter table firstrole_concurrency_qa20260930.search_runs enable row level security;
alter table firstrole_concurrency_qa20260930.provider_operations enable row level security;
alter table firstrole_concurrency_qa20260930.budget_ledger enable row level security;
alter table firstrole_concurrency_qa20260930.search_cache enable row level security;
alter table firstrole_concurrency_qa20260930.provenance enable row level security;

do $$
declare signature text; source_definition text; clone_definition text; target_signature text; source_oid regprocedure;
begin
  foreach signature in array array[
    'public.create_search_run(uuid,text,uuid,text,text,text,jsonb,boolean,text)',
    'public.reserve_provider_operation(uuid,text,text,integer,text)',
    'public.claim_provider_operation(uuid,text)'
  ] loop
    source_oid:=signature::regprocedure;
    source_definition:=pg_get_functiondef(source_oid);
    clone_definition:=replace(source_definition,'public.','firstrole_concurrency_qa20260930.');
    execute clone_definition;
    target_signature:=replace(signature,'public.','firstrole_concurrency_qa20260930.');
    insert into firstrole_concurrency_qa20260930.provenance(name,source_hash,clone_hash)
    values(signature,md5(source_definition),md5(replace(pg_get_functiondef(target_signature::regprocedure),'firstrole_concurrency_qa20260930.','public.')));
  end loop;
end $$;
revoke all on all tables in schema firstrole_concurrency_qa20260930 from public,anon,authenticated,service_role;
revoke all on all sequences in schema firstrole_concurrency_qa20260930 from public,anon,authenticated,service_role;
revoke all on all functions in schema firstrole_concurrency_qa20260930 from public,anon,authenticated,service_role;

create function public.qa_firstrole_concurrency_20260930(p_action text,p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,firstrole_concurrency_qa20260930 as $$
declare v_id uuid; v_body jsonb; v_guard jsonb; v_spent numeric;
begin
  -- Fixed action whitelist. No SQL, schema, table, kind, host, or amount is caller-controlled.
  if p_action in ('reset-normal','reset-boundary') then
    truncate firstrole_concurrency_qa20260930.budget_ledger,
      firstrole_concurrency_qa20260930.provider_operations,
      firstrole_concurrency_qa20260930.search_runs,
      firstrole_concurrency_qa20260930.daily_usage,
      firstrole_concurrency_qa20260930.search_cache,
      firstrole_concurrency_qa20260930.budget_guard restart identity;
    -- The boundary fixture starts with fictional opening expenditure, only in QA.
    v_spent:=case when p_action='reset-boundary' then 9.997 else 0 end;
    insert into firstrole_concurrency_qa20260930.budget_guard(singleton,limit_usd,spent_usd,reserved_usd,enabled)
    values(true,10,v_spent,0,true);
    return jsonb_build_object('qaOnly',true,'reset',true);
  elsif p_action='create' then
    v_id:=(p_args->>'id')::uuid;
    v_body:=jsonb_build_object('id',v_id,'status','queued','cached',false,'results','[]'::jsonb,'createdAt',now(),'updatedAt',now());
    return firstrole_concurrency_qa20260930.create_search_run(v_id,repeat('a',64),null,'fictional-qa-guest',repeat('b',64),'fictional-qa-query',v_body,false,'same-qa-request');
  elsif p_action='reserve' then
    return firstrole_concurrency_qa20260930.reserve_provider_operation((p_args->>'runId')::uuid,p_args->>'operationKey','fetch',1,'fictional-qa.example.invalid');
  elsif p_action='claim' then
    return firstrole_concurrency_qa20260930.claim_provider_operation((p_args->>'operationId')::uuid,p_args->>'claimToken');
  elsif p_action='stats' then
    select jsonb_build_object('limit',limit_usd,'spent',spent_usd,'reserved',reserved_usd) into v_guard
    from firstrole_concurrency_qa20260930.budget_guard where singleton;
    return jsonb_build_object('qaOnly',true,'guard',v_guard,
      'searches',(select count(*) from firstrole_concurrency_qa20260930.search_runs),
      'operations',(select count(*) from firstrole_concurrency_qa20260930.provider_operations),
      'ledgerEntries',(select count(*) from firstrole_concurrency_qa20260930.budget_ledger),
      'totalSearchAdmissions',(select coalesce(sum(searches),0) from firstrole_concurrency_qa20260930.daily_usage where key_kind='actor'),
      'exactSourceCopies',(select count(*)=3 and bool_and(source_hash=clone_hash) from firstrole_concurrency_qa20260930.provenance));
  end if;
  raise exception 'Unsupported isolated QA action';
end $$;
revoke all on function public.qa_firstrole_concurrency_20260930(text,jsonb) from public,anon,authenticated;
grant execute on function public.qa_firstrole_concurrency_20260930(text,jsonb) to service_role;
commit;
