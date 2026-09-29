-- FirstRole: browser-owned accounts and service-only orchestration/accounting.
-- Run once in the Supabase SQL editor or with `supabase db push`.
begin;

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  preferences jsonb not null default '{}'::jsonb check (jsonb_typeof(preferences) = 'object' and octet_length(preferences::text) <= 32768),
  updated_at timestamptz not null default now()
);

create table public.saved_jobs (
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id text not null check (length(job_id) between 1 and 256),
  job jsonb not null check (jsonb_typeof(job) = 'object' and octet_length(job::text) <= 131072),
  status text not null default 'Saved' check (status in ('Saved','Applied','Interviewing','Offer','Rejected','Withdrawn')),
  notes text not null default '' check (length(notes) <= 10000),
  applied_at timestamptz,
  saved_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, job_id),
  check (job ? 'id' and jsonb_typeof(job->'id')='string' and job ->> 'id' = job_id)
);

create function public.firstrole_touch_updated_at() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin new.updated_at := now(); return new; end;
$$;
create trigger profiles_updated_at before update on public.profiles for each row execute function public.firstrole_touch_updated_at();
create trigger saved_jobs_updated_at before update on public.saved_jobs for each row execute function public.firstrole_touch_updated_at();

alter table public.profiles enable row level security;
alter table public.saved_jobs enable row level security;
create policy profiles_select on public.profiles for select to authenticated using (user_id = (select auth.uid()));
create policy profiles_insert on public.profiles for insert to authenticated with check (user_id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy profiles_delete on public.profiles for delete to authenticated using (user_id = (select auth.uid()));
create policy saved_jobs_select on public.saved_jobs for select to authenticated using (user_id = (select auth.uid()));
create policy saved_jobs_insert on public.saved_jobs for insert to authenticated with check (user_id = (select auth.uid()));
create policy saved_jobs_update on public.saved_jobs for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy saved_jobs_delete on public.saved_jobs for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.profiles, public.saved_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.profiles, public.saved_jobs to authenticated;
grant all on public.profiles, public.saved_jobs to service_role;

create table public.budget_guard (
  singleton boolean primary key default true check (singleton),
  limit_usd numeric(12,6) not null default 10 check (limit_usd >= 0),
  spent_usd numeric(12,6) not null default 0 check (spent_usd >= 0),
  reserved_usd numeric(12,6) not null default 0 check (reserved_usd >= 0),
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into public.budget_guard(singleton) values (true);

create table public.daily_usage (
  key_kind text not null check (key_kind in ('actor','network')),
  key_hash text not null,
  usage_date date not null,
  searches integer not null default 0 check (searches >= 0),
  assisted integer not null default 0 check (assisted >= 0),
  primary key (key_kind, key_hash, usage_date)
);

create table public.search_runs (
  id uuid primary key,
  owner_id uuid references auth.users(id) on delete cascade,
  guest_id text,
  actor_key text not null check (length(actor_key) between 16 and 128),
  network_key text not null check (length(network_key) between 16 and 128),
  idempotency_key text not null check (length(idempotency_key) between 1 and 128),
  fingerprint text not null check (length(fingerprint) between 1 and 256),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 2097152),
  cancel_requested boolean not null default false,
  assisted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '48 hours',
  unique (actor_key, idempotency_key),
  check ((owner_id is null) <> (guest_id is null))
);
create index search_runs_owner on public.search_runs(owner_id) where owner_id is not null;
create index search_runs_actor on public.search_runs(actor_key, created_at desc);

create table public.provider_operations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.search_runs(id) on delete set null,
  operation_key text not null check (length(operation_key) between 1 and 256),
  kind text not null check (kind in ('search','fetch','agent')),
  units integer not null check (units between 1 and 20),
  source_host text,
  state text not null default 'reserved' check (state in ('reserved','claimed','needs_reconciliation','settled')),
  reserved_usd numeric(12,6) not null default 0 check (reserved_usd >= 0),
  charged_usd numeric(12,6) not null default 0 check (charged_usd >= 0),
  claim_token text,
  provider_run_id text,
  outcome text,
  terminal_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id, operation_key)
);
create unique index provider_run_identity on public.provider_operations(provider_run_id) where provider_run_id is not null;
create index provider_operations_active on public.provider_operations(kind, state, source_host, created_at);

