-- Independent OPTIONAL provider accounting. No TinyFish budget/ledger/rate rows
-- or existing search/account data are changed. Both providers start disabled.
begin;

create table public.enrichment_budgets (
  provider text primary key check (provider in ('openrouter','firecrawl')),
  enabled boolean not null default false,
  limit_usd numeric not null,
  unit_limit integer,
  dispatch_limit integer,
  spent_usd numeric not null default 0 check (spent_usd>=0),
  reserved_usd numeric not null default 0 check (reserved_usd>=0),
  spent_units integer not null default 0 check (spent_units>=0),
  reserved_units integer not null default 0 check (reserved_units>=0),
  dispatches integer not null default 0 check (dispatches>=0),
  updated_at timestamptz not null default now(),
  check ((provider='openrouter' and limit_usd=1 and unit_limit is null and dispatch_limit is null)
    or (provider='firecrawl' and limit_usd=0 and unit_limit=100 and dispatch_limit=100))
);
insert into public.enrichment_budgets(provider,limit_usd,unit_limit,dispatch_limit)
values ('openrouter',1,null,null),('firecrawl',0,100,100);

create table public.enrichment_provider_proofs (
  provider text not null references public.enrichment_budgets(provider),
  key_fingerprint text not null check (key_fingerprint ~ '^[a-f0-9]{64}$'),
  proof jsonb not null check (jsonb_typeof(proof)='object' and octet_length(proof::text)<=4096),
  verified_at timestamptz not null,
  expires_at timestamptz not null,
  primary key(provider,key_fingerprint),
  check(expires_at<=verified_at+interval '6 hours')
);

create function public.get_enrichment_provider_proof(p_provider text,p_key_fingerprint text) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
select proof || jsonb_build_object('provider',provider,'keyFingerprint',key_fingerprint,'verifiedAt',verified_at,'expiresAt',expires_at)
from public.enrichment_provider_proofs where provider=p_provider and key_fingerprint=p_key_fingerprint and expires_at>now() and verified_at<=now()+interval '60 seconds';
$$;

create function public.put_enrichment_provider_proof(p_provider text,p_key_fingerprint text,p_proof jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_asof timestamptz; v_verified timestamptz; v_proof jsonb; v_input numeric; v_output numeric; v_remaining integer;
begin
  if p_provider is null or p_provider not in ('openrouter','firecrawl') or p_key_fingerprint is null or p_key_fingerprint !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_proof) is distinct from 'object' or octet_length(p_proof::text)>4096 then return null; end if;
  v_asof:=(p_proof->>'verifiedAt')::timestamptz;
  if v_asof is null or v_asof>now()+interval '60 seconds' or v_asof<=now()-interval '6 hours' then return null; end if;
  v_verified:=least(v_asof,now());
  if p_provider='openrouter' then
    v_input:=(p_proof->>'inputPricePerMillion')::numeric;
    v_output:=(p_proof->>'outputPricePerMillion')::numeric;
    if p_proof->>'model' is distinct from 'google/gemma-4-26b-a4b-it' or p_proof->>'providerSlug' is distinct from 'reka'
      or p_proof->'zeroDataRetention' is distinct from 'true'::jsonb or v_input is null or v_output is null
      or v_input not between 0 and 0.10 or v_output not between 0 and 0.40 then return null; end if;
    v_proof:=jsonb_build_object('model','google/gemma-4-26b-a4b-it','providerSlug','reka','zeroDataRetention',true,
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

create table public.enrichment_operations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.search_runs(id) on delete set null,
  provider text not null references public.enrichment_budgets(provider),
  key_fingerprint text not null check (key_fingerprint ~ '^[a-f0-9]{64}$'),
  operation_key text not null check (length(operation_key) between 1 and 256),
  claim_token uuid not null,
  state text not null default 'claimed' check (state in ('claimed','needs_reconciliation','settled')),
  reserved_usd numeric not null default 0 check (reserved_usd>=0),
  charged_usd numeric not null default 0 check (charged_usd>=0),
  reserved_units integer not null default 0 check (reserved_units>=0),
  charged_units integer not null default 0 check (charged_units>=0),
  model text,
  input_bytes integer,
  output_tokens integer,
  input_price numeric,
  output_price numeric,
  rates_verified_at timestamptz,
  provider_request_id text check (provider_request_id is null or length(provider_request_id) between 1 and 256),
  outcome text check (outcome is null or outcome in ('completed','failed','cancelled','not-started','unknown')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id,provider,operation_key)
);
create index enrichment_operations_run on public.enrichment_operations(run_id);
create unique index enrichment_provider_request on public.enrichment_operations(provider,provider_request_id) where provider_request_id is not null;

