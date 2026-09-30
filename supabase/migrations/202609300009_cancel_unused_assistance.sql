-- Cancellation uses its existing transaction to return an unused assistance
-- admission. No retroactive updates, financial changes or additional HTTP calls.
begin;
create or replace function public.request_search_cancel(p_run_id uuid,p_actor_key text) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_changed boolean;
begin
  perform 1 from public.budget_guard where singleton for update;
  update public.search_runs set cancel_requested=true,updated_at=now(),payload=payload || jsonb_build_object('status','cancelled','stage','Search cancelled','updatedAt',now())
  where id=p_run_id and actor_key=p_actor_key and payload->>'status' not in ('completed','partial','failed','cancelled');
  v_changed:=found;
  if v_changed then perform public.release_unused_agent_allowance(p_run_id); end if;
  return v_changed;
end; $$;
-- CREATE OR REPLACE retains the original function identity, owner and ACL.
commit;
