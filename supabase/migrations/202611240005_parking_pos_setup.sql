begin;
create table public.parking_pos_setup (
  mobile text primary key check (mobile ~ '^\+91[6-9][0-9]{9}$'),
  label text not null,
  gate text not null check (gate in ('entry', 'exit', 'both')),
  code_hash text not null check (code_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  invalidate_before timestamptz
);
alter table public.parking_pos_setup enable row level security;
revoke all on public.parking_pos_setup from public, anon, authenticated;
grant select, insert, update on public.parking_pos_setup to service_role;

create function public.parking_pos_session_valid(operator_id uuid, operator_session uuid, operator_mobile text)
returns boolean
language sql stable security invoker set search_path = ''
as $$
  select exists (
    select 1 from auth.sessions as session
    where session.id = operator_session and session.user_id = operator_id
      and session.created_at >= coalesce(
        (select setup.invalidate_before from public.parking_pos_setup as setup where setup.mobile = operator_mobile),
        '-infinity'::timestamptz
      )
  );
$$;
revoke all on function public.parking_pos_session_valid(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.parking_pos_session_valid(uuid, uuid, text) to service_role;
commit;
