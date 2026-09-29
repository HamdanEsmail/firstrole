-- Run after the migration in an isolated test database. Every fixture rolls back.
begin;
create function public.firstrole_test_assert(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end;
$$;
insert into auth.users(id) values ('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');

-- RLS: ownership, no forged insert, no moving a row, no private tables/RPC access.
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
insert into public.profiles(user_id,preferences) values(auth.uid(),'{"role":"engineering"}');
insert into public.saved_jobs(user_id,job_id,job) values(auth.uid(),'job-one','{"id":"job-one","sourceUrl":"https://example.com/job"}');
select public.firstrole_test_assert((select count(*)=1 from public.saved_jobs),'owner sees saved job');
do $$ begin
  begin insert into public.saved_jobs(user_id,job_id,job) values('22222222-2222-4222-8222-222222222222','forged','{"id":"forged"}'); raise exception 'forged insert accepted';
  exception when insufficient_privilege then null; end;
  begin update public.saved_jobs set user_id='22222222-2222-4222-8222-222222222222' where job_id='job-one'; raise exception 'ownership transfer accepted';
  exception when insufficient_privilege then null; end;
  begin perform * from public.budget_guard; raise exception 'private table readable';
  exception when insufficient_privilege then null; end;
  begin perform public.get_search_cache('anything'); raise exception 'private rpc callable';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select public.firstrole_test_assert((select count(*)=0 from public.saved_jobs),'other account cannot read');
update public.saved_jobs set notes='intrusion';
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select public.firstrole_test_assert((select notes='' from public.saved_jobs where job_id='job-one'),'other account cannot update');
insert into public.saved_jobs(user_id,job_id,job,notes) values(auth.uid(),'job-one','{"id":"job-one"}','guest overwrite') on conflict(user_id,job_id) do nothing;
select public.firstrole_test_assert((select notes='' from public.saved_jobs where job_id='job-one'),'guest import existing account wins');
reset role;

-- Admission and idempotency precede all debits/quotas.
do $$ declare v jsonb; v_id uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; begin
  v:=public.create_search_run(v_id,repeat('a',64),'11111111-1111-4111-8111-111111111111',null,repeat('n',64),'query-one',jsonb_build_object('id',v_id,'status','queued','results','[]'::jsonb,'createdAt',now()),true,'request-one');
  perform public.firstrole_test_assert((v->>'admitted')::boolean,'search admitted');
  v:=public.create_search_run(gen_random_uuid(),repeat('a',64),'11111111-1111-4111-8111-111111111111',null,repeat('n',64),'query-one','{}',true,'request-one');
  perform public.firstrole_test_assert((v->>'reused')::boolean,'idempotent request returns original before validation/quotas');
  perform public.firstrole_test_assert((select searches=1 and assisted=1 from public.daily_usage where key_kind='actor' and key_hash=repeat('a',64)),'replay not counted');
  v:=public.create_search_run(gen_random_uuid(),repeat('a',64),'11111111-1111-4111-8111-111111111111',null,repeat('n',64),'different-query','{}',true,'request-one');
  perform public.firstrole_test_assert(v->>'reason'='idempotency_conflict','same key different request rejected');
  perform public.firstrole_test_assert(public.get_search_run(v_id,repeat('b',64)) is null,'search owner boundary');
  perform public.firstrole_test_assert(public.get_search_run(v_id,repeat('a',64)) is not null,'search visible to owner');
end $$;

-- Search/Fetch are charged per dispatch; each distinct retry reserves separately.
do $$ declare v jsonb; v_op uuid; v_claim jsonb; begin
  v:=public.reserve_provider_operation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','search-1','search',1,null);
  v_op:=(v->>'operationId')::uuid;
  perform public.firstrole_test_assert((v->>'allowed')::boolean,'search reservation');
  v:=public.reserve_provider_operation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','search-1','search',1,null);
  perform public.firstrole_test_assert((v->>'reused')::boolean,'operation reservation is idempotent');
  perform public.firstrole_test_assert((select reserved_usd=0.005 from public.budget_guard),'one reservation');
  v_claim:=public.claim_provider_operation(v_op,repeat('c',32));
  perform public.firstrole_test_assert((v_claim->>'claimed')::boolean,'first dispatch claim');
  v_claim:=public.claim_provider_operation(v_op,repeat('c',32));
  perform public.firstrole_test_assert(not (v_claim->>'claimed')::boolean,'same claimant cannot dispatch twice');
  perform public.firstrole_test_assert((select spent_usd=0.005 and reserved_usd=0 from public.budget_guard),'search charged at dispatch');
  perform public.settle_provider_operation(v_op,repeat('c',32),'failed',null,false);
  perform public.settle_provider_operation(v_op,repeat('c',32),'failed',null,false);
  v:=public.reserve_provider_operation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','fetch-1','fetch',3,'careers.example.com');
  v_op:=(v->>'operationId')::uuid;
  perform public.claim_provider_operation(v_op,repeat('d',32));
  perform public.settle_provider_operation(v_op,repeat('d',32),'completed',null,true);
  perform public.firstrole_test_assert((select spent_usd=0.008 and reserved_usd=0 from public.budget_guard),'fetch charges every URL');
  perform public.firstrole_test_assert((select count(*)=6 from public.budget_ledger),'each event once');
end $$;

-- Agent: pending/ambiguous cancellation never releases money; one claim only.
do $$ declare v jsonb; v_op uuid; v_id uuid; begin
  v:=public.reserve_provider_operation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','agent-1','agent',1,'dynamic.example.com'); v_op:=(v->>'operationId')::uuid;
  perform public.firstrole_test_assert((select reserved_usd=2.50 from public.budget_guard),'agent reserves full ceiling');
  perform public.claim_provider_operation(v_op,repeat('e',32));
  perform public.bind_provider_run(v_op,repeat('e',32),'provider-abc');
  v:=public.settle_provider_operation(v_op,repeat('e',32),'cancelled',null,false);
  perform public.firstrole_test_assert(v->>'state'='needs_reconciliation','ambiguous cancellation stays held');
  perform public.firstrole_test_assert((select reserved_usd=2.50 from public.budget_guard),'reservation retained');
  v:=public.settle_provider_operation(v_op,'wrong-token','completed',0.02,true);
  perform public.firstrole_test_assert(v->>'reason'='claim_mismatch','settlement claim ownership');
  v:=public.settle_provider_operation(v_op,repeat('e',32),'completed',0.02,true,true);
  perform public.firstrole_test_assert((v->>'settled')::boolean,'authoritative cost settles');
  perform public.firstrole_test_assert((select reserved_usd=0 and spent_usd=0.028 from public.budget_guard),'unused reservation released only now');
  v:=public.reserve_provider_operation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','agent-retry','agent',1,'dynamic.example.com');
  perform public.firstrole_test_assert(v->>'reason'='run_agent_limit','agent not resubmitted under new key');
  v_id:=gen_random_uuid();
  v:=public.create_search_run(v_id,repeat('a',64),'11111111-1111-4111-8111-111111111111',null,repeat('n',64),'query-two',jsonb_build_object('id',v_id,'status','queued'),true,'request-two');
  perform public.firstrole_test_assert(v->>'reason'='actor_assisted_limit','one assisted admission per actor/day');
end $$;

-- Guest and network quota limits, cancellation and source throttling.
do $$ declare v jsonb; v_id uuid; i integer; v_cancel uuid; v_op uuid; begin
  for i in 1..4 loop
    v_id:=gen_random_uuid();
    v:=public.create_search_run(v_id,repeat('g',64),null,'guest-one',repeat('x',64),'guest-query',jsonb_build_object('id',v_id,'status','queued'),false,'guest-request-'||i);
    perform public.firstrole_test_assert(case when i<=3 then (v->>'admitted')::boolean else v->>'reason'='actor_daily_limit' end,'guest daily allowance');
    if i=1 then v_cancel:=v_id; end if;
  end loop;
  v:=public.reserve_provider_operation(v_cancel,'cancel-fetch','fetch',1,'cancel.example.com'); v_op:=(v->>'operationId')::uuid;
  perform public.firstrole_test_assert(not public.request_search_cancel(v_cancel,repeat('z',64)),'other guest cannot cancel');
  perform public.firstrole_test_assert(public.request_search_cancel(v_cancel,repeat('g',64)),'owner cancels');
  v:=public.claim_provider_operation(v_op,repeat('f',32));
  perform public.firstrole_test_assert(v->>'reason'='run_inactive','cancel stops pending dispatch');
  v:=public.settle_provider_operation(v_op,null,'not-started',0,true);
  perform public.firstrole_test_assert((v->>'settled')::boolean,'verified not-started reservation released');
  v:=public.reserve_provider_operation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','source-1','fetch',20,'limit.example.com');
  perform public.firstrole_test_assert((v->>'allowed')::boolean,'source within hourly allowance');
  v:=public.reserve_provider_operation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','source-2','fetch',11,'limit.example.com');
  perform public.firstrole_test_assert(v->>'reason'='source_fetch_hourly_limit','source hourly allowance atomic');
end $$;

-- Fresh cache is owner-bound, stores no query/identity, works with disabled spend, costs nothing.
do $$ declare v jsonb; v_id uuid:=gen_random_uuid(); v_before numeric; begin
  perform public.put_search_cache('cached-query','{"results":[{"id":"cached-job"}],"sources":[],"preferences":{"role":"private"},"ownerId":"private"}',1800);
  perform public.firstrole_test_assert(public.put_search_cache('default-ttl','{"results":[]}'),'six-hour cache default accepted');
  perform public.firstrole_test_assert((select expires_at>now()+interval '5 hours' from public.search_cache where fingerprint='default-ttl'),'cache default is six hours');
  perform public.firstrole_test_assert(not public.put_search_cache('too-long','{"results":[]}',21601),'cache TTL cannot exceed six hours');
  perform public.firstrole_test_assert(not (public.get_search_cache('cached-query') ? 'preferences'),'cache strips private preferences');
  select spent_usd+reserved_usd into v_before from public.budget_guard;
  update public.budget_guard set enabled=false;
  v:=public.create_search_run(v_id,repeat('g',64),null,'guest-one',repeat('x',64),'cached-query',jsonb_build_object('id',v_id,'status','queued','cached',true,'results','[{"id":"forged"}]'::jsonb),false,'cache-request');
  perform public.firstrole_test_assert((v->>'admitted')::boolean,'cache works while spending disabled');
  perform public.firstrole_test_assert(v->'run'->'results'->0->>'id'='cached-job','database replaces forged cached result');
  perform public.firstrole_test_assert((select searches=3 from public.daily_usage where key_kind='actor' and key_hash=repeat('g',64)),'cache does not increment quotas');
  perform public.firstrole_test_assert((select spent_usd+reserved_usd=v_before from public.budget_guard),'cache no debit');
  perform public.firstrole_test_assert(public.get_search_run(v_id,repeat('g',64)) is not null,'cache result has owner-bound run');
  v:=public.reserve_provider_operation(v_id,'cached-extra','search',1,null);
  perform public.firstrole_test_assert(v->>'reason'='run_inactive','cache run cannot spend');
  update public.budget_guard set enabled=true;
end $$;

-- Budget boundaries reject before a provider call; deleting accounts removes content but not spend.
do $$ declare v jsonb; v_before numeric; v_ops integer; begin
  update public.budget_guard set limit_usd=spent_usd+reserved_usd+0.004;
  v:=public.reserve_provider_operation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','over-budget','search',1,null);
  perform public.firstrole_test_assert(v->>'reason'='budget_exhausted','cannot cross lifetime envelope');
  select spent_usd+reserved_usd into v_before from public.budget_guard;
  select count(*) into v_ops from public.provider_operations;
  delete from auth.users where id='11111111-1111-4111-8111-111111111111';
  perform public.firstrole_test_assert(not exists(select 1 from public.saved_jobs where user_id='11111111-1111-4111-8111-111111111111'),'account delete removes saved jobs');
  perform public.firstrole_test_assert(not exists(select 1 from public.profiles where user_id='11111111-1111-4111-8111-111111111111'),'account delete removes preferences');
  perform public.firstrole_test_assert(not exists(select 1 from public.search_runs where owner_id='11111111-1111-4111-8111-111111111111'),'account delete removes private history');
  perform public.firstrole_test_assert((select count(*)=v_ops from public.provider_operations),'account delete preserves budget operations');
  perform public.firstrole_test_assert((select spent_usd+reserved_usd=v_before from public.budget_guard),'account delete cannot reset budget');
end $$;
select 'Database acceptance checks passed' as result;
rollback;
