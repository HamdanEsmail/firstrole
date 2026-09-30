-- Replace only proof validation. No balances, existing proofs, operations,
-- ledger entries, tables, RLS, or function privileges are changed.
-- Same Gemma model, USD ceilings, zero-retention requirement, key binding and TTL.
begin;
create or replace function public.put_enrichment_provider_proof(p_provider text,p_key_fingerprint text,p_proof jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_asof timestamptz; v_verified timestamptz; v_proof jsonb; v_input numeric; v_output numeric; v_remaining integer; v_slug text;
begin
  if p_provider is null or p_provider not in ('openrouter','firecrawl') or p_key_fingerprint is null or p_key_fingerprint !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_proof) is distinct from 'object' or octet_length(p_proof::text)>4096 then return null; end if;
  v_asof:=(p_proof->>'verifiedAt')::timestamptz;
  if v_asof is null or v_asof>now()+interval '60 seconds' or v_asof<=now()-interval '6 hours' then return null; end if;
  v_verified:=least(v_asof,now());
  if p_provider='openrouter' then
    v_input:=(p_proof->>'inputPricePerMillion')::numeric;
    v_output:=(p_proof->>'outputPricePerMillion')::numeric;
    v_slug:=p_proof->>'providerSlug';
    if p_proof->>'model' is distinct from 'google/gemma-4-26b-a4b-it'
      or v_slug is null or v_slug not in ('reka','nextbit/bf16','deepinfra/fp8')
      or p_proof->'zeroDataRetention' is distinct from 'true'::jsonb or v_input is null or v_output is null
      or v_input not between 0 and 0.10 or v_output not between 0 and 0.40 then return null; end if;
    v_proof:=jsonb_build_object('model','google/gemma-4-26b-a4b-it','providerSlug',v_slug,'zeroDataRetention',true,
      'inputPricePerMillion',v_input,'outputPricePerMillion',v_output);
  else
    v_remaining:=(p_proof->>'remainingCredits')::integer;
    if p_proof->'freeOnly' is distinct from 'true'::jsonb or v_remaining is null or v_remaining<0 then return null; end if;
    v_proof:=jsonb_build_object('freeOnly',true,'remainingCredits',v_remaining);
  end if;
  insert into public.enrichment_provider_proofs(provider,key_fingerprint,proof,verified_at,expires_at)
  values(p_provider,p_key_fingerprint,v_proof,v_verified,v_verified+interval '6 hours')
  on conflict(provider,key_fingerprint) do update set proof=excluded.proof,verified_at=excluded.verified_at,expires_at=excluded.expires_at
  where excluded.verified_at>=public.enrichment_provider_proofs.verified_at;
  return public.get_enrichment_provider_proof(p_provider,p_key_fingerprint);
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
  return null;
end; $$;
-- CREATE OR REPLACE with the unchanged signature preserves the existing ACL.
commit;
