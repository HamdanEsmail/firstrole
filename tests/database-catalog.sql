-- Run only in the isolated test database after all migrations. Fixtures roll back.
begin;
create function public.firstrole_catalog_assert(ok boolean,message text) returns void
language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if; end;
$$;

-- The additive replacement preserves function identity, ownership, ACL and search path.
select public.firstrole_catalog_assert(
  p.oid=b.function_oid and p.proowner=b.owner_oid
  and p.proacl::text is not distinct from b.function_acl
  and p.prosecdef=b.security_definer and p.prosecdef
  and p.proconfig::text is not distinct from b.function_config,
  'indexing function owner identity definer ACL and search path preserved')
from pg_proc p cross join firstrole_catalog_migration_baseline b
where p.oid='public.firstrole_index_jobs(jsonb)'::regprocedure;

select public.firstrole_catalog_assert(
  not has_function_privilege('anon','public.firstrole_index_jobs(jsonb)','execute')
  and not has_function_privilege('authenticated','public.firstrole_index_jobs(jsonb)','execute')
  and has_function_privilege('service_role','public.firstrole_index_jobs(jsonb)','execute')
  and not has_function_privilege('anon','public.firstrole_job_checked_at(jsonb)','execute')
  and not has_function_privilege('authenticated','public.firstrole_job_checked_at(jsonb)','execute')
  and has_function_privilege('service_role','public.firstrole_job_checked_at(jsonb)','execute'),
  'catalog functions remain service-only');

do $$ declare v_before jsonb; v_tuple text; v_job jsonb; begin
  perform public.firstrole_index_jobs('{"results":[{"id":"catalog-order","sourceUrl":"https://careers.example.com/jobs/1","checkedAt":"2026-09-30T10:00:00.000Z","availability":"open","title":"Initial"}]}'::jsonb);
  perform public.firstrole_index_jobs('{"results":[{"id":"catalog-order","sourceUrl":"https://careers.example.com/jobs/1","checkedAt":"2026-09-30T12:00:00.000Z","availability":"closed","title":"Latest refresh","salary":{"text":"USD 25/hour"},"requirements":["Degree required"]}]}'::jsonb);
  select to_jsonb(v),v.ctid::text into v_before,v_tuple from public.verified_jobs v where job_id='catalog-order';

  -- A Workflow with an older observation completes after the newer refresh.
  perform public.firstrole_index_jobs('{"results":[{"id":"catalog-order","sourceUrl":"https://careers.example.com/jobs/1","checkedAt":"2026-09-30T11:00:00.000Z","availability":"open","title":"Late older workflow"}]}'::jsonb);
  perform public.firstrole_catalog_assert((select to_jsonb(v)=v_before and v.ctid::text=v_tuple from public.verified_jobs v where job_id='catalog-order'),'older workflow cannot replace or rewrite fresher facts');

  -- Equal instants with different timezone spelling also retain the existing facts.
  perform public.firstrole_index_jobs('{"results":[{"id":"catalog-order","sourceUrl":"https://careers.example.com/jobs/1","checkedAt":"2026-09-30T16:00:00+04:00","availability":"open","title":"Equal instant replacement"}]}'::jsonb);
  perform public.firstrole_catalog_assert((select to_jsonb(v)=v_before and v.ctid::text=v_tuple from public.verified_jobs v where job_id='catalog-order'),'equal instant does not replace fresher catalog record');

  -- Cache publication uses the same indexing function and must obey the same guard.
  perform public.put_search_cache('catalog-late-cache','{"results":[{"id":"catalog-order","sourceUrl":"https://careers.example.com/jobs/1","checkedAt":"2026-09-30T11:30:00.000Z","availability":"open","title":"Older cache payload"}]}'::jsonb);
  perform public.firstrole_catalog_assert((select to_jsonb(v)=v_before from public.verified_jobs v where job_id='catalog-order'),'stale cache publication cannot resurrect a closed listing');

  for v_job in select value from jsonb_array_elements('[{"checkedAt":"not-a-date"},{"checkedAt":"2026-02-30T12:00:00Z"},{"checkedAt":"now"},{"checkedAt":7},{}]'::jsonb) loop
    perform public.firstrole_index_jobs(jsonb_build_object('results',jsonb_build_array(v_job || '{"id":"catalog-order","sourceUrl":"https://careers.example.com/jobs/1","availability":"open"}'::jsonb)));
  end loop;
  perform public.firstrole_catalog_assert((select to_jsonb(v)=v_before from public.verified_jobs v where job_id='catalog-order'),'invalid missing and relative timestamps cannot replace valid checked facts');

  perform public.firstrole_index_jobs('{"results":[{"id":"catalog-order","sourceUrl":"https://careers.example.com/jobs/1","checkedAt":"2026-09-30T13:00:00.000Z","availability":"open","title":"Actually newer check"}]}'::jsonb);
  perform public.firstrole_catalog_assert((select job->>'title'='Actually newer check' and job->>'availability'='open' from public.verified_jobs where job_id='catalog-order'),'a genuinely newer check can update status again');

  -- Multiple versions in one payload choose the newest, regardless of array order.
  perform public.firstrole_index_jobs('{"results":[{"id":"catalog-batch","sourceUrl":"https://careers.example.com/jobs/2","checkedAt":"2026-09-30T10:00:00Z","title":"Old"},{"id":"catalog-batch","sourceUrl":"https://careers.example.com/jobs/2","checkedAt":"2026-09-30T12:00:00Z","title":"Newest"},{"id":"catalog-batch","sourceUrl":"https://careers.example.com/jobs/2","checkedAt":"2026-09-30T11:00:00Z","title":"Middle"}]}'::jsonb);
  perform public.firstrole_catalog_assert((select job->>'title'='Newest' from public.verified_jobs where job_id='catalog-batch'),'newest duplicate within a payload wins');

  -- Existing untimestamped catalog entries remain compatible with a new valid check.
  perform public.firstrole_index_jobs('{"results":[{"id":"catalog-legacy","sourceUrl":"https://careers.example.com/jobs/3","title":"Legacy"}]}'::jsonb);
  perform public.firstrole_index_jobs('{"results":[{"id":"catalog-legacy","sourceUrl":"https://careers.example.com/jobs/3","checkedAt":"2026-09-30T12:00:00Z","title":"Verified legacy replacement"}]}'::jsonb);
  perform public.firstrole_catalog_assert((select job->>'title'='Verified legacy replacement' from public.verified_jobs where job_id='catalog-legacy'),'valid timestamp replaces an untimestamped legacy record');

  perform public.firstrole_index_jobs('{"results":[{"id":3,"sourceUrl":"https://careers.example.com/jobs/4"},{"id":"missing-source"},{"id":"object-source","sourceUrl":{}}]}'::jsonb);
  perform public.firstrole_catalog_assert(not exists(select 1 from public.verified_jobs where job_id in ('3','missing-source','object-source')),'existing job identity and source shape checks preserved');
end $$;

select public.firstrole_catalog_assert(
  (select to_jsonb(g) from public.budget_guard g where singleton)=b.budget_state
  and (select count(*) from public.budget_ledger)=b.ledger_count
  and (select count(*) from public.profiles)=b.profile_count
  and (select count(*) from public.saved_jobs)=b.saved_count
  and (select count(*) from auth.users)=b.user_count,
  'migration and catalog indexing leave budget and account state unchanged')
from firstrole_catalog_migration_baseline b;

select 'Database monotonic catalog and preserved-privilege checks passed' as result;
rollback;