create table public.budget_ledger (
  id bigint generated always as identity primary key,
  operation_id uuid not null references public.provider_operations(id),
  event text not null check (event in ('reserve','charge','reconcile')),
  reserved_delta numeric(12,6) not null,
  spent_delta numeric(12,6) not null,
  created_at timestamptz not null default now(),
  unique(operation_id,event)
);

create table public.search_cache (
  fingerprint text primary key,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 2097152),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Public job facts verified by the server. Browser snapshots are never URL authority.
create table public.verified_jobs (
  job_id text primary key check (length(job_id) between 1 and 256),
  job jsonb not null check (jsonb_typeof(job)='object' and octet_length(job::text)<=131072),
  updated_at timestamptz not null default now()
);
create function public.firstrole_index_jobs(p_payload jsonb) returns void
language sql security definer set search_path = pg_catalog, public as $$
insert into public.verified_jobs(job_id,job)
select distinct on (j->>'id') j->>'id',j from jsonb_array_elements(coalesce(p_payload->'results','[]'::jsonb)) j
where jsonb_typeof(j->'id')='string' and length(j->>'id') between 1 and 256 and jsonb_typeof(j->'sourceUrl')='string'
on conflict(job_id) do update set job=excluded.job,updated_at=now();
$$;

-- The singleton budget row is the first lock for every spending/admission mutation.
-- It serializes independent Workers, retries, and quota checks in one transaction.
create function public.create_search_run(
  p_run_id uuid, p_actor_key text, p_owner_id uuid, p_guest_id text,
  p_network_key text, p_fingerprint text, p_payload jsonb,
  p_assisted boolean, p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_guard public.budget_guard%rowtype; v_existing public.search_runs%rowtype;
  v_actor public.daily_usage%rowtype; v_network public.daily_usage%rowtype;
  v_day date := (now() at time zone 'UTC')::date; v_limit integer; v_cached jsonb; v_payload jsonb;
begin
  select * into v_guard from public.budget_guard where singleton for update;
  select * into v_existing from public.search_runs where actor_key=p_actor_key and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.fingerprint <> p_fingerprint then return jsonb_build_object('admitted',false,'reason','idempotency_conflict'); end if;
    return jsonb_build_object('admitted',true,'run',v_existing.payload,'reused',true);
  end if;
  if p_actor_key is null or length(p_actor_key) not between 16 and 128 or p_network_key is null or length(p_network_key) not between 16 and 128
    or p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
    or p_fingerprint is null or length(p_fingerprint) not between 1 and 256
    or ((p_owner_id is null) = (p_guest_id is null)) or p_payload ->> 'id' is distinct from p_run_id::text then
    return jsonb_build_object('admitted',false,'reason','invalid_request');
  end if;
  if p_payload->>'cached'='true' then
    select payload into v_cached from public.search_cache where fingerprint=p_fingerprint and expires_at>now();
    if not found then return jsonb_build_object('admitted',false,'reason','cache_expired'); end if;
    v_payload := p_payload || v_cached || jsonb_build_object('cached',true,'status','completed','stage','Recent verified results');
    insert into public.search_runs(id,owner_id,guest_id,actor_key,network_key,idempotency_key,fingerprint,payload,assisted)
    values(p_run_id,p_owner_id,p_guest_id,p_actor_key,p_network_key,p_idempotency_key,p_fingerprint,v_payload,false);
    return jsonb_build_object('admitted',true,'run',v_payload,'reused',false);
  end if;
  if not v_guard.enabled then return jsonb_build_object('admitted',false,'reason','search_disabled'); end if;
  if v_guard.spent_usd + v_guard.reserved_usd >= v_guard.limit_usd then return jsonb_build_object('admitted',false,'reason','budget_exhausted'); end if;
  select * into v_actor from public.daily_usage where key_kind='actor' and key_hash=p_actor_key and usage_date=v_day;
  select * into v_network from public.daily_usage where key_kind='network' and key_hash=p_network_key and usage_date=v_day;
  v_limit := case when p_owner_id is null then 3 else 10 end;
  if coalesce(v_actor.searches,0) >= v_limit then return jsonb_build_object('admitted',false,'reason','actor_daily_limit'); end if;
  if coalesce(v_network.searches,0) >= 20 then return jsonb_build_object('admitted',false,'reason','network_daily_limit'); end if;
  if p_assisted and coalesce(v_actor.assisted,0) >= 1 then return jsonb_build_object('admitted',false,'reason','actor_assisted_limit'); end if;
  if p_assisted and coalesce(v_network.assisted,0) >= 3 then return jsonb_build_object('admitted',false,'reason','network_assisted_limit'); end if;
  insert into public.search_runs(id,owner_id,guest_id,actor_key,network_key,idempotency_key,fingerprint,payload,assisted)
  values(p_run_id,p_owner_id,p_guest_id,p_actor_key,p_network_key,p_idempotency_key,p_fingerprint,p_payload,coalesce(p_assisted,false));
  insert into public.daily_usage(key_kind,key_hash,usage_date,searches,assisted) values('actor',p_actor_key,v_day,1,case when p_assisted then 1 else 0 end)
  on conflict(key_kind,key_hash,usage_date) do update set searches=public.daily_usage.searches+1, assisted=public.daily_usage.assisted+excluded.assisted;
  insert into public.daily_usage(key_kind,key_hash,usage_date,searches,assisted) values('network',p_network_key,v_day,1,case when p_assisted then 1 else 0 end)
  on conflict(key_kind,key_hash,usage_date) do update set searches=public.daily_usage.searches+1, assisted=public.daily_usage.assisted+excluded.assisted;
  return jsonb_build_object('admitted',true,'run',p_payload,'reused',false);
end; $$;

create function public.get_search_run(p_run_id uuid,p_actor_key text) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $$
select payload from public.search_runs where id=p_run_id and actor_key=p_actor_key and expires_at>now();
$$;
create function public.get_internal_search_run(p_run_id uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $$
select jsonb_build_object('payload',payload,'cancelRequested',cancel_requested,'actorKey',actor_key,'ownerId',owner_id,'guestId',guest_id,'networkKey',network_key,'assisted',assisted)
from public.search_runs where id=p_run_id;
$$;
create function public.update_search_run(p_run_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_run public.search_runs%rowtype; v_payload jsonb;
begin
  select * into v_run from public.search_runs where id=p_run_id for update;
  if not found then return null; end if;
  if p_payload ->> 'id' is distinct from p_run_id::text then raise exception 'run identity mismatch'; end if;
  if v_run.payload ->> 'status' in ('completed','partial','failed','cancelled') then return v_run.payload; end if;
  v_payload := p_payload || jsonb_build_object('createdAt',v_run.payload->'createdAt','updatedAt',now());
  if v_run.cancel_requested then v_payload := v_payload || jsonb_build_object('status','cancelled','stage','Search cancelled'); end if;
  update public.search_runs set payload=v_payload,updated_at=now() where id=p_run_id;
  perform public.firstrole_index_jobs(v_payload);
  return v_payload;
end; $$;
create function public.cancel_user_searches(p_owner_id uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform 1 from public.budget_guard where singleton for update;
  update public.search_runs set cancel_requested=true,updated_at=now(),payload=payload || jsonb_build_object('status','cancelled','stage','Search cancelled','updatedAt',now())
  where owner_id=p_owner_id and payload->>'status' not in ('completed','partial','failed','cancelled');
  return true;
end; $$;
create function public.request_search_cancel(p_run_id uuid,p_actor_key text) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform 1 from public.budget_guard where singleton for update;
  update public.search_runs set cancel_requested=true,updated_at=now(),payload=payload || jsonb_build_object('status','cancelled','stage','Search cancelled','updatedAt',now())
  where id=p_run_id and actor_key=p_actor_key and payload->>'status' not in ('completed','partial','failed','cancelled');
  return found;
end; $$;

create function public.reserve_provider_operation(p_run_id uuid,p_operation_key text,p_kind text,p_units integer default 1,p_source_host text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_guard public.budget_guard%rowtype; v_op public.provider_operations%rowtype; v_run public.search_runs%rowtype;
  v_cost numeric(12,6); v_count integer; v_host text := lower(p_source_host);
begin
  select * into v_guard from public.budget_guard where singleton for update;
  select * into v_op from public.provider_operations where run_id=p_run_id and operation_key=p_operation_key;
  if found then
    if v_op.kind is distinct from p_kind or v_op.units is distinct from p_units or v_op.source_host is distinct from v_host then
      return jsonb_build_object('allowed',false,'reason','idempotency_conflict');
    end if;
    return jsonb_build_object('allowed',true,'operationId',v_op.id,'state',v_op.state,'reused',true);
  end if;
  select * into v_run from public.search_runs where id=p_run_id;
  if not found or v_run.cancel_requested or v_run.expires_at<=now() or v_run.payload->>'status' in ('completed','partial','failed','cancelled') then
    return jsonb_build_object('allowed',false,'reason','run_inactive');
  end if;
  if p_kind is null or p_kind not in ('search','fetch','agent') or p_units is null or p_units not between 1 and 20
    or (p_kind in ('search','agent') and p_units<>1) or p_operation_key is null or length(p_operation_key) not between 1 and 256
    or (p_kind in ('fetch','agent') and (v_host is null or length(v_host)>253 or v_host !~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$')) then
    return jsonb_build_object('allowed',false,'reason','invalid_operation');
  end if;
  if not v_guard.enabled then return jsonb_build_object('allowed',false,'reason','search_disabled'); end if;
  v_cost := case p_kind when 'search' then 0.005 when 'fetch' then 0.001*p_units else 2.50 end;
  if v_guard.spent_usd+v_guard.reserved_usd+v_cost>v_guard.limit_usd then return jsonb_build_object('allowed',false,'reason','budget_exhausted'); end if;
  if p_kind='agent' then
    if not v_run.assisted then return jsonb_build_object('allowed',false,'reason','assistance_not_admitted'); end if;
    if exists(select 1 from public.provider_operations where run_id=p_run_id and kind='agent' and not(state='settled' and outcome='not-started')) then return jsonb_build_object('allowed',false,'reason','run_agent_limit'); end if;
    select count(*) into v_count from public.provider_operations where kind='agent' and state<>'settled' and not terminal_verified;
    if v_count>=2 then return jsonb_build_object('allowed',false,'reason','global_agent_concurrency'); end if;
    if exists(select 1 from public.provider_operations where kind='agent' and source_host=v_host and state<>'settled' and not terminal_verified) then return jsonb_build_object('allowed',false,'reason','source_agent_concurrency'); end if;
    select count(*) into v_count from public.provider_operations where kind='agent' and not(state='settled' and outcome='not-started') and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
    if v_count>=4 then return jsonb_build_object('allowed',false,'reason','global_agent_daily_limit'); end if;
  elsif p_kind='fetch' then
    select coalesce(sum(units),0) into v_count from public.provider_operations where kind='fetch' and source_host=v_host and created_at>now()-interval '1 hour';
    if v_count+p_units>30 then return jsonb_build_object('allowed',false,'reason','source_fetch_hourly_limit'); end if;
  end if;
  insert into public.provider_operations(run_id,operation_key,kind,units,source_host,reserved_usd)
  values(p_run_id,p_operation_key,p_kind,p_units,v_host,v_cost) returning * into v_op;
  update public.budget_guard set reserved_usd=reserved_usd+v_cost,updated_at=now() where singleton;
  insert into public.budget_ledger(operation_id,event,reserved_delta,spent_delta) values(v_op.id,'reserve',v_cost,0);
  return jsonb_build_object('allowed',true,'operationId',v_op.id,'state',v_op.state,'reservedUsd',v_cost,'reused',false);
end; $$;

create function public.claim_provider_operation(p_operation_id uuid,p_claim_token text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_op public.provider_operations%rowtype; v_run public.search_runs%rowtype; v_enabled boolean;
begin
  select enabled into v_enabled from public.budget_guard where singleton for update;
  select * into v_op from public.provider_operations where id=p_operation_id for update;
  if not found then return jsonb_build_object('claimed',false,'reason','operation_not_found'); end if;
  if v_op.state<>'reserved' then return jsonb_build_object('claimed',false,'state',v_op.state,'providerRunId',v_op.provider_run_id,'claimToken',v_op.claim_token); end if;
  if p_claim_token is null or length(p_claim_token) not between 16 and 256 then return jsonb_build_object('claimed',false,'reason','invalid_claim'); end if;
  if not v_enabled then return jsonb_build_object('claimed',false,'reason','search_disabled'); end if;
  select * into v_run from public.search_runs where id=v_op.run_id;
  if not found or v_run.cancel_requested or v_run.expires_at<=now() or v_run.payload->>'status' in ('completed','partial','failed','cancelled') then return jsonb_build_object('claimed',false,'reason','run_inactive'); end if;
  update public.provider_operations set state='claimed',claim_token=p_claim_token,updated_at=now() where id=p_operation_id;
  if v_op.kind<>'agent' then
    update public.budget_guard set reserved_usd=reserved_usd-v_op.reserved_usd,spent_usd=spent_usd+v_op.reserved_usd,updated_at=now() where singleton;
    update public.provider_operations set charged_usd=v_op.reserved_usd,reserved_usd=0 where id=p_operation_id;
    insert into public.budget_ledger(operation_id,event,reserved_delta,spent_delta) values(v_op.id,'charge',-v_op.reserved_usd,v_op.reserved_usd);
  end if;
  return jsonb_build_object('claimed',true,'state','claimed','providerRunId',v_op.provider_run_id);
end; $$;

create function public.bind_provider_run(p_operation_id uuid,p_claim_token text,p_provider_run_id text) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_provider_run_id is null or length(p_provider_run_id) not between 1 and 256 then return false; end if;
  update public.provider_operations set provider_run_id=p_provider_run_id,updated_at=now()
  where id=p_operation_id and claim_token=p_claim_token and state in ('claimed','needs_reconciliation') and (provider_run_id is null or provider_run_id=p_provider_run_id);
  return found;
end; $$;

create function public.settle_provider_operation(p_operation_id uuid,p_claim_token text,p_outcome text,p_actual_usd numeric default null,p_authoritative boolean default false,p_terminal_verified boolean default false)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_op public.provider_operations%rowtype; v_actual numeric(12,6);
begin
  perform 1 from public.budget_guard where singleton for update;
  select * into v_op from public.provider_operations where id=p_operation_id for update;
  if not found then return jsonb_build_object('settled',false,'reason','operation_not_found'); end if;
  if v_op.state='settled' then return jsonb_build_object('settled',true,'reused',true,'chargedUsd',v_op.charged_usd); end if;
  if v_op.claim_token is distinct from p_claim_token then return jsonb_build_object('settled',false,'reason','claim_mismatch'); end if;
  if p_outcome is null or p_outcome not in ('completed','failed','cancelled','not-started','unknown') then return jsonb_build_object('settled',false,'reason','invalid_outcome'); end if;
  if v_op.state='reserved' then
    if not coalesce(p_authoritative,false) or p_outcome<>'not-started' or coalesce(p_actual_usd,0)<>0 then
      return jsonb_build_object('settled',false,'reason','not_started_evidence_required');
    end if;
    v_actual:=0;
  elsif v_op.kind='agent' then
    if not coalesce(p_authoritative,false) or not coalesce(p_terminal_verified,false) or p_outcome='unknown' or p_actual_usd is null then
      update public.provider_operations set state='needs_reconciliation',outcome=p_outcome,terminal_verified=terminal_verified or (coalesce(p_terminal_verified,false) and p_outcome in ('completed','failed','cancelled')),updated_at=now() where id=p_operation_id;
      return jsonb_build_object('settled',false,'state','needs_reconciliation','reservedUsd',v_op.reserved_usd);
    end if;
    if p_actual_usd<0 or p_actual_usd>1000 or p_actual_usd::text in ('NaN','Infinity','-Infinity') then
      return jsonb_build_object('settled',false,'reason','invalid_cost');
    end if;
    if p_outcome='not-started' and (p_actual_usd<>0 or v_op.provider_run_id is not null) then return jsonb_build_object('settled',false,'reason','claimed_submission_uncertain'); end if;
    v_actual:=p_actual_usd;
  else
    -- Each admitted Search/Fetch dispatch is conservatively charged once, even if its HTTP response is lost.
    v_actual:=v_op.charged_usd;
  end if;
  update public.budget_guard set reserved_usd=reserved_usd-v_op.reserved_usd,spent_usd=spent_usd+(v_actual-v_op.charged_usd),updated_at=now() where singleton;
  insert into public.budget_ledger(operation_id,event,reserved_delta,spent_delta) values(v_op.id,'reconcile',-v_op.reserved_usd,v_actual-v_op.charged_usd);
  update public.provider_operations set state='settled',outcome=p_outcome,terminal_verified=true,reserved_usd=0,charged_usd=v_actual,updated_at=now() where id=p_operation_id;
  return jsonb_build_object('settled',true,'reused',false,'chargedUsd',v_actual);
end; $$;

create function public.list_provider_operations(p_run_id uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $$
select coalesce(jsonb_agg(jsonb_build_object('id',id,'claimToken',claim_token,'providerRunId',provider_run_id,'state',state,'kind',kind,'reservedUsd',reserved_usd,'chargedUsd',charged_usd,'outcome',outcome,'terminalVerified',terminal_verified) order by created_at),'[]'::jsonb)
from public.provider_operations where run_id=p_run_id;
$$;
create function public.get_user_provider_operations(p_owner_id uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $$
select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'claimToken',o.claim_token,'providerRunId',o.provider_run_id,'state',o.state,'kind',o.kind,'runId',o.run_id)),'[]'::jsonb)
from public.provider_operations o join public.search_runs r on r.id=o.run_id where r.owner_id=p_owner_id and o.state<>'settled';
$$;
create function public.get_authorized_job(p_job_id text,p_actor_key text,p_search_id uuid default null,p_owner_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_job jsonb;
begin
  -- p_owner_id comes exclusively from the Worker's verified Auth user, never request JSON.
  if p_owner_id is not null then
    select v.job into v_job from public.saved_jobs s join public.verified_jobs v on v.job_id=s.job_id where s.user_id=p_owner_id and s.job_id=p_job_id;
    if found then return v_job; end if;
  end if;
  select j.value into v_job from public.search_runs r cross join lateral jsonb_array_elements(coalesce(r.payload->'results','[]'::jsonb)) j
  where r.actor_key=p_actor_key and (p_search_id is null or r.id=p_search_id) and r.expires_at>now() and j.value->>'id'=p_job_id
  order by r.created_at desc limit 1;
  return v_job;
end; $$;
create function public.get_search_cache(p_fingerprint text) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $$
select payload from public.search_cache where fingerprint=p_fingerprint and expires_at>now();
$$;
create function public.put_search_cache(p_fingerprint text,p_payload jsonb,p_ttl_seconds integer default 21600) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_fingerprint is null or length(p_fingerprint) not between 1 and 256 or p_ttl_seconds is null or p_ttl_seconds not between 1 and 21600
    or jsonb_typeof(p_payload->'results') is distinct from 'array' then return false; end if;
  insert into public.search_cache(fingerprint,payload,expires_at)
  values(p_fingerprint,jsonb_build_object('results',p_payload->'results','sources',coalesce(p_payload->'sources','[]'::jsonb),'errors',coalesce(p_payload->'errors','[]'::jsonb)),now()+make_interval(secs=>p_ttl_seconds))
  on conflict(fingerprint) do update set payload=excluded.payload,expires_at=excluded.expires_at,created_at=now();
  perform public.firstrole_index_jobs(p_payload);
  return true;
end; $$;

-- Private tables deliberately have no browser policies; API callers cannot invoke these RPCs.
do $$
declare v_name text; v_function record;
begin
  foreach v_name in array array['budget_guard','daily_usage','search_runs','provider_operations','budget_ledger','search_cache','verified_jobs'] loop
    execute format('alter table public.%I enable row level security',v_name);
    execute format('revoke all on public.%I from public, anon, authenticated',v_name);
    execute format('grant all on public.%I to service_role',v_name);
  end loop;
  for v_function in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('firstrole_touch_updated_at','firstrole_index_jobs','create_search_run','get_search_run','get_internal_search_run','update_search_run','request_search_cancel','cancel_user_searches','reserve_provider_operation','claim_provider_operation','bind_provider_run','settle_provider_operation','list_provider_operations','get_user_provider_operations','get_authorized_job','get_search_cache','put_search_cache') loop
    execute format('revoke all on function %s from public, anon, authenticated',v_function.signature);
    execute format('grant execute on function %s to service_role',v_function.signature);
  end loop;
end; $$;
revoke all on sequence public.budget_ledger_id_seq from public, anon, authenticated;
grant usage, select on sequence public.budget_ledger_id_seq to service_role;
commit;
