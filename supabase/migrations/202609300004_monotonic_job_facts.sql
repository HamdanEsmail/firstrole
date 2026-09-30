-- Preserve the newest observed public job facts when Workflows finish out of order.
-- Function changes only: no existing catalog, account, or budget rows are rewritten.
begin;

create or replace function public.firstrole_job_checked_at(p_job jsonb) returns timestamptz
language plpgsql immutable strict security invoker set search_path = pg_catalog as $$
declare v_text text := p_job->>'checkedAt'; v_time timestamptz;
begin
  -- Require an explicit ISO timezone; reject relative dates and malformed legacy values.
  if jsonb_typeof(p_job->'checkedAt') is distinct from 'string'
    or v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then
    return null;
  end if;
  v_time := v_text::timestamptz;
  if not isfinite(v_time) then return null; end if;
  return v_time;
exception when data_exception then
  return null;
end;
$$;

create or replace function public.firstrole_index_jobs(p_payload jsonb) returns void
language sql security definer set search_path = pg_catalog, public as $$
with candidates as (
  select j.job, j.position, public.firstrole_job_checked_at(j.job) as checked_at
  from jsonb_array_elements(coalesce(p_payload->'results','[]'::jsonb)) with ordinality as j(job,position)
  where jsonb_typeof(j.job->'id')='string'
    and length(j.job->>'id') between 1 and 256
    and jsonb_typeof(j.job->'sourceUrl')='string'
), newest as (
  select distinct on (job->>'id') job
  from candidates
  order by job->>'id', checked_at desc nulls last, position
)
insert into public.verified_jobs as existing(job_id,job)
select job->>'id',job from newest
on conflict(job_id) do update set job=excluded.job,updated_at=now()
where public.firstrole_job_checked_at(excluded.job) is not null
  and (
    public.firstrole_job_checked_at(existing.job) is null
    or public.firstrole_job_checked_at(excluded.job)>public.firstrole_job_checked_at(existing.job)
  );
$$;

-- CREATE OR REPLACE retains the original function identity and owner. Keep the
-- existing service-only execution boundary, including for the new pure helper.
revoke all on function public.firstrole_job_checked_at(jsonb) from public, anon, authenticated;
grant execute on function public.firstrole_job_checked_at(jsonb) to service_role;
revoke all on function public.firstrole_index_jobs(jsonb) from public, anon, authenticated;
grant execute on function public.firstrole_index_jobs(jsonb) to service_role;
commit;
