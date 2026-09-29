begin;
create function public.firstrole_test_assert(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end;
$$;
create function public.firstrole_test_run(actor text,network text,assisted boolean default true,owner_id uuid default null) returns uuid language plpgsql as $$
declare v_id uuid:=gen_random_uuid(); v jsonb;
begin
  v:=public.create_search_run(v_id,md5(actor),owner_id,case when owner_id is null then actor else null end,md5(network),'fp-'||v_id,jsonb_build_object('id',v_id,'status','queued','results','[]'::jsonb,'createdAt',now()),assisted,'request-'||v_id);
  if v->>'admitted'<>'true' then raise exception 'fixture admission failed: %',v; end if;
  return v_id;
end; $$;

do $$ declare a uuid; b uuid; c uuid; d uuid; e uuid; op_a uuid; op_b uuid; v jsonb; begin
  a:=public.firstrole_test_run('agent-a','network-a');
  b:=public.firstrole_test_run('agent-b','network-b');
  c:=public.firstrole_test_run('agent-c','network-c');
  v:=public.reserve_provider_operation(a,'agent','agent',1,'a.example.com'); op_a:=(v->>'operationId')::uuid;
  v:=public.reserve_provider_operation(b,'same-source','agent',1,'a.example.com');
  perform public.firstrole_test_assert(v->>'reason'='source_agent_concurrency','one active agent per host');
  v:=public.reserve_provider_operation(b,'agent','agent',1,'b.example.com'); op_b:=(v->>'operationId')::uuid;
  v:=public.reserve_provider_operation(c,'agent','agent',1,'c.example.com');
  perform public.firstrole_test_assert(v->>'reason'='global_agent_concurrency','two active agents globally');
  perform public.claim_provider_operation(op_a,repeat('a',32));
  v:=public.settle_provider_operation(op_a,repeat('a',32),'completed',null,false,true);
  perform public.firstrole_test_assert(v->>'state'='needs_reconciliation','terminal does not invent cost');
  perform public.firstrole_test_assert((select reserved_usd=5 from public.budget_guard),'confirmed terminal retains dollars');
  v:=public.reserve_provider_operation(c,'agent','agent',1,'c.example.com');
  perform public.firstrole_test_assert((v->>'allowed')::boolean,'confirmed terminal frees active slot');
  perform public.settle_provider_operation((v->>'operationId')::uuid,null,'not-started',0,true,true);
  perform public.claim_provider_operation(op_b,repeat('b',32));
  perform public.settle_provider_operation(op_b,repeat('b',32),'completed',0.1,true,true);
  d:=public.firstrole_test_run('agent-d','network-d');
  v:=public.reserve_provider_operation(d,'agent','agent',1,'d.example.com');
  perform public.claim_provider_operation((v->>'operationId')::uuid,repeat('d',32));
  perform public.settle_provider_operation((v->>'operationId')::uuid,repeat('d',32),'completed',0.1,true,true);
  e:=public.firstrole_test_run('agent-e','network-e');
  v:=public.reserve_provider_operation(e,'schema','agent',1,'e.example.com');
  perform public.claim_provider_operation((v->>'operationId')::uuid,repeat('e',32));
  perform public.settle_provider_operation((v->>'operationId')::uuid,repeat('e',32),'not-started',0,true,true);
  v:=public.reserve_provider_operation(e,'without-schema','agent',1,'e.example.com');
  perform public.firstrole_test_assert((v->>'allowed')::boolean,'authoritative pre-execution rejection permits fallback');
  perform public.claim_provider_operation((v->>'operationId')::uuid,repeat('f',32));
  perform public.settle_provider_operation((v->>'operationId')::uuid,repeat('f',32),'completed',0.1,true,true);
  v:=public.reserve_provider_operation(c,'after-cap','agent',1,'c.example.com');
  perform public.firstrole_test_assert(v->>'reason'='global_agent_daily_limit','four paid agent starts daily');
  perform public.firstrole_test_assert((select reserved_usd=(select sum(reserved_usd) from public.provider_operations) and spent_usd=(select sum(charged_usd) from public.provider_operations) from public.budget_guard),'ledger and operations reconcile');
end $$;

do $$ declare i integer; v_id uuid; v jsonb; begin
  for i in 1..21 loop
    v_id:=gen_random_uuid();
    v:=public.create_search_run(v_id,md5('network-actor-'||i),null,'guest-'||i,md5('shared-network'),'query',jsonb_build_object('id',v_id,'status','queued'),false,'net-'||i);
    perform public.firstrole_test_assert(case when i<=20 then (v->>'admitted')::boolean else v->>'reason'='network_daily_limit' end,'network daily search allowance');
  end loop;
  for i in 1..4 loop
    v_id:=gen_random_uuid();
    v:=public.create_search_run(v_id,md5('assist-actor-'||i),null,'assist-guest-'||i,md5('assisted-shared-network'),'query',jsonb_build_object('id',v_id,'status','queued'),true,'net-assist-'||i);
    perform public.firstrole_test_assert(case when i<=3 then (v->>'admitted')::boolean else v->>'reason'='network_assisted_limit' end,'network assisted allowance');
  end loop;
end $$;

insert into auth.users(id) values('33333333-3333-4333-8333-333333333333');
do $$ declare i integer; v_id uuid; v jsonb; begin
  for i in 1..11 loop
    v_id:=gen_random_uuid();
    v:=public.create_search_run(v_id,md5('signed-daily'),'33333333-3333-4333-8333-333333333333',null,md5('signed-network'),'query',jsonb_build_object('id',v_id,'status','queued'),false,'signed-'||i);
    perform public.firstrole_test_assert(case when i<=10 then (v->>'admitted')::boolean else v->>'reason'='actor_daily_limit' end,'signed-in daily allowance');
  end loop;
end $$;
do $$ declare v_id uuid; v jsonb; v_op uuid; begin
  v_id:=public.firstrole_test_run('verified-owner','verified-network',false,'33333333-3333-4333-8333-333333333333');
  perform public.update_search_run(v_id,jsonb_build_object('id',v_id,'status','completed','results','[{"id":"trusted-job","sourceUrl":"https://careers.example.com/real"}]'::jsonb));
  insert into public.saved_jobs(user_id,job_id,job) values('33333333-3333-4333-8333-333333333333','trusted-job','{"id":"trusted-job","sourceUrl":"http://127.0.0.1/tampered"}');
  v:=public.get_authorized_job('trusted-job',md5('verified-owner'),null,'33333333-3333-4333-8333-333333333333');
  perform public.firstrole_test_assert(v->>'sourceUrl'='https://careers.example.com/real','saved refresh uses server-verified source');
  v_id:=public.firstrole_test_run('delete-owner','delete-network',false,'33333333-3333-4333-8333-333333333333');
  v:=public.reserve_provider_operation(v_id,'pending','search',1,null); v_op:=(v->>'operationId')::uuid;
  perform public.cancel_user_searches('33333333-3333-4333-8333-333333333333');
  v:=public.claim_provider_operation(v_op,repeat('q',32));
  perform public.firstrole_test_assert(v->>'reason'='run_inactive','account deletion fence prevents new claims');
end $$;
select 'Database limits and source-authority checks passed' as result;
rollback;
