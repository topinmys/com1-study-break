-- check-in now means the attendee has received their one reserved cup.
-- keep the original migration unchanged so the baseline remains reproducible.
-- remove the old update signature before introducing the simpler check-in operation.
drop function public.organiser_update(text, uuid, text, boolean);
-- one timestamp now represents arrival and cup handover together.
alter table private.attendees drop column collected_at;

-- keep organiser totals derived from saved rows and protect the list with the session guard.
create or replace function public.organiser_snapshot(p_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform private.require_session(p_hash);
  select jsonb_build_object('attendees', coalesce(jsonb_agg(to_jsonb(a) order by a.registered_at, a.id), '[]'::jsonb),
    'registered', count(*), 'checkedIn', count(checked_in_at), 'capacity', 150)
  into result from private.attendees a;
  return result;
end;
$$;

-- the row lock serialises updates; repeated true requests preserve the existing timestamp.
create function public.organiser_update(p_hash text, p_id uuid, p_value boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_session(p_hash);
  if p_value is null then raise exception 'INVALID_ACTION'; end if;
  perform 1 from private.attendees where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  update private.attendees set checked_in_at = case when p_value then coalesce(checked_in_at, clock_timestamp()) else null end where id = p_id;
  return jsonb_build_object('saved', true);
end;
$$;

-- a new function signature needs explicit grants; public users cannot call it directly.
revoke all on function public.organiser_update(text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.organiser_update(text, uuid, boolean) to service_role;
