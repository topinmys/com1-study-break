-- All attendee/auth tables live outside the exposed public schema.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create table private.event_settings (
  id boolean primary key default true check (id),
  capacity integer not null default 150 check (capacity = 150)
);
insert into private.event_settings default values;

create table private.attendees (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (char_length(full_name) between 2 and 100 and full_name = btrim(full_name)),
  email text not null unique check (email = lower(btrim(email)) and char_length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  student_id text not null unique check (student_id = upper(btrim(student_id)) and student_id ~ '^[A-Z0-9]{6,20}$'),
  telegram text not null check (telegram ~ '^[A-Za-z][A-Za-z0-9_]{4,31}$'),
  registered_at timestamptz not null default now(),
  checked_in_at timestamptz,
  collected_at timestamptz,
  check (collected_at is null or (checked_in_at is not null and collected_at >= checked_in_at))
);
create table private.organiser_sessions (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null default (now() + interval '2 hours')
);
create table private.login_limits (
  bucket text primary key,
  started_at timestamptz not null,
  attempts integer not null check (attempts > 0)
);

alter table private.event_settings enable row level security;
alter table private.attendees enable row level security;
alter table private.organiser_sessions enable row level security;
alter table private.login_limits enable row level security;
-- No public policies: only the tightly scoped definer functions below access data.
revoke all on all tables in schema private from public, anon, authenticated, service_role;
alter default privileges in schema private revoke all on tables from public, anon, authenticated, service_role;

create function public.event_capacity() returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object('capacity', s.capacity, 'registered', count(a.id),
    'remaining', greatest(0, s.capacity - count(a.id)))
  from private.event_settings s left join private.attendees a on true group by s.capacity;
$$;

create function public.event_register(p_name text, p_email text, p_student_id text, p_telegram text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare limit_count integer; new_id uuid;
begin
  -- Serialise reservations on one row; the count and insert are one transaction.
  select capacity into limit_count from private.event_settings where id = true for update;
  if exists(select 1 from private.attendees where email = lower(btrim(p_email)) or student_id = upper(btrim(p_student_id))) then
    raise exception 'DUPLICATE' using errcode = 'P0001';
  end if;
  if (select count(*) from private.attendees) >= limit_count then
    raise exception 'FULL' using errcode = 'P0001';
  end if;
  insert into private.attendees(full_name, email, student_id, telegram)
  values (btrim(p_name), lower(btrim(p_email)), upper(btrim(p_student_id)), regexp_replace(btrim(p_telegram), '^@', ''))
  returning id into new_id;
  return jsonb_build_object('reserved', true, 'reference', new_id);
end;
$$;

create function public.login_allow(p_bucket text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare global_attempts integer; ip_attempts integer;
begin
  if p_bucket !~ '^[a-f0-9]{64}$' then return false; end if;
  -- Bound retained limiter storage; fixed windows are deliberately simple.
  delete from private.login_limits where started_at < now() - interval '1 day';
  insert into private.login_limits values ('global', now(), 1)
  on conflict (bucket) do update set
    attempts = case when private.login_limits.started_at < now() - interval '10 minutes' then 1 else private.login_limits.attempts + 1 end,
    started_at = case when private.login_limits.started_at < now() - interval '10 minutes' then now() else private.login_limits.started_at end
  returning attempts into global_attempts;
  if global_attempts > 100 then return false; end if;
  insert into private.login_limits values (p_bucket, now(), 1)
  on conflict (bucket) do update set
    attempts = case when private.login_limits.started_at < now() - interval '10 minutes' then 1 else private.login_limits.attempts + 1 end,
    started_at = case when private.login_limits.started_at < now() - interval '10 minutes' then now() else private.login_limits.started_at end
  returning attempts into ip_attempts;
  return ip_attempts <= 5;
end;
$$;

create function public.organiser_session_create(p_hash text) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare expiry timestamptz;
begin
  delete from private.organiser_sessions where expires_at <= now();
  insert into private.organiser_sessions(token_hash) values(p_hash) returning expires_at into expiry;
  return expiry;
end;
$$;

create function private.require_session(p_hash text) returns void
language plpgsql set search_path = '' as $$
begin
  if not exists(select 1 from private.organiser_sessions where token_hash = p_hash and expires_at > now()) then
    raise exception 'UNAUTHORISED' using errcode = 'P0001';
  end if;
end;
$$;

create function public.organiser_snapshot(p_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform private.require_session(p_hash);
  select jsonb_build_object('attendees', coalesce(jsonb_agg(to_jsonb(a) order by a.registered_at, a.id), '[]'::jsonb),
    'registered', count(*), 'checkedIn', count(checked_in_at), 'collected', count(collected_at), 'capacity', 150)
  into result from private.attendees a;
  return result;
end;
$$;

create function public.organiser_update(p_hash text, p_id uuid, p_field text, p_value boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare attendee private.attendees;
begin
  perform private.require_session(p_hash);
  if p_value is null or p_field not in ('checkedIn', 'collected') or p_field is null then
    raise exception 'INVALID_ACTION';
  end if;
  select * into attendee from private.attendees where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if p_field = 'collected' then
    if p_value and attendee.checked_in_at is null then raise exception 'CHECK_IN_FIRST'; end if;
    update private.attendees set collected_at = case when p_value then coalesce(collected_at, clock_timestamp()) else null end where id = p_id;
  else
    if not p_value and attendee.collected_at is not null then raise exception 'UNDO_COLLECTION_FIRST'; end if;
    update private.attendees set checked_in_at = case when p_value then coalesce(checked_in_at, clock_timestamp()) else null end where id = p_id;
  end if;
  return jsonb_build_object('saved', true);
end;
$$;

create function public.organiser_logout(p_hash text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_session(p_hash);
  delete from private.organiser_sessions where token_hash = p_hash;
end;
$$;

-- PostgreSQL grants PUBLIC function execution by default. Revoke it explicitly.
revoke all on function private.require_session(text) from public, anon, authenticated, service_role;
revoke all on function public.event_capacity(), public.event_register(text,text,text,text), public.login_allow(text), public.organiser_session_create(text), public.organiser_snapshot(text), public.organiser_update(text,uuid,text,boolean), public.organiser_logout(text) from public, anon, authenticated;
grant execute on function public.event_capacity(), public.event_register(text,text,text,text), public.login_allow(text), public.organiser_session_create(text), public.organiser_snapshot(text), public.organiser_update(text,uuid,text,boolean), public.organiser_logout(text) to service_role;
