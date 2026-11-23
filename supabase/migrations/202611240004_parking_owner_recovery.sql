begin;
create table public.parking_owner_recovery (
  mobile text primary key check (mobile ~ '^\+91[6-9][0-9]{9}$'),
  code_hash text not null check (code_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  invalidate_before timestamptz
);
alter table public.parking_owner_recovery enable row level security;
revoke all on public.parking_owner_recovery from public, anon, authenticated;
grant select, insert, update on public.parking_owner_recovery to service_role;

create function public.parking_owner_session_valid(owner_id uuid, owner_session uuid, owner_mobile text)
returns boolean
language sql stable security invoker set search_path = ''
as $$
  select exists (
    select 1 from auth.sessions as session
    where session.id = owner_session and session.user_id = owner_id
      and session.created_at >= coalesce(
        (select recovery.invalidate_before from public.parking_owner_recovery as recovery where recovery.mobile = owner_mobile),
        '-infinity'::timestamptz
      )
  );
$$;
revoke all on function public.parking_owner_session_valid(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.parking_owner_session_valid(uuid, uuid, text) to service_role;
grant select (id, user_id, created_at) on auth.sessions to service_role;
commit;
