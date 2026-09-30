-- New 20-step Agent path. Legacy reserve_provider_operation remains untouched at
-- $2.50; existing balances, operations, receipts and holds are not rewritten.
-- Backend must submit agent_config.max_steps=20 and keep verified rate <=$0.016.
begin;
create function public.reserve_bounded_agent_operation(
  p_run_id uuid,p_operation_key text,p_source_host text,p_max_steps integer,p_reservation_usd numeric
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_guard public.budget_guard%rowtype; v_op public.provider_operations%rowtype; v_run public.search_runs%rowtype;
  v_count integer; v_host text:=lower(p_source_host); v_key text;
begin
  if p_max_steps is distinct from 20 or p_reservation_usd is distinct from 0.35
    or p_operation_key is null or length(p_operation_key) not between 1 and 246
    or p_operation_key like 'bounded20:%'
    or v_host is null or length(v_host)>253 or v_host !~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$' then
    return jsonb_build_object('allowed',false,'reason','invalid_agent_bound');
  end if;
  v_key:='bounded20:'||p_operation_key;
  -- Identical first lock as the legacy path: old/new callers share one envelope.
  select * into v_guard from public.budget_guard where singleton for update;
  -- Preserve an existing legacy operation if an upgraded caller resumes its run.
  -- Otherwise use an internal key namespace so unchanged legacy code cannot
  -- accidentally claim a new smaller reservation and submit an unbounded run.
  select * into v_op from public.provider_operations where run_id=p_run_id and operation_key=p_operation_key;
  if not found then
    select * into v_op from public.provider_operations where run_id=p_run_id and operation_key=v_key;
  end if;
  if found then
    if v_op.kind is distinct from 'agent' or v_op.units is distinct from 1 or v_op.source_host is distinct from v_host then
      return jsonb_build_object('allowed',false,'reason','idempotency_conflict');
    end if;
    return jsonb_build_object('allowed',true,'operationId',v_op.id,'state',v_op.state,'reservedUsd',v_op.reserved_usd,'reused',true);
  end if;
  select * into v_run from public.search_runs where id=p_run_id;
  if not found or v_run.cancel_requested or v_run.expires_at<=now() or v_run.payload->>'status' in ('completed','partial','failed','cancelled') then
    return jsonb_build_object('allowed',false,'reason','run_inactive');
  end if;
  if not v_guard.enabled then return jsonb_build_object('allowed',false,'reason','search_disabled'); end if;
  if v_guard.spent_usd+v_guard.reserved_usd+0.35>v_guard.limit_usd then return jsonb_build_object('allowed',false,'reason','budget_exhausted'); end if;
  if not v_run.assisted then return jsonb_build_object('allowed',false,'reason','assistance_not_admitted'); end if;
  if exists(select 1 from public.provider_operations where run_id=p_run_id and kind='agent' and not(state='settled' and outcome='not-started')) then
    return jsonb_build_object('allowed',false,'reason','run_agent_limit');
  end if;
  select count(*) into v_count from public.provider_operations where kind='agent' and state<>'settled' and not terminal_verified;
  if v_count>=2 then return jsonb_build_object('allowed',false,'reason','global_agent_concurrency'); end if;
  if exists(select 1 from public.provider_operations where kind='agent' and source_host=v_host and state<>'settled' and not terminal_verified) then
    return jsonb_build_object('allowed',false,'reason','source_agent_concurrency');
  end if;
  select count(*) into v_count from public.provider_operations where kind='agent' and not(state='settled' and outcome='not-started')
    and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
  if v_count>=4 then return jsonb_build_object('allowed',false,'reason','global_agent_daily_limit'); end if;
  insert into public.provider_operations(run_id,operation_key,kind,units,source_host,reserved_usd)
  values(p_run_id,v_key,'agent',1,v_host,0.35) returning * into v_op;
  update public.budget_guard set reserved_usd=reserved_usd+0.35,updated_at=now() where singleton;
  insert into public.budget_ledger(operation_id,event,reserved_delta,spent_delta) values(v_op.id,'reserve',0.35,0);
  return jsonb_build_object('allowed',true,'operationId',v_op.id,'state',v_op.state,'reservedUsd',v_op.reserved_usd,'reused',false);
end; $$;
revoke all on function public.reserve_bounded_agent_operation(uuid,text,text,integer,numeric) from public,anon,authenticated;
grant execute on function public.reserve_bounded_agent_operation(uuid,text,text,integer,numeric) to service_role;
commit;
