-- Isolated test transaction; no provider requests, production credentials or live funds.
begin;
create function public.enrichment_test_assert(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end;
$$;
create function public.enrichment_test_run() returns uuid language plpgsql as $$
declare v_id uuid:=gen_random_uuid();
begin
  insert into public.search_runs(id,guest_id,actor_key,network_key,idempotency_key,fingerprint,payload)
  values(v_id,'enrichment-test',repeat('t',64),repeat('n',64),v_id::text,'enrichment-test',jsonb_build_object('id',v_id,'status','reading','cached',false,'results','[]'::jsonb));
  return v_id;
end; $$;
create temporary table enrichment_baseline as select to_jsonb(g) as guard from public.budget_guard g;
create temporary table enrichment_fixture (run_id uuid,or_id uuid,or_token uuid,fc_id uuid,fc_token uuid);

select public.enrichment_test_assert((select count(*)=2 and bool_and(not enabled) from public.enrichment_budgets),'optional guards start disabled');
select public.enrichment_test_assert(public.put_enrichment_provider_proof('openrouter',repeat('a',64),jsonb_build_object(
  'model','google/gemma-4-26b-a4b-it','providerSlug','reka','zeroDataRetention',true,'inputPricePerMillion',0.06,'outputPricePerMillion',0.20,'verifiedAt',now())) is not null,'verified Gemma/Reka proof');
select public.enrichment_test_assert(public.put_enrichment_provider_proof('firecrawl',repeat('b',64),jsonb_build_object('freeOnly',true,'remainingCredits',1025,'verifiedAt',now())) is not null,'verified free Firecrawl proof');
select public.enrichment_test_assert((select bool_and(not enabled) from public.enrichment_budgets),'proof never enables spending');

set local role anon;
do $$ begin
  begin perform * from public.enrichment_budgets; raise exception 'public budget access'; exception when insufficient_privilege then null; end;
  begin perform public.get_enrichment_provider_proof('openrouter',repeat('a',64)); raise exception 'public proof RPC access'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$ begin
  begin perform * from public.enrichment_operations; raise exception 'authenticated operation access'; exception when insufficient_privilege then null; end;
  begin perform public.admit_enrichment_operation(gen_random_uuid(),'firecrawl','test',gen_random_uuid()); raise exception 'authenticated admission access'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role service_role;
do $$ begin
  begin update public.enrichment_budgets set spent_usd=0; raise exception 'service could reset amounts'; exception when insufficient_privilege then null; end;
  begin delete from public.enrichment_ledger; raise exception 'service could delete ledger'; exception when insufficient_privilege then null; end;
end $$;
update public.enrichment_budgets set enabled=true;
reset role;

do $$ declare v_run uuid:=public.enrichment_test_run(); v jsonb; v_token uuid:=gen_random_uuid(); v_fc_token uuid:=gen_random_uuid(); v_or uuid; v_fc uuid; begin
  v:=public.admit_enrichment_operation(v_run,'openrouter','wrong-key',v_token,'google/gemma-4-26b-a4b-it',63096,1800,0.06,0.20,now(),repeat('c',64));
  perform public.enrichment_test_assert(v->>'reason'='optional_provider_proof_required','rotated key cannot inherit proof');
  v:=public.admit_enrichment_operation(v_run,'openrouter','too-large',v_token,'google/gemma-4-26b-a4b-it',64001,1800,0.06,0.20,now(),repeat('a',64));
  perform public.enrichment_test_assert(v->>'reason'='model_rates_or_bound_unverified','byte cap');
  v:=public.admit_enrichment_operation(v_run,'openrouter','too-long',v_token,'google/gemma-4-26b-a4b-it',63096,1801,0.06,0.20,now(),repeat('a',64));
  perform public.enrichment_test_assert(v->>'reason'='model_rates_or_bound_unverified','output cap');
  v:=public.admit_enrichment_operation(v_run,'openrouter','stale',v_token,'google/gemma-4-26b-a4b-it',63096,1800,0.06,0.20,now()-interval '25 hours',repeat('a',64));
  perform public.enrichment_test_assert(v->>'reason'='model_rates_or_bound_unverified','stale client proof');
  v:=public.admit_enrichment_operation(v_run,'openrouter','model',v_token,'some-other-model',63096,1800,0.06,0.20,now(),repeat('a',64));
  perform public.enrichment_test_assert(v->>'reason'='model_rates_or_bound_unverified','model locked');
  v:=public.admit_enrichment_operation(v_run,'openrouter','price',v_token,'google/gemma-4-26b-a4b-it',63096,1800,0.11,0.20,now(),repeat('a',64));
  perform public.enrichment_test_assert(v->>'reason'='model_rates_or_bound_unverified','rate cap');
  v:=public.admit_enrichment_operation(v_run,'openrouter','extract-1',v_token,'google/gemma-4-26b-a4b-it',63096,1800,0.06,0.20,now(),repeat('a',64));
  perform public.enrichment_test_assert((v->>'admitted')::boolean,'bounded extraction admitted'); v_or:=(v->>'operationId')::uuid;
  perform public.enrichment_test_assert((select reserved_usd=0.01 and spent_usd=0 and dispatches=1 from public.enrichment_budgets where provider='openrouter'),'fixed conservative reservation');
  v:=public.admit_enrichment_operation(v_run,'openrouter','extract-1',gen_random_uuid(),'google/gemma-4-26b-a4b-it',63096,1800,0.06,0.20,now(),repeat('a',64));
  perform public.enrichment_test_assert(not (v->>'admitted')::boolean and (v->>'reused')::boolean,'replay never gives another dispatch claim');
  v:=public.admit_enrichment_operation(v_run,'firecrawl','read-1',v_fc_token,p_key_fingerprint=>repeat('b',64));
  perform public.enrichment_test_assert((v->>'admitted')::boolean,'free reader admitted'); v_fc:=(v->>'operationId')::uuid;
  v:=public.admit_enrichment_operation(v_run,'firecrawl','read-2',gen_random_uuid(),p_key_fingerprint=>repeat('b',64));
  perform public.enrichment_test_assert(v->>'reason'='search_optional_limit','two TOTAL optional operations across providers');
  insert into enrichment_fixture values(v_run,v_or,v_token,v_fc,v_fc_token);
end $$;

do $$ declare f record; v jsonb; begin
  select * into f from enrichment_fixture;
  v:=public.settle_enrichment_operation(f.or_id,f.or_token,'completed',0.0003,null,false,'generation-one');
  perform public.enrichment_test_assert(v->>'state'='needs_reconciliation','unconfirmed cost retains hold even after completion');
  perform public.enrichment_test_assert((select reserved_usd=0.01 from public.enrichment_budgets where provider='openrouter'),'dollars held');
  v:=public.settle_enrichment_operation(f.or_id,gen_random_uuid(),'completed',0.0003,null,true,'generation-one');
  perform public.enrichment_test_assert(v->>'reason'='claim_mismatch','only operation claimant may reconcile');
  v:=public.settle_enrichment_operation(f.or_id,f.or_token,'completed',0.000321123456,null,true,'generation-one');
  perform public.enrichment_test_assert((v->>'settled')::boolean,'authoritative usage settles');
  perform public.enrichment_test_assert((select reserved_usd=0 and spent_usd=0.000321123456 from public.enrichment_budgets where provider='openrouter'),'exact decimal usage preserved');
  v:=public.settle_enrichment_operation(f.or_id,f.or_token,'completed',0,null,true,'generation-one');
  perform public.enrichment_test_assert((v->>'reused')::boolean,'settlement cannot be replayed to refund confirmed spend');
  perform public.enrichment_test_assert((select count(*)=2 from public.enrichment_ledger where operation_id=f.or_id),'one reserve and one settlement');
  v:=public.settle_enrichment_operation(f.fc_id,f.fc_token,'completed',null,null,false,'scrape-one');
  perform public.enrichment_test_assert(v->>'state'='needs_reconciliation','missing free-credit receipt retains unit');
  perform public.enrichment_test_assert((select reserved_units=1 and spent_units=0 and spent_usd=0 from public.enrichment_budgets where provider='firecrawl'),'no invented Firecrawl usage/charge');
end $$;

savepoint optional_money_boundary;
update public.enrichment_budgets set spent_usd=0.99,reserved_usd=0 where provider='openrouter';
do $$ declare v_run uuid:=public.enrichment_test_run(); v jsonb; begin
  v:=public.admit_enrichment_operation(v_run,'openrouter','last-cent',gen_random_uuid(),'google/gemma-4-26b-a4b-it',63096,1800,0.06,0.20,now(),repeat('a',64));
  perform public.enrichment_test_assert((v->>'admitted')::boolean,'last conservative cent fits');
  v:=public.admit_enrichment_operation(v_run,'openrouter','over-one-dollar',gen_random_uuid(),'google/gemma-4-26b-a4b-it',63096,1800,0.06,0.20,now(),repeat('a',64));
  perform public.enrichment_test_assert(v->>'reason'='optional_budget_exhausted','one-dollar total cannot be exceeded by admission');
end $$;
rollback to optional_money_boundary;

savepoint optional_call_boundary;
update public.enrichment_budgets set dispatches=99,spent_units=0,reserved_units=0 where provider='firecrawl';
do $$ declare v_run uuid:=public.enrichment_test_run(); v jsonb; v_id uuid; v_token uuid:=gen_random_uuid(); begin
  v:=public.admit_enrichment_operation(v_run,'firecrawl','last-free-call',v_token,p_key_fingerprint=>repeat('b',64)); v_id:=(v->>'operationId')::uuid;
  perform public.enrichment_test_assert((v->>'admitted')::boolean,'hundredth free dispatch fits');
  v:=public.settle_enrichment_operation(v_id,v_token,'not-started',0,0,true);
  perform public.enrichment_test_assert((v->>'settled')::boolean,'proven zero-credit rejection can reconcile');
  v:=public.admit_enrichment_operation(v_run,'firecrawl','one-too-many',gen_random_uuid(),p_key_fingerprint=>repeat('b',64));
  perform public.enrichment_test_assert(v->>'reason'='optional_dispatch_limit','credit refund never resets lifetime call count');
end $$;
rollback to optional_call_boundary;

savepoint optional_proof_failures;
do $$ declare v jsonb; v_run uuid:=public.enrichment_test_run(); begin
  v:=public.put_enrichment_provider_proof('openrouter',repeat('c',64),jsonb_build_object('model','google/gemma-4-26b-a4b-it','providerSlug','other','zeroDataRetention',true,'inputPricePerMillion',0.06,'outputPricePerMillion',0.20,'verifiedAt',now()));
  perform public.enrichment_test_assert(v is null,'wrong provider route cannot attest');
  v:=public.put_enrichment_provider_proof('openrouter',repeat('c',64),jsonb_build_object('model','google/gemma-4-26b-a4b-it','providerSlug','reka','zeroDataRetention',false,'inputPricePerMillion',0.06,'outputPricePerMillion',0.20,'verifiedAt',now()));
  perform public.enrichment_test_assert(v is null,'zero retention proof required');
  v:=public.put_enrichment_provider_proof('firecrawl',repeat('b',64),jsonb_build_object('freeOnly',true,'remainingCredits',0,'verifiedAt',now()));
  perform public.enrichment_test_assert(v is not null,'zero balance is valid account evidence');
  v:=public.admit_enrichment_operation(v_run,'firecrawl','empty-account',gen_random_uuid(),p_key_fingerprint=>repeat('b',64));
  perform public.enrichment_test_assert(v->>'reason'='optional_account_credits_exhausted','no remaining free credits blocks dispatch');
  update public.enrichment_provider_proofs set expires_at=now()-interval '1 second' where provider='openrouter';
  v:=public.admit_enrichment_operation(v_run,'openrouter','expired-proof',gen_random_uuid(),'google/gemma-4-26b-a4b-it',63096,1800,0.06,0.20,now(),repeat('a',64));
  perform public.enrichment_test_assert(v->>'reason'='optional_provider_proof_required','expired stored proof blocks dispatch');
end $$;
rollback to optional_proof_failures;

savepoint optional_overrun;
do $$ declare v_run uuid:=public.enrichment_test_run(); v jsonb; v_token uuid:=gen_random_uuid(); begin
  v:=public.admit_enrichment_operation(v_run,'openrouter','unexpected-bill',v_token,'google/gemma-4-26b-a4b-it',63096,1800,0.06,0.20,now(),repeat('a',64));
  v:=public.settle_enrichment_operation((v->>'operationId')::uuid,v_token,'completed',0.02,null,true,'unexpected-bill-id');
  perform public.enrichment_test_assert((v->>'providerDisabled')::boolean,'unexpected confirmed overrun disables optional provider');
  perform public.enrichment_test_assert((select not enabled from public.enrichment_budgets where provider='openrouter'),'overrun fail closed');
end $$;
rollback to optional_overrun;

do $$ declare f record; v_before jsonb; v_ops integer; begin
  select * into f from enrichment_fixture;
  select to_jsonb(g) into v_before from public.enrichment_budgets g where provider='firecrawl';
  select count(*) into v_ops from public.enrichment_operations;
  delete from public.search_runs where id=f.run_id;
  perform public.enrichment_test_assert((select count(*)=v_ops from public.enrichment_operations),'deleted search retains financial records');
  perform public.enrichment_test_assert((select run_id is null from public.enrichment_operations where id=f.fc_id),'personal search link removed');
  perform public.enrichment_test_assert((select to_jsonb(g)=v_before from public.enrichment_budgets g where provider='firecrawl'),'deletion cannot release unknown credit hold');
end $$;
select public.enrichment_test_assert((select to_jsonb(g)=b.guard from public.budget_guard g cross join enrichment_baseline b),'TinyFish budget never changed');
select public.enrichment_test_assert((select count(*)=0 from public.provider_operations),'TinyFish provider operations untouched');
select 'Database optional enrichment accounting checks passed' as result;
rollback;
