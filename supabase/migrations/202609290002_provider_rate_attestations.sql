-- Additive metadata-only rate attestation cache. Does not modify budget_guard,
-- account data, provider operations, allowances, or the previously applied schema.
begin;

create table public.provider_rate_attestations (
  key_fingerprint text primary key check (key_fingerprint ~ '^[a-f0-9]{64}$'),
  provider_as_of timestamptz,
  verified_at timestamptz,
  expires_at timestamptz,
  agent_rate numeric(18,12) check (agent_rate between 0 and 0.016),
  search_rate numeric(18,12) check (search_rate between 0 and 0.005),
  fetch_rate numeric(18,12) check (fetch_rate between 0 and 0.001),
  refresh_token uuid,
  refresh_until timestamptz,
  retry_after timestamptz,
  updated_at timestamptz not null default now(),
  check (expires_at is null or (provider_as_of is not null and expires_at<=provider_as_of+interval '6 hours'))
);
alter table public.provider_rate_attestations enable row level security;
revoke all on public.provider_rate_attestations from public, anon, authenticated;
grant all on public.provider_rate_attestations to service_role;

create function public.get_provider_rate_attestation(p_key_fingerprint text) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $$
select jsonb_build_object(
  'state',case when refresh_until>now() then 'refreshing'
    when expires_at>now() and provider_as_of<=now() and agent_rate is not null and search_rate is not null and fetch_rate is not null then 'verified'
    when retry_after>now() then 'blocked' else 'expired' end,
  'keyFingerprint',key_fingerprint,'providerAsOf',provider_as_of,'verifiedAt',verified_at,
  'expiresAt',expires_at,'agentRate',agent_rate::text,'searchRate',search_rate::text,'fetchRate',fetch_rate::text)
from public.provider_rate_attestations where key_fingerprint=p_key_fingerprint;
$$;

create function public.claim_provider_rate_refresh(p_key_fingerprint text,p_refresh_token uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_row public.provider_rate_attestations%rowtype;
begin
  if p_key_fingerprint is null or p_key_fingerprint !~ '^[a-f0-9]{64}$' or p_refresh_token is null then
    return jsonb_build_object('state','busy');
  end if;
  insert into public.provider_rate_attestations(key_fingerprint) values(p_key_fingerprint) on conflict do nothing;
  select * into v_row from public.provider_rate_attestations where key_fingerprint=p_key_fingerprint for update;
  if v_row.expires_at>now() and v_row.provider_as_of<=now() and v_row.agent_rate is not null and v_row.search_rate is not null and v_row.fetch_rate is not null then
    return jsonb_build_object('state','ready','proof',public.get_provider_rate_attestation(p_key_fingerprint));
  end if;
  if v_row.refresh_until>now() or v_row.retry_after>now() then return jsonb_build_object('state','busy'); end if;
  update public.provider_rate_attestations set refresh_token=p_refresh_token,refresh_until=now()+interval '30 seconds',retry_after=null,updated_at=now()
  where key_fingerprint=p_key_fingerprint;
  return jsonb_build_object('state','claimed');
end; $$;

create function public.complete_provider_rate_refresh(
  p_key_fingerprint text,p_refresh_token uuid,p_valid boolean,
  p_provider_as_of timestamptz default null,p_agent_rate numeric default null,
  p_search_rate numeric default null,p_fetch_rate numeric default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_row public.provider_rate_attestations%rowtype; v_valid boolean;
begin
  select * into v_row from public.provider_rate_attestations where key_fingerprint=p_key_fingerprint for update;
  if not found or v_row.refresh_token is distinct from p_refresh_token or v_row.refresh_until is null or v_row.refresh_until<=now() then return null; end if;
  v_valid := coalesce(p_valid,false) and p_provider_as_of is not null and p_provider_as_of<=now() and p_provider_as_of>now()-interval '6 hours'
    and p_agent_rate between 0 and 0.016 and p_search_rate between 0 and 0.005 and p_fetch_rate between 0 and 0.001;
  if coalesce(v_valid,false) then
    update public.provider_rate_attestations set provider_as_of=p_provider_as_of,verified_at=now(),expires_at=p_provider_as_of+interval '6 hours',
      agent_rate=p_agent_rate,search_rate=p_search_rate,fetch_rate=p_fetch_rate,refresh_token=null,refresh_until=null,retry_after=null,updated_at=now()
    where key_fingerprint=p_key_fingerprint;
  else
    update public.provider_rate_attestations set provider_as_of=null,verified_at=null,expires_at=null,agent_rate=null,search_rate=null,fetch_rate=null,
      refresh_token=null,refresh_until=null,retry_after=now()+interval '60 seconds',updated_at=now()
    where key_fingerprint=p_key_fingerprint;
  end if;
  return public.get_provider_rate_attestation(p_key_fingerprint);
end; $$;

revoke all on function public.get_provider_rate_attestation(text) from public,anon,authenticated;
revoke all on function public.claim_provider_rate_refresh(text,uuid) from public,anon,authenticated;
revoke all on function public.complete_provider_rate_refresh(text,uuid,boolean,timestamptz,numeric,numeric,numeric) from public,anon,authenticated;
grant execute on function public.get_provider_rate_attestation(text) to service_role;
grant execute on function public.claim_provider_rate_refresh(text,uuid) to service_role;
grant execute on function public.complete_provider_rate_refresh(text,uuid,boolean,timestamptz,numeric,numeric,numeric) to service_role;
commit;
