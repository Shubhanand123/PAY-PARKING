begin;
create table public.parking_runtime (
  id boolean primary key default true check (id),
  version bigint not null default 0,
  db jsonb not null check (jsonb_typeof(db) = 'object')
);
create table public.parking_devices (
  key_hash text primary key check (key_hash ~ '^[a-f0-9]{64}$'),
  role text not null check (role in ('entry', 'exit', 'owner')),
  label text not null,
  enabled boolean not null default true
);
alter table public.parking_runtime enable row level security;
alter table public.parking_devices enable row level security;
revoke all on public.parking_runtime, public.parking_devices from public, anon, authenticated;
grant select, insert, update on public.parking_runtime to service_role;
grant select on public.parking_devices to service_role;
commit;
