begin;
create function public.bounded_agent_test_assert(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end;
$$;
create function public.bounded_agent_test_run(p_assisted boolean default true) returns uuid language plpgsql as $$
declare v_id uuid:=gen_random_uuid();
begin
  insert into public.search_runs(id,guest_id,actor_key,network_key,idempotency_key,fingerprint,payload,assisted)
  values(v_id,'bounded-agent-qa',repeat('a',64),repeat('n',64),v_id::text,'bounded-agent-qa',jsonb_build_object('id',v_id,'status','reading','results','[]'::jsonb),p_assisted);
  return v_id;
end; $$;
select public.bounded_agent_test_assert((select to_jsonb(b)=(select budget from public.bounded_agent_test_baseline) from public.budget_guard b where singleton),'migration does not change budget');
select public.bounded_agent_test_assert((select md5(pg_get_functiondef('public.reserve_provider_operation(uuid,text,text,integer,text)'::regprocedure))=(select legacy_definition from public.bounded_agent_test_baseline)),'legacy definition unchanged');
select public.bounded_agent_test_assert((select proacl::text is not distinct from (select legacy_acl from public.bounded_agent_test_baseline) from pg_proc where oid='public.reserve_provider_operation(uuid,text,text,integer,text)'::regprocedure),'legacy ACL unchanged');
select public.bounded_agent_test_assert((select count(*)=(select operations from public.bounded_agent_test_baseline) from public.provider_operations),'migration does not rewrite operations');
select public.bounded_agent_test_assert((select count(*)=(select ledger_entries from public.bounded_agent_test_baseline) from public.budget_ledger),'migration does not reconcile ledger');

set local role anon;
do $$ begin
  begin perform public.reserve_bounded_agent_operation(gen_random_uuid(),'agent','example.com',20,0.35); raise exception 'public Agent reservation'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$ begin
  begin perform public.reserve_bounded_agent_operation(gen_random_uuid(),'agent','example.com',20,0.35); raise exception 'authenticated Agent reservation'; exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.budget_guard set enabled=true;

do $$ declare old_run uuid:=public.bounded_agent_test_run(); new_run uuid:=public.bounded_agent_test_run(); extra_run uuid:=public.bounded_agent_test_run();
  old_op uuid; new_op uuid; old_token text:=gen_random_uuid()::text; new_token text:=gen_random_uuid()::text; v jsonb; begin
  v:=public.reserve_provider_operation(old_run,'portal-agent','agent',1,'legacy.example.com'); old_op:=(v->>'operationId')::uuid;
  perform public.bounded_agent_test_assert((v->>'reservedUsd')::numeric=2.5,'old code still reserves 2.50');
  v:=public.reserve_bounded_agent_operation(old_run,'portal-agent','legacy.example.com',20,0.35);
  perform public.bounded_agent_test_assert((v->>'reused')::boolean and (v->>'operationId')::uuid=old_op and (v->>'reservedUsd')::numeric=2.5,'upgrade reuses old hold without resizing it');
  v:=public.reserve_bounded_agent_operation(new_run,'portal-agent','new.example.com',21,0.35);
  perform public.bounded_agent_test_assert(v->>'reason'='invalid_agent_bound','only twenty steps accepted');
  v:=public.reserve_bounded_agent_operation(new_run,'portal-agent','new.example.com',20,0.32);
  perform public.bounded_agent_test_assert(v->>'reason'='invalid_agent_bound','caller cannot reduce reservation');
  v:=public.reserve_bounded_agent_operation(new_run,'portal-agent','new.example.com',20,2.50);
  perform public.bounded_agent_test_assert(v->>'reason'='invalid_agent_bound','new path cannot claim a different bound');
  v:=public.reserve_bounded_agent_operation(new_run,'bounded20:portal-agent','new.example.com',20,0.35);
  perform public.bounded_agent_test_assert(v->>'reason'='invalid_agent_bound','client cannot provide internal namespace');
  v:=public.reserve_bounded_agent_operation(new_run,'portal-agent','legacy.example.com',20,0.35);
  perform public.bounded_agent_test_assert(v->>'reason'='source_agent_concurrency','old and new share hostname concurrency');
  v:=public.reserve_bounded_agent_operation(new_run,'portal-agent','new.example.com',20,0.35); new_op:=(v->>'operationId')::uuid;
  perform public.bounded_agent_test_assert((v->>'reservedUsd')::numeric=0.35,'new path reserves 0.35');
  perform public.bounded_agent_test_assert((select reserved_usd=2.85 from public.budget_guard),'old and new share same guard');
  v:=public.reserve_provider_operation(new_run,'portal-agent','agent',1,'new.example.com');
  perform public.bounded_agent_test_assert(v->>'reason'='run_agent_limit','old unbounded code cannot acquire a smaller new hold');
  v:=public.reserve_bounded_agent_operation(new_run,'portal-agent','new.example.com',20,0.35);
  perform public.bounded_agent_test_assert((v->>'reused')::boolean and (v->>'operationId')::uuid=new_op,'new path idempotency');
  perform public.bounded_agent_test_assert((select count(*)=2 from public.budget_ledger),'replays never debit twice');
  v:=public.reserve_bounded_agent_operation(extra_run,'agent','third.example.com',20,0.35);
  perform public.bounded_agent_test_assert(v->>'reason'='global_agent_concurrency','mixed old and new active count is shared');
  perform public.claim_provider_operation(old_op,old_token);
  perform public.claim_provider_operation(new_op,new_token);
  v:=public.claim_provider_operation(new_op,gen_random_uuid()::text);
  perform public.bounded_agent_test_assert(not(v->>'claimed')::boolean,'new bounded operation claims only once');
  perform public.settle_provider_operation(new_op,new_token,'completed',null,false,true);
  perform public.bounded_agent_test_assert((select reserved_usd=2.85 from public.budget_guard),'terminal without receipt retains both money holds');
  v:=public.reserve_bounded_agent_operation(extra_run,'agent','third.example.com',20,0.35);
  perform public.bounded_agent_test_assert((v->>'allowed')::boolean,'confirmed terminal releases capacity but not dollars');
  perform public.settle_provider_operation((v->>'operationId')::uuid,null,'not-started',0,true,true);
  -- These are synthetic receipts only inside this rolled-back test transaction.
  perform public.settle_provider_operation(old_op,old_token,'completed',0.256,true,true);
  perform public.settle_provider_operation(new_op,new_token,'completed',0.064,true,true);
  perform public.bounded_agent_test_assert((select spent_usd=0.32 and reserved_usd=0 from public.budget_guard),'shared existing reconciliation function handles both hold sizes');
end $$;

savepoint bounded_budget_boundary;
update public.budget_guard set spent_usd=9.65,reserved_usd=0;
do $$ declare v_run uuid:=public.bounded_agent_test_run(); another uuid:=public.bounded_agent_test_run(); v jsonb; begin
  v:=public.reserve_provider_operation(v_run,'old-would-not-fit','agent',1,'budget.example.com');
  perform public.bounded_agent_test_assert(v->>'reason'='budget_exhausted','legacy price remains conservative');
  v:=public.reserve_bounded_agent_operation(v_run,'bounded-fits','budget.example.com',20,0.35);
  perform public.bounded_agent_test_assert((v->>'allowed')::boolean,'bounded reservation fits exact remaining envelope');
  v:=public.reserve_bounded_agent_operation(another,'bounded-over','over.example.com',20,0.35);
  perform public.bounded_agent_test_assert(v->>'reason'='budget_exhausted','new path cannot exceed shared envelope');
  perform public.bounded_agent_test_assert((select spent_usd+reserved_usd=10 from public.budget_guard),'exact shared cap');
end $$;
rollback to bounded_budget_boundary;

savepoint bounded_entitlement_fallback;
do $$ declare v_run uuid:=public.bounded_agent_test_run(); bounded_op uuid; legacy_op uuid;
  tok text:=gen_random_uuid()::text; v jsonb; begin
  v:=public.reserve_bounded_agent_operation(v_run,'portal-agent','fallback.example.com',20,0.35);
  bounded_op:=(v->>'operationId')::uuid;
  perform public.claim_provider_operation(bounded_op,tok);
  -- A documented pre-execution entitlement rejection is the only evidence this
  -- scenario models. Ambiguous network failures may not release the hold.
  v:=public.settle_provider_operation(bounded_op,tok,'not-started',0,true,true);
  perform public.bounded_agent_test_assert((v->>'settled')::boolean,'confirmed entitlement rejection settles bounded operation');
  v:=public.reserve_provider_operation(v_run,'portal-agent-legacy','agent',1,'fallback.example.com');
  legacy_op:=(v->>'operationId')::uuid;
  perform public.bounded_agent_test_assert((v->>'allowed')::boolean and (v->>'reservedUsd')::numeric=2.50 and legacy_op<>bounded_op,'legacy fallback receives its own full reservation');
  perform public.bounded_agent_test_assert((select reserved_usd=2.50 from public.budget_guard),'legacy fallback cannot run against released smaller hold');
end $$;
rollback to bounded_entitlement_fallback;

savepoint bounded_daily_limit;
do $$ declare v_run uuid; v jsonb; tok text; begin
  -- Two completed chargeable operations above plus these two reach four; the
  -- confirmed not-started operation above does not consume the daily count.
  for i in 1..2 loop
    v_run:=public.bounded_agent_test_run(); tok:=gen_random_uuid()::text;
    v:=public.reserve_bounded_agent_operation(v_run,'day-'||i,'day'||i||'.example.com',20,0.35);
    perform public.bounded_agent_test_assert((v->>'allowed')::boolean,'bounded daily allowance shared');
    perform public.claim_provider_operation((v->>'operationId')::uuid,tok);
    perform public.settle_provider_operation((v->>'operationId')::uuid,tok,'completed',0.016,true,true);
  end loop;
  v:=public.reserve_provider_operation(public.bounded_agent_test_run(),'legacy-fifth','agent',1,'day5.example.com');
  perform public.bounded_agent_test_assert(v->>'reason'='global_agent_daily_limit','legacy sees bounded daily starts');
  v:=public.reserve_bounded_agent_operation(public.bounded_agent_test_run(),'bounded-fifth','day5.example.com',20,0.35);
  perform public.bounded_agent_test_assert(v->>'reason'='global_agent_daily_limit','bounded sees legacy daily starts');
end $$;
rollback to bounded_daily_limit;

do $$ declare v_run uuid:=public.bounded_agent_test_run(false); v jsonb; begin
  v:=public.reserve_bounded_agent_operation(v_run,'no-assist','active.example.com',20,0.35);
  perform public.bounded_agent_test_assert(v->>'reason'='assistance_not_admitted','assisted admission still required');
  update public.search_runs set assisted=true,cancel_requested=true where id=v_run;
  v:=public.reserve_bounded_agent_operation(v_run,'cancelled','active.example.com',20,0.35);
  perform public.bounded_agent_test_assert(v->>'reason'='run_inactive','cancellation blocks bounded path');
  update public.budget_guard set enabled=false;
  v:=public.reserve_bounded_agent_operation(public.bounded_agent_test_run(),'disabled','active.example.com',20,0.35);
  perform public.bounded_agent_test_assert(v->>'reason'='search_disabled','same kill switch');
end $$;
select 'Database bounded Agent and mixed legacy checks passed' as result;
rollback;
