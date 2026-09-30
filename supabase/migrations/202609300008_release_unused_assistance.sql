-- Return only a never-used browser-assistance admission, once, to its original
-- UTC day. No search counts, provider operations, financial rows or existing
-- records are changed by applying this migration.
begin;

create function public.release_unused_agent_allowance(p_run_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_run public.search_runs%rowtype; v_day date;
begin
  -- Same first lock as reserve/claim/admission: a dispatch cannot race a refund.
  perform 1 from public.budget_guard where singleton for update;
  if not found then return jsonb_build_object('released',false,'reason','guard_missing'); end if;
  select * into v_run from public.search_runs where id=p_run_id for update;
  if not found then return jsonb_build_object('released',false,'reason','run_missing'); end if;
  if not v_run.assisted then return jsonb_build_object('released',false,'reason','not_assisted'); end if;
  if v_run.payload->>'status' is null or v_run.payload->>'status' not in ('completed','partial','failed','cancelled') then
    return jsonb_build_object('released',false,'reason','run_not_terminal');
  end if;
  if v_run.payload->>'cached'='true' then return jsonb_build_object('released',false,'reason','cached_run'); end if;
  if exists(
    select 1 from public.provider_operations where run_id=p_run_id and kind='agent'
      and (state='settled' and outcome='not-started' and terminal_verified
        and charged_usd=0 and reserved_usd=0 and provider_run_id is null) is not true
  ) then return jsonb_build_object('released',false,'reason','agent_operation_present'); end if;
  v_day:=(v_run.created_at at time zone 'UTC')::date;
  -- Both counters must exist and remain positive. Do not repair missing history
  -- or decrement one identity while the other is inconsistent.
  if not exists(select 1 from public.daily_usage where key_kind='actor' and key_hash=v_run.actor_key and usage_date=v_day and assisted>0)
    or not exists(select 1 from public.daily_usage where key_kind='network' and key_hash=v_run.network_key and usage_date=v_day and assisted>0) then
    return jsonb_build_object('released',false,'reason','admission_counters_unavailable');
  end if;
  update public.daily_usage set assisted=assisted-1
    where usage_date=v_day and ((key_kind='actor' and key_hash=v_run.actor_key) or (key_kind='network' and key_hash=v_run.network_key));
  update public.search_runs set assisted=false,updated_at=now() where id=p_run_id;
  return jsonb_build_object('released',true,'usageDate',v_day);
end; $$;

-- Preserve the existing identity, ACL, terminal monotonicity, cancellation fence,
-- creation timestamp and latest-facts catalog call. Take the shared lock before
-- the run lock so the nested release uses the same lock order as Agent dispatch.
create or replace function public.update_search_run(p_run_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_run public.search_runs%rowtype; v_payload jsonb;
begin
  perform 1 from public.budget_guard where singleton for update;
  select * into v_run from public.search_runs where id=p_run_id for update;
  if not found then return null; end if;
  if p_payload ->> 'id' is distinct from p_run_id::text then raise exception 'run identity mismatch'; end if;
  if v_run.payload ->> 'status' in ('completed','partial','failed','cancelled') then
    perform public.release_unused_agent_allowance(p_run_id);
    return v_run.payload;
  end if;
  v_payload := p_payload || jsonb_build_object('createdAt',v_run.payload->'createdAt','updatedAt',now());
  if v_run.cancel_requested then v_payload := v_payload || jsonb_build_object('status','cancelled','stage','Search cancelled'); end if;
  update public.search_runs set payload=v_payload,updated_at=now() where id=p_run_id;
  perform public.firstrole_index_jobs(v_payload);
  perform public.release_unused_agent_allowance(p_run_id);
  return v_payload;
end; $$;

revoke all on function public.release_unused_agent_allowance(uuid) from public,anon,authenticated;
grant execute on function public.release_unused_agent_allowance(uuid) to service_role;
-- CREATE OR REPLACE retains the established service-only update_search_run ACL.
commit;
