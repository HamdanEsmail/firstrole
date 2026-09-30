-- Test-only state captured before migration 6 to prove replacement preserves rows/ACL.
select public.put_enrichment_provider_proof('openrouter',repeat('9',64),jsonb_build_object(
  'model','google/gemma-4-26b-a4b-it','providerSlug','reka','zeroDataRetention',true,
  'inputPricePerMillion',0.06,'outputPricePerMillion',0.20,'verifiedAt',now()));
create table public.enrichment_allowlist_test_baseline as select
  (select jsonb_agg(to_jsonb(b) order by provider) from public.enrichment_budgets b) budgets,
  (select to_jsonb(b) from public.budget_guard b where singleton) tinyfish_budget,
  (select to_jsonb(p) from public.enrichment_provider_proofs p where provider='openrouter' and key_fingerprint=repeat('9',64)) existing_proof,
  (select proacl::text from pg_proc where oid='public.put_enrichment_provider_proof(text,text,jsonb)'::regprocedure) function_acl;