create table public.enrichment_ledger (
  id bigint generated always as identity primary key,
  operation_id uuid not null references public.enrichment_operations(id),
  event text not null check (event in ('reserve-and-claim','settle')),
  reserved_usd_delta numeric not null,
  spent_usd_delta numeric not null,
  reserved_units_delta integer not null,
  spent_units_delta integer not null,
  created_at timestamptz not null default now(),
  unique(operation_id,event)
);

create function public.admit_enrichment_operation(
  p_run_id uuid,p_provider text,p_operation_key text,p_claim_token uuid,
  p_model text default null,p_input_bytes integer default null,p_output_tokens integer default null,
  p_input_price numeric default null,p_output_price numeric default null,p_rates_verified_at timestamptz default null,p_key_fingerprint text default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_run public.search_runs%rowtype; v_guard public.enrichment_budgets%rowtype;
  v_existing public.enrichment_operations%rowtype; v_op public.enrichment_operations%rowtype;
  v_usd numeric; v_units integer; v_proof jsonb;
begin
  -- Lock the search first, then its provider guard. Different optional providers
  -- therefore share the same two-operation ceiling under concurrent requests.
  select * into v_run from public.search_runs where id=p_run_id for update;
  if not found then return jsonb_build_object('admitted',false,'reason','run_inactive'); end if;
  select * into v_existing from public.enrichment_operations where run_id=p_run_id and provider=p_provider and operation_key=p_operation_key;
  if found then return jsonb_build_object('admitted',false,'reused',true,'operationId',v_existing.id,'state',v_existing.state,'reason','already_claimed'); end if;
  if v_run.cancel_requested or v_run.expires_at<=now() or v_run.payload->>'cached'='true'
    or v_run.payload->>'status' in ('completed','partial','failed','cancelled') then
    return jsonb_build_object('admitted',false,'reason','run_inactive');
  end if;
  if p_provider is null or p_provider not in ('openrouter','firecrawl') or p_claim_token is null
    or p_operation_key is null or length(p_operation_key) not between 1 and 256 then
    return jsonb_build_object('admitted',false,'reason','invalid_operation');
  end if;
  if (select count(*) from public.enrichment_operations where run_id=p_run_id)>=2 then
    return jsonb_build_object('admitted',false,'reason','search_optional_limit');
  end if;
  v_proof:=public.get_enrichment_provider_proof(p_provider,p_key_fingerprint);
  if v_proof is null then return jsonb_build_object('admitted',false,'reason','optional_provider_proof_required'); end if;
  if p_provider='openrouter' then
    if p_model is distinct from 'google/gemma-4-26b-a4b-it'
      or p_input_bytes is null or p_input_bytes not between 1 and 64000
      or p_output_tokens is null or p_output_tokens not between 1 and 1800
      or p_input_price is null or p_input_price not between 0 and 0.10
      or p_output_price is null or p_output_price not between 0 and 0.40
      or p_rates_verified_at is null or p_rates_verified_at>now()+interval '60 seconds' or p_rates_verified_at<=now()-interval '24 hours'
      or (p_input_bytes::numeric*p_input_price+p_output_tokens::numeric*p_output_price)/1000000>0.01
      or p_model is distinct from v_proof->>'model'
      or p_input_price is distinct from (v_proof->>'inputPricePerMillion')::numeric
      or p_output_price is distinct from (v_proof->>'outputPricePerMillion')::numeric then
      return jsonb_build_object('admitted',false,'reason','model_rates_or_bound_unverified');
    end if;
    v_usd:=0.01; v_units:=0;
  else
    if (v_proof->>'remainingCredits')::integer<1 then return jsonb_build_object('admitted',false,'reason','optional_account_credits_exhausted'); end if;
    v_usd:=0; v_units:=1;
  end if;
  select * into v_guard from public.enrichment_budgets where provider=p_provider for update;
  if not v_guard.enabled then return jsonb_build_object('admitted',false,'reason','optional_provider_disabled'); end if;
  if v_guard.spent_usd+v_guard.reserved_usd+v_usd>v_guard.limit_usd then return jsonb_build_object('admitted',false,'reason','optional_budget_exhausted'); end if;
  if v_guard.unit_limit is not null and v_guard.spent_units+v_guard.reserved_units+v_units>v_guard.unit_limit then
    return jsonb_build_object('admitted',false,'reason','optional_credit_limit');
  end if;
  if v_guard.dispatch_limit is not null and v_guard.dispatches>=v_guard.dispatch_limit then
    return jsonb_build_object('admitted',false,'reason','optional_dispatch_limit');
  end if;
  insert into public.enrichment_operations(run_id,provider,key_fingerprint,operation_key,claim_token,reserved_usd,reserved_units,
    model,input_bytes,output_tokens,input_price,output_price,rates_verified_at)
  values(p_run_id,p_provider,p_key_fingerprint,p_operation_key,p_claim_token,v_usd,v_units,
    case when p_provider='openrouter' then p_model end,
    case when p_provider='openrouter' then p_input_bytes end,
    case when p_provider='openrouter' then p_output_tokens end,
    case when p_provider='openrouter' then p_input_price end,
    case when p_provider='openrouter' then p_output_price end,
    case when p_provider='openrouter' then p_rates_verified_at end) returning * into v_op;
  update public.enrichment_budgets set reserved_usd=reserved_usd+v_usd,reserved_units=reserved_units+v_units,dispatches=dispatches+1,updated_at=now() where provider=p_provider;
  insert into public.enrichment_ledger(operation_id,event,reserved_usd_delta,spent_usd_delta,reserved_units_delta,spent_units_delta)
  values(v_op.id,'reserve-and-claim',v_usd,0,v_units,0);
  return jsonb_build_object('admitted',true,'operationId',v_op.id,'state','claimed','reservedUsd',v_usd,'reservedUnits',v_units);
end; $$;

create function public.settle_enrichment_operation(
  p_operation_id uuid,p_claim_token uuid,p_outcome text,p_actual_usd numeric default null,
  p_actual_units integer default null,p_authoritative boolean default false,p_provider_request_id text default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_provider text; v_guard public.enrichment_budgets%rowtype; v_op public.enrichment_operations%rowtype;
  v_usd numeric; v_units integer; v_overrun boolean;
begin
  select provider into v_provider from public.enrichment_operations where id=p_operation_id;
  if not found then return jsonb_build_object('settled',false,'reason','operation_not_found'); end if;
  -- Settlement never locks a search row and still works after account deletion.
  select * into v_guard from public.enrichment_budgets where provider=v_provider for update;
  select * into v_op from public.enrichment_operations where id=p_operation_id for update;
  if v_op.claim_token is distinct from p_claim_token then return jsonb_build_object('settled',false,'reason','claim_mismatch'); end if;
  if v_op.state='settled' then return jsonb_build_object('settled',true,'reused',true,'chargedUsd',v_op.charged_usd,'chargedUnits',v_op.charged_units); end if;
  if p_outcome is null or p_outcome not in ('completed','failed','cancelled','not-started','unknown') then return jsonb_build_object('settled',false,'reason','invalid_outcome'); end if;
  if p_provider_request_id is not null and (length(p_provider_request_id) not between 1 and 256
    or (v_op.provider_request_id is not null and v_op.provider_request_id<>p_provider_request_id)
    or exists(select 1 from public.enrichment_operations where provider=v_provider and provider_request_id=p_provider_request_id and id<>p_operation_id)) then
    return jsonb_build_object('settled',false,'reason','provider_request_conflict');
  end if;
  if p_provider_request_id is not null then
    update public.enrichment_operations set provider_request_id=p_provider_request_id where id=p_operation_id;
  end if;
  if not coalesce(p_authoritative,false) or p_outcome='unknown'
    or (v_provider='openrouter' and p_actual_usd is null)
    or (v_provider='firecrawl' and p_actual_units is null) then
    update public.enrichment_operations set state='needs_reconciliation',outcome=p_outcome,updated_at=now() where id=p_operation_id;
    return jsonb_build_object('settled',false,'state','needs_reconciliation','reservedUsd',v_op.reserved_usd,'reservedUnits',v_op.reserved_units);
  end if;
  if p_actual_usd is not null and (p_actual_usd<0 or p_actual_usd>100 or p_actual_usd::text in ('NaN','Infinity','-Infinity')) then
    return jsonb_build_object('settled',false,'reason','invalid_cost');
  end if;
  if p_actual_units is not null and p_actual_units not between 0 and 100000 then return jsonb_build_object('settled',false,'reason','invalid_units'); end if;
  if p_outcome='not-started' and (coalesce(p_actual_usd,0)<>0 or coalesce(p_actual_units,0)<>0 or v_op.provider_request_id is not null or p_provider_request_id is not null) then
    return jsonb_build_object('settled',false,'reason','not_started_evidence_conflict');
  end if;
  v_usd:=coalesce(p_actual_usd,0);
  v_units:=case when v_provider='firecrawl' then p_actual_units else 0 end;
  v_overrun:=v_usd>v_op.reserved_usd or v_units>v_op.reserved_units;
  -- Confirmed billing is recorded truthfully. Any unexpected overrun immediately
  -- disables this optional provider; its companion/core providers remain usable.
  update public.enrichment_budgets set reserved_usd=reserved_usd-v_op.reserved_usd,spent_usd=spent_usd+v_usd,
    reserved_units=reserved_units-v_op.reserved_units,spent_units=spent_units+v_units,
    enabled=case when v_overrun then false else enabled end,updated_at=now() where provider=v_provider;
  insert into public.enrichment_ledger(operation_id,event,reserved_usd_delta,spent_usd_delta,reserved_units_delta,spent_units_delta)
  values(v_op.id,'settle',-v_op.reserved_usd,v_usd,-v_op.reserved_units,v_units);
  update public.enrichment_operations set state='settled',outcome=p_outcome,reserved_usd=0,charged_usd=v_usd,
    reserved_units=0,charged_units=v_units,updated_at=now() where id=p_operation_id;
  return jsonb_build_object('settled',true,'reused',false,'chargedUsd',v_usd,'chargedUnits',v_units,'providerDisabled',v_overrun);
end; $$;

alter table public.enrichment_budgets enable row level security;
alter table public.enrichment_provider_proofs enable row level security;
alter table public.enrichment_operations enable row level security;
alter table public.enrichment_ledger enable row level security;
revoke all on public.enrichment_budgets,public.enrichment_provider_proofs,public.enrichment_operations,public.enrichment_ledger from public,anon,authenticated,service_role;
grant select on public.enrichment_budgets,public.enrichment_provider_proofs,public.enrichment_operations,public.enrichment_ledger to service_role;
-- Operators can pause/enable optional work; the API role cannot reset accounting.
grant update(enabled) on public.enrichment_budgets to service_role;
revoke all on sequence public.enrichment_ledger_id_seq from public,anon,authenticated,service_role;
revoke all on function public.get_enrichment_provider_proof(text,text) from public,anon,authenticated;
revoke all on function public.put_enrichment_provider_proof(text,text,jsonb) from public,anon,authenticated;
revoke all on function public.admit_enrichment_operation(uuid,text,text,uuid,text,integer,integer,numeric,numeric,timestamptz,text) from public,anon,authenticated;
revoke all on function public.settle_enrichment_operation(uuid,uuid,text,numeric,integer,boolean,text) from public,anon,authenticated;
grant execute on function public.get_enrichment_provider_proof(text,text) to service_role;
grant execute on function public.put_enrichment_provider_proof(text,text,jsonb) to service_role;
grant execute on function public.admit_enrichment_operation(uuid,text,text,uuid,text,integer,integer,numeric,numeric,timestamptz,text) to service_role;
grant execute on function public.settle_enrichment_operation(uuid,uuid,text,numeric,integer,boolean,text) to service_role;
commit;
