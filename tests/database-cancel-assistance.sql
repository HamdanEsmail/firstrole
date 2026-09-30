begin;
create function public.cancel_assistance_assert(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end;
$$;
create function public.cancel_assistance_run() returns uuid language plpgsql as $$
declare r uuid:=gen_random_uuid(); v jsonb;
begin
  v:=public.create_search_run(r,md5('actor-'||r),null,'qa-'||r,md5('network-'||r),'qa-'||r,
    jsonb_build_object('id',r,'status','reading','results','[]'::jsonb),true,r::text);
  if v->>'admitted' is distinct from 'true' then raise exception 'fixture admission failed: %',v; end if;
  return r;
end; $$;
select public.cancel_assistance_assert(
  p.oid=b.oid and p.proowner=b.proowner and p.proacl::text is not distinct from b.function_acl
  and p.prosecdef=b.prosecdef and p.proconfig::text is not distinct from b.function_config
  and b.release_definition=md5(pg_get_functiondef('public.release_unused_agent_allowance(uuid)'::regprocedure))
  and b.update_definition=md5(pg_get_functiondef('public.update_search_run(uuid,jsonb)'::regprocedure)),
  'cancellation identity ACL and other function definitions preserved')
from public.cancel_assistance_baseline b join pg_proc p on p.oid=b.oid;
select public.cancel_assistance_assert(
  b.budget=(select to_jsonb(g) from public.budget_guard g where singleton)
  and b.usage_rows=(select count(*) from public.daily_usage)
  and b.runs=(select count(*) from public.search_runs)
  and b.operations=(select count(*) from public.provider_operations)
  and b.ledger=(select count(*) from public.budget_ledger),
  'migration does not change stored data') from public.cancel_assistance_baseline b;
select public.cancel_assistance_assert(
  not has_function_privilege('anon','public.request_search_cancel(uuid,text)','execute')
  and not has_function_privilege('authenticated','public.request_search_cancel(uuid,text)','execute')
  and has_function_privilege('service_role','public.request_search_cancel(uuid,text)','execute'),
  'cancellation RPC stays service-only');
update public.budget_guard set enabled=true where singleton;

do $$ declare r uuid:=public.cancel_assistance_run(); v jsonb; before_guard jsonb; begin
  select to_jsonb(g) into before_guard from public.budget_guard g where singleton;
  perform public.cancel_assistance_assert(not public.request_search_cancel(r,md5('other-actor')),'different actor cannot cancel');
  perform public.cancel_assistance_assert((select assisted and not cancel_requested from public.search_runs where id=r),'different actor cannot refund');
  perform public.cancel_assistance_assert(public.request_search_cancel(r,md5('actor-'||r)),'first authorized cancellation keeps true return value');
  perform public.cancel_assistance_assert((select cancel_requested and not assisted and payload->>'status'='cancelled' and payload->>'stage'='Search cancelled' from public.search_runs where id=r),'cancel before Agent immediately returns unused assistance');
  perform public.cancel_assistance_assert((select count(*)=2 and bool_and(searches=1 and assisted=0) from public.daily_usage where key_hash in(md5('actor-'||r),md5('network-'||r))),'only assisted counters return');
  perform public.cancel_assistance_assert(not public.request_search_cancel(r,md5('actor-'||r)),'repeated cancellation keeps false return value');
  v:=public.release_unused_agent_allowance(r);
  perform public.cancel_assistance_assert(v->>'reason'='not_assisted','explicit release replay cannot return another allowance');
  v:=public.reserve_bounded_agent_operation(r,'late','cancel-first.example.com',20,0.35);
  perform public.cancel_assistance_assert(v->>'reason'='run_inactive','cancel-first serialization prevents new dispatch');
  perform public.cancel_assistance_assert((select to_jsonb(g)=before_guard from public.budget_guard g where singleton),'cancel and refund leave financial guard unchanged');
  perform public.cancel_assistance_assert(not public.request_search_cancel(gen_random_uuid(),md5('missing')),'missing run preserves false return');
end $$;

savepoint cancel_after_dispatch;
do $$ declare r uuid:=public.cancel_assistance_run(); v jsonb; op uuid; tok text:=gen_random_uuid()::text; before_guard jsonb; begin
  v:=public.reserve_bounded_agent_operation(r,'agent','dispatch-first.example.com',20,0.35); op:=(v->>'operationId')::uuid;
  perform public.claim_provider_operation(op,tok);
  select to_jsonb(g) into before_guard from public.budget_guard g where singleton;
  perform public.cancel_assistance_assert(public.request_search_cancel(r,md5('actor-'||r)),'cancel after dispatch still succeeds');
  perform public.cancel_assistance_assert((select assisted and cancel_requested from public.search_runs where id=r),'ambiguous or actual dispatch keeps assisted allowance');
  perform public.cancel_assistance_assert((select count(*)=2 and bool_and(searches=1 and assisted=1) from public.daily_usage where key_hash in(md5('actor-'||r),md5('network-'||r))),'dispatch-first serialization preserves both counters');
  perform public.cancel_assistance_assert((select to_jsonb(g)=before_guard from public.budget_guard g where singleton),'cancel after dispatch does not reconcile money');
  perform public.bind_provider_run(op,tok,'cancelled-zero-qa');
  perform public.settle_provider_operation(op,tok,'cancelled',0,true,true);
  v:=public.release_unused_agent_allowance(r);
  perform public.cancel_assistance_assert(v->>'reason'='agent_operation_present','zero-step submitted cancellation still consumes assistance');
end $$;
rollback to cancel_after_dispatch;

do $$ declare r uuid:=public.cancel_assistance_run(); v jsonb; op uuid; tok text:=gen_random_uuid()::text; begin
  v:=public.reserve_bounded_agent_operation(r,'agent','not-started.example.com',20,0.35); op:=(v->>'operationId')::uuid;
  perform public.claim_provider_operation(op,tok);
  perform public.settle_provider_operation(op,tok,'not-started',0,true,true);
  perform public.cancel_assistance_assert(public.request_search_cancel(r,md5('actor-'||r)),'cancel after conclusive rejection succeeds');
  perform public.cancel_assistance_assert((select not assisted from public.search_runs where id=r),'only confirmed not-started attempt permits cancellation refund');
  r:=public.cancel_assistance_run();
  perform public.update_search_run(r,jsonb_build_object('id',r,'status','completed','results','[]'::jsonb));
  perform public.cancel_assistance_assert(not public.request_search_cancel(r,md5('actor-'||r)),'completed run remains completed');
  perform public.cancel_assistance_assert((select payload->>'status'='completed' and not cancel_requested from public.search_runs where id=r),'cancellation cannot overwrite terminal result');
end $$;
select 'Database cancellation unused-assistance and preservation checks passed' as result;
rollback;
