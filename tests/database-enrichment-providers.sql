begin;
create function public.enrichment_provider_test_assert(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end;
$$;

select public.enrichment_provider_test_assert(
  (select jsonb_agg(to_jsonb(b) order by provider) from public.enrichment_budgets b)=(select budgets from public.enrichment_allowlist_test_baseline),
  'allowlist migration preserves optional budget rows');
select public.enrichment_provider_test_assert(
  (select to_jsonb(b) from public.budget_guard b where singleton)=(select tinyfish_budget from public.enrichment_allowlist_test_baseline),
  'allowlist migration preserves TinyFish budget');
select public.enrichment_provider_test_assert(
  (select to_jsonb(p) from public.enrichment_provider_proofs p where provider='openrouter' and key_fingerprint=repeat('9',64))=(select existing_proof from public.enrichment_allowlist_test_baseline),
  'allowlist migration preserves existing Reka proof');
select public.enrichment_provider_test_assert(
  (select proacl::text from pg_proc where oid='public.put_enrichment_provider_proof(text,text,jsonb)'::regprocedure) is not distinct from (select function_acl from public.enrichment_allowlist_test_baseline),
  'function ACL unchanged');

do $$ declare slug text; v jsonb; key text; base jsonb; bad jsonb; begin
  foreach slug in array array['reka','nextbit/bf16','deepinfra/fp8'] loop
    key:=md5(slug)||md5(slug);
    base:=jsonb_build_object('model','google/gemma-4-26b-a4b-it','providerSlug',slug,'zeroDataRetention',true,
      'inputPricePerMillion',0.0765,'outputPricePerMillion',0.255,'verifiedAt',now(),'unexpectedPrivateField','must not persist');
    v:=public.put_enrichment_provider_proof('openrouter',key,base);
    perform public.enrichment_provider_test_assert(v is not null and v->>'providerSlug'=slug,'exact allowed slug retained');
    perform public.enrichment_provider_test_assert(not(v?'unexpectedPrivateField'),'proof remains sanitized');
    perform public.enrichment_provider_test_assert((v->>'inputPricePerMillion')::numeric=0.0765 and (v->>'outputPricePerMillion')::numeric=0.255,'actual validated prices retained');
    perform public.enrichment_provider_test_assert((v->>'expiresAt')::timestamptz<=(v->>'verifiedAt')::timestamptz+interval '6 hours','TTL unchanged');
    foreach bad in array array[
      jsonb_build_object('model','another/model'),
      jsonb_build_object('zeroDataRetention',false),
      jsonb_build_object('zeroDataRetention','true'),
      jsonb_build_object('inputPricePerMillion',0.1001),
      jsonb_build_object('outputPricePerMillion',0.4001),
      jsonb_build_object('inputPricePerMillion',-1),
      jsonb_build_object('inputPricePerMillion','NaN'),
      jsonb_build_object('verifiedAt',now()-interval '6 hours'),
      jsonb_build_object('verifiedAt',now()+interval '61 seconds')
    ] loop
      perform public.enrichment_provider_test_assert(public.put_enrichment_provider_proof('openrouter',key,base||bad) is null,'all old price/privacy/freshness constraints apply to each route');
      perform public.enrichment_provider_test_assert(public.get_enrichment_provider_proof('openrouter',key)->>'providerSlug'=slug,'rejection does not rewrite valid route');
    end loop;
  end loop;
  base:=jsonb_build_object('model','google/gemma-4-26b-a4b-it','zeroDataRetention',true,
    'inputPricePerMillion',0.06,'outputPricePerMillion',0.20,'verifiedAt',now());
  foreach slug in array array['nextbit','deepinfra','reka/bf16','NEXTBIT/bf16',' nextbit/bf16 ','arbitrary-provider','nextbit/bf16,deepinfra/fp8'] loop
    perform public.enrichment_provider_test_assert(public.put_enrichment_provider_proof('openrouter',repeat('8',64),base||jsonb_build_object('providerSlug',slug)) is null,'only exact allowlisted routes accepted');
  end loop;
  perform public.enrichment_provider_test_assert(public.put_enrichment_provider_proof('openrouter',repeat('8',64),base) is null,'missing slug rejected');
  perform public.enrichment_provider_test_assert(public.put_enrichment_provider_proof('openrouter','invalid-key',base||jsonb_build_object('providerSlug','reka')) is null,'key binding unchanged');
  v:=public.put_enrichment_provider_proof('firecrawl',repeat('7',64),jsonb_build_object('freeOnly',true,'remainingCredits',1025,'verifiedAt',now(),'providerSlug','not relevant'));
  perform public.enrichment_provider_test_assert(v is not null and not(v?'providerSlug') and (v->>'remainingCredits')::integer=1025,'Firecrawl proof unchanged and sanitized');
end $$;

set local role anon;
do $$ begin
  begin perform public.put_enrichment_provider_proof('openrouter',repeat('8',64),'{}'); raise exception 'anonymous mutation allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$ begin
  begin perform public.put_enrichment_provider_proof('openrouter',repeat('8',64),'{}'); raise exception 'authenticated mutation allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;

select public.enrichment_provider_test_assert((select count(*)=0 from public.enrichment_operations),'no operation is created by proof update');
select public.enrichment_provider_test_assert((select count(*)=0 from public.enrichment_ledger),'no ledger change from proof update');
select 'Database optional-provider allowlist and preservation checks passed' as result;
rollback;
