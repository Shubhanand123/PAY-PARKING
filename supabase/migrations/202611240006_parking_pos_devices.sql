begin;
alter table public.parking_devices
  drop constraint parking_devices_role_check,
  add constraint parking_devices_role_check check (role in ('entry', 'exit', 'both', 'owner')),
  add column pairing_expires_at timestamptz;
grant insert on public.parking_devices to service_role;
grant update (key_hash, pairing_expires_at) on public.parking_devices to service_role;
commit;
