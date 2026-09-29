begin;
create function public.firstrole_rates_assert(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end;
$$;

set local role anon;
do $$ begin
  begin perform * from public.provider_rate_attestations; raise exception 'anonymous proof read allowed'; exception when insufficient_privilege then null; end;
  begin perform public.get_provider_rate_attestation(repeat('a',64)); raise exception 'anonymous proof rpc allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$ begin
  begin perform public.claim_provider_rate_refresh(repeat('a',64),gen_random_uuid()); raise exception 'authenticated proof claim allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;

do $$ declare token_a uuid:=gen_random_uuid(); token_b uuid:=gen_random_uuid(); v jsonb; before_guard jsonb; begin
  select to_jsonb(g) into before_guard from public.budget_guard g;
  perform public.firstrole_rates_assert(public.get_provider_rate_attestation(repeat('a',64)) is null,'initial proof missing');
  v:=public.claim_provider_rate_refresh(repeat('a',64),token_a);
  perform public.firstrole_rates_assert(v->>'state'='claimed','first request owns metadata refresh');
  v:=public.claim_provider_rate_refresh(repeat('a',64),token_b);
  perform public.firstrole_rates_assert(v->>'state'='busy','second request cannot race refresh');
  v:=public.complete_provider_rate_refresh(repeat('a',64),token_b,true,now(),0.016,0.005,0.001);
  perform public.firstrole_rates_assert(v is null,'wrong token cannot attest');
  v:=public.complete_provider_rate_refresh(repeat('a',64),token_a,true,now(),0.016,0.005,0.001);
  perform public.firstrole_rates_assert(v->>'state'='verified','valid rates attested');
  perform public.firstrole_rates_assert((v->>'expiresAt')::timestamptz=now()+interval '6 hours','expiry follows provider timestamp');
  v:=public.claim_provider_rate_refresh(repeat('a',64),token_b);
  perform public.firstrole_rates_assert(v->>'state'='ready','existing proof avoids metadata request');
  v:=public.complete_provider_rate_refresh(repeat('a',64),token_a,false);
  perform public.firstrole_rates_assert(v is null,'old response cannot erase successful proof');
  perform public.firstrole_rates_assert(public.get_provider_rate_attestation(repeat('b',64)) is null,'API keys have independent proof');
  perform public.firstrole_rates_assert((select to_jsonb(g)=before_guard from public.budget_guard g),'rate attestation never changes budget');
end $$;

do $$ declare token uuid:=gen_random_uuid(); v jsonb; begin
  perform public.claim_provider_rate_refresh(repeat('b',64),token);
  v:=public.complete_provider_rate_refresh(repeat('b',64),token,true,now(),0.017,0.005,0.001);
  perform public.firstrole_rates_assert(v->>'state'='blocked','elevated rate fails closed');
  v:=public.claim_provider_rate_refresh(repeat('b',64),gen_random_uuid());
  perform public.firstrole_rates_assert(v->>'state'='busy','failed proof has short retry cooldown');
  token:=gen_random_uuid();
  perform public.claim_provider_rate_refresh(repeat('c',64),token);
  v:=public.complete_provider_rate_refresh(repeat('c',64),token,true,now()+interval '61 seconds',0.016,0.005,0.001);
  perform public.firstrole_rates_assert(v->>'state'='blocked','future timestamp rejected');
  token:=gen_random_uuid();
  perform public.claim_provider_rate_refresh(repeat('d',64),token);
  v:=public.complete_provider_rate_refresh(repeat('d',64),token,true,now()-interval '6 hours',0.016,0.005,0.001);
  perform public.firstrole_rates_assert(v->>'state'='blocked','stale timestamp rejected');
  token:=gen_random_uuid();
  perform public.claim_provider_rate_refresh(repeat('e',64),token);
  update public.provider_rate_attestations set refresh_until=now()-interval '1 second' where key_fingerprint=repeat('e',64);
  v:=public.complete_provider_rate_refresh(repeat('e',64),token,true,now(),0.016,0.005,0.001);
  perform public.firstrole_rates_assert(v is null,'expired refresh lease cannot write proof');
  v:=public.claim_provider_rate_refresh(repeat('e',64),gen_random_uuid());
  perform public.firstrole_rates_assert(v->>'state'='claimed','expired lease can be retried safely');
  token:=gen_random_uuid();
  perform public.claim_provider_rate_refresh(repeat('f',64),token);
  v:=public.complete_provider_rate_refresh(repeat('f',64),token,true,now()+interval '45 seconds',0.016,0.005,0.001);
  perform public.firstrole_rates_assert(v->>'state'='verified','bounded provider clock skew accepted');
  perform public.firstrole_rates_assert((v->>'verifiedAt')::timestamptz=now(),'canonical verification is not in the future');
  perform public.firstrole_rates_assert((v->>'expiresAt')::timestamptz=now()+interval '6 hours','clock skew cannot extend proof TTL');
end $$;
select 'Database automatic-rate attestation checks passed' as result;
rollback;
