begin;
alter table public.parking_devices
  add column id uuid not null default gen_random_uuid() unique;
grant update (enabled) on public.parking_devices to service_role;
commit;
