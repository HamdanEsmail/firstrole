-- Removes only the exact disposable objects created by concurrency-isolated-setup.sql.
-- Refuses cleanup unless the schema carries our exact ownership marker.
-- Does not change any public production table, function, budget, user, or ledger.
begin;
do $$
begin
  if obj_description('firstrole_concurrency_qa20260930'::regnamespace,'pg_namespace') is distinct from
    'FirstRole disposable concurrency QA 20260930; fictional funds only' then
    raise exception 'QA schema marker mismatch; refusing cleanup';
  end if;
end $$;
drop function public.qa_firstrole_concurrency_20260930(text,jsonb);
drop schema firstrole_concurrency_qa20260930 cascade;
commit;
