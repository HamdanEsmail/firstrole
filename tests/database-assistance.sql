-- Isolated PostgreSQL checks only; fixtures and all financial mutations roll back.
begin;
create function public.assistance_assert(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end;
$$;
create function public.assistance_run(p_assisted boolean default true) returns uuid language plpgsql as $$
declare v_id uuid:=gen_random_uuid(); v jsonb;
begin
  v:=public.create_search_run(v_id,md5('actor-'||v_id),null,'qa-'||v_id,md5('network-'||v_id),'qa-'||v_id,
    jsonb_build_object('id',v_id,'status','reading','results','[]'::jsonb,'createdAt',now()),p_assisted,v_id::text);
  if v->>'admitted' is distinct from 'true' then raise exception 'fixture admission failed: %',v; end if;
  return v_id;
end; $$;

-- Additive migration performs no retroactive release and no financial changes.
select public.assistance_assert(
  b.budget=(select to_jsonb(g) from public.budget_guard g where singleton)
  and b.runs=(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]'::jsonb) from public.search_runs r)
  and b.usage=(select coalesce(jsonb_agg(to_jsonb(d) order by key_kind,key_hash,usage_date),'[]'::jsonb) from public.daily_usage d)
  and b.operations=(select coalesce(jsonb_agg(to_jsonb(o) order by id),'[]'::jsonb) from public.provider_operations o)
  and b.ledger=(select coalesce(jsonb_agg(to_jsonb(l) order by id),'[]'::jsonb) from public.budget_ledger l),
  'migration preserves all admission and accounting rows') from public.assistance_test_data b;
select public.assistance_assert(
  p.oid=b.oid and p.proowner=b.proowner and p.proacl::text is not distinct from b.function_acl
  and p.prosecdef=b.prosecdef and p.proconfig::text is not distinct from b.function_config
  and (b.proname='update_search_run' or md5(pg_get_functiondef(p.oid))=b.definition_hash),
  'existing function identities ACLs and unrelated definitions preserved')
from public.assistance_test_functions b join pg_proc p on p.oid=b.oid;
select public.assistance_assert(
  not has_function_privilege('anon','public.release_unused_agent_allowance(uuid)','execute')
  and not has_function_privilege('authenticated','public.release_unused_agent_allowance(uuid)','execute')
  and has_function_privilege('service_role','public.release_unused_agent_allowance(uuid)','execute'),
  'release RPC is service-only');
set local role anon;
do $$ begin
  begin perform public.release_unused_agent_allowance(gen_random_uuid()); raise exception 'public refund'; exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.budget_guard set enabled=true where singleton;

savepoint assistance_budget_denied;
do $$ declare r uuid:=public.assistance_run(); v jsonb; before_guard jsonb; before_payload jsonb;
  original_created jsonb; usage_day date:=(now() at time zone 'UTC')::date; begin
  v:=public.release_unused_agent_allowance(r);
  perform public.assistance_assert(v->>'reason'='run_not_terminal','active admission cannot be refunded');
  update public.budget_guard set spent_usd=9.9;
  v:=public.reserve_provider_operation(r,'denied-agent','agent',1,'denied.example.com');
  perform public.assistance_assert(v->>'reason'='budget_exhausted','scenario actually denies Agent reservation');
  select to_jsonb(g) into before_guard from public.budget_guard g where singleton;
  select payload->'createdAt' into original_created from public.search_runs where id=r;
  v:=public.update_search_run(r,jsonb_build_object('id',r,'status','partial','createdAt','caller-cannot-change','results',
    jsonb_build_array(jsonb_build_object('id','assistance-real-job','sourceUrl','https://careers.example.com/1','checkedAt','2026-09-30T12:00:00Z','title','Preserved catalog'))));
  before_payload:=v;
  perform public.assistance_assert(v->'createdAt'=original_created,'creation timestamp remains server-owned');
  perform public.assistance_assert((select not assisted from public.search_runs where id=r),'terminal update automatically returns unused assistance');
  perform public.assistance_assert((select count(*)=2 and bool_and(d.searches=1 and d.assisted=0) from public.daily_usage d join public.search_runs s on s.id=r and d.usage_date=usage_day and ((d.key_kind='actor' and d.key_hash=s.actor_key) or(d.key_kind='network' and d.key_hash=s.network_key))),'only assistance counters reduced');
  perform public.assistance_assert((select job->>'title'='Preserved catalog' from public.verified_jobs where job_id='assistance-real-job'),'terminal update still indexes real source facts');
  for i in 1..5 loop
    v:=public.release_unused_agent_allowance(r);
    perform public.assistance_assert(v->>'reason'='not_assisted','repeated explicit release is idempotent');
  end loop;
  v:=public.update_search_run(r,jsonb_build_object('id',r,'status','reading','results','[]'::jsonb));
  perform public.assistance_assert(v=before_payload,'late workflow cannot reverse terminal payload');
  perform public.assistance_assert((select to_jsonb(g)=before_guard from public.budget_guard g where singleton),'release never modifies money or guard timestamp');
  perform public.assistance_assert(not exists(select 1 from public.provider_operations where run_id=r),'no provider dispatch invented');
  v:=public.reserve_bounded_agent_operation(r,'too-late','late.example.com',20,0.35);
  perform public.assistance_assert(v->>'reason'='run_inactive','release-first serialization prevents later Agent admission');
end $$;
rollback to assistance_budget_denied;

savepoint assistance_operation_states;
do $$ declare r uuid; v jsonb; op uuid; tok text; scenario text; before_guard jsonb; begin
  foreach scenario in array array['reserved','claimed','unknown','completed','failed','cancelled','cancelled-zero','not-started'] loop
    r:=public.assistance_run(); tok:=gen_random_uuid()::text;
    v:=public.reserve_bounded_agent_operation(r,'agent','state.example.com',20,0.35); op:=(v->>'operationId')::uuid;
    perform public.assistance_assert(op is not null,'fixture operation admitted');
    if scenario<>'reserved' then perform public.claim_provider_operation(op,tok); end if;
    if scenario in ('unknown','completed','failed','cancelled','cancelled-zero','not-started') then
      if scenario not in ('unknown','not-started') then perform public.bind_provider_run(op,tok,'qa-run-'||r); end if;
      perform public.settle_provider_operation(op,tok,case when scenario='cancelled-zero' then 'cancelled' else scenario end,
        case when scenario in ('not-started','cancelled-zero') then 0 when scenario in ('completed','failed','cancelled') then 0.016 else null end,
        scenario<>'unknown',scenario<>'unknown');
    end if;
    select to_jsonb(g) into before_guard from public.budget_guard g where singleton;
    perform public.update_search_run(r,jsonb_build_object('id',r,'status','failed','results','[]'::jsonb));
    perform public.assistance_assert((select assisted=(scenario<>'not-started') from public.search_runs where id=r),'only confirmed not-started operations allow refund: '||scenario);
    perform public.assistance_assert((select to_jsonb(g)=before_guard from public.budget_guard g where singleton),'refund never changes operation money: '||scenario);
    if scenario<>'not-started' then
      v:=public.release_unused_agent_allowance(r);
      perform public.assistance_assert(v->>'reason'='agent_operation_present','actual or ambiguous operations keep admission: '||scenario);
    end if;
    -- Isolated test cleanup avoids consuming active/daily limits in later cases.
    -- Deleting test rows here rolls back; this is never a production operation.
    delete from public.budget_ledger where operation_id=op;
    delete from public.provider_operations where id=op;
    update public.budget_guard set spent_usd=0,reserved_usd=0;
  end loop;
end $$;
rollback to assistance_operation_states;

savepoint assistance_mixed_fallback;
do $$ declare r uuid:=public.assistance_run(); v jsonb; first_op uuid; next_op uuid; tok text:=gen_random_uuid()::text; begin
  v:=public.reserve_bounded_agent_operation(r,'bounded','fallback.example.com',20,0.35); first_op:=(v->>'operationId')::uuid;
  perform public.claim_provider_operation(first_op,tok);
  perform public.settle_provider_operation(first_op,tok,'not-started',0,true,true);
  v:=public.reserve_provider_operation(r,'legacy-fallback','agent',1,'fallback.example.com'); next_op:=(v->>'operationId')::uuid;
  perform public.assistance_assert(next_op is not null,'fallback operation fixture admitted');
  perform public.update_search_run(r,jsonb_build_object('id',r,'status','partial','results','[]'::jsonb));
  perform public.assistance_assert((select assisted from public.search_runs where id=r),'a rejected first attempt cannot hide a real or uncertain fallback');
  v:=public.release_unused_agent_allowance(r);
  perform public.assistance_assert(v->>'reason'='agent_operation_present','all Agent operations must be conclusively not-started');
end $$;
rollback to assistance_mixed_fallback;

savepoint assistance_original_day;
set local timezone='Pacific/Kiritimati';
do $$ declare r uuid:=public.assistance_run(); v jsonb; a text; n text; original_day date:=date '2026-09-28'; begin
  select actor_key,network_key into a,n from public.search_runs where id=r;
  update public.search_runs set created_at='2026-09-28T23:59:59Z'::timestamptz,
    payload=payload||jsonb_build_object('status','partial') where id=r;
  update public.daily_usage set usage_date=original_day where (key_kind='actor' and key_hash=a) or (key_kind='network' and key_hash=n);
  insert into public.daily_usage(key_kind,key_hash,usage_date,searches,assisted) values
    ('actor',a,original_day+1,2,1),('network',n,original_day+1,7,3);
  v:=public.release_unused_agent_allowance(r);
  perform public.assistance_assert((v->>'released')::boolean and v->>'usageDate'='2026-09-28','explicit historical refund uses admission UTC day regardless of session zone');
  perform public.assistance_assert((select count(*)=2 and bool_and(searches=1 and assisted=0) from public.daily_usage where usage_date=original_day),'original day only assistance is returned');
  perform public.assistance_assert((select searches=2 and assisted=1 from public.daily_usage where key_kind='actor' and key_hash=a and usage_date=original_day+1),'later actor day unchanged');
  perform public.assistance_assert((select searches=7 and assisted=3 from public.daily_usage where key_kind='network' and key_hash=n and usage_date=original_day+1),'later network day unchanged');
end $$;
rollback to assistance_original_day;

do $$ declare r uuid; v jsonb; a text; n text; begin
  r:=public.assistance_run();
  perform public.request_search_cancel(r,md5('actor-'||r));
  v:=public.update_search_run(r,jsonb_build_object('id',r,'status','completed','results','[]'::jsonb));
  perform public.assistance_assert(v->>'status'='cancelled' and (select not assisted from public.search_runs where id=r),'cancel fence and already-terminal branch preserve status and refund zero-dispatch admission');
  r:=public.assistance_run();
  update public.search_runs set payload=payload||jsonb_build_object('status','completed','cached',true) where id=r;
  v:=public.release_unused_agent_allowance(r);
  perform public.assistance_assert(v->>'reason'='cached_run','cached run cannot refund unrelated counters');
  r:=public.assistance_run();
  select actor_key,network_key into a,n from public.search_runs where id=r;
  update public.search_runs set payload=payload||jsonb_build_object('status','failed') where id=r;
  delete from public.daily_usage where key_kind='network' and key_hash=n;
  v:=public.release_unused_agent_allowance(r);
  perform public.assistance_assert(v->>'reason'='admission_counters_unavailable','missing counter fails closed');
  perform public.assistance_assert((select assisted=1 from public.daily_usage where key_kind='actor' and key_hash=a) and (select assisted from public.search_runs where id=r),'missing counter cannot partially refund actor');
  r:=public.assistance_run(false);
  perform public.update_search_run(r,jsonb_build_object('id',r,'status','completed','results','[]'::jsonb));
  perform public.assistance_assert((select bool_and(assisted=0 and searches=1) from public.daily_usage where key_hash in (md5('actor-'||r),md5('network-'||r))),'ordinary search counters unchanged');
  perform public.assistance_assert(public.update_search_run(gen_random_uuid(),'{}'::jsonb) is null,'missing-run update behavior retained');
  v:=public.release_unused_agent_allowance(gen_random_uuid());
  perform public.assistance_assert(v->>'reason'='run_missing','missing-run explicit refund is inert');
end $$;

-- Lock ordering plus both serialized outcomes above cover the contention
-- invariant here; this single-connection suite is not a live concurrency test.
select public.assistance_assert(
  position('public.budget_guard' in substring(pg_get_functiondef('public.release_unused_agent_allowance(uuid)'::regprocedure) from 'begin.*'))
    < position('public.search_runs' in substring(pg_get_functiondef('public.release_unused_agent_allowance(uuid)'::regprocedure) from 'begin.*')),
  'release takes budget before run lock');
select 'Database unused assistance, accounting preservation and terminal-update checks passed' as result;
rollback;
