-- Run in the parking project's SQL Editor once per device.
-- Change the role and label as needed. Copy the returned code directly
-- into the app's device setup form. Keep it private and never commit it.
with setup as materialized (
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') as code
), registered as (
  insert into public.parking_devices (key_hash, role, label)
  select encode(sha256(convert_to(code, 'UTF8')), 'hex'), 'owner', 'Owner device'
  from setup
  returning label
)
select setup.code as device_setup_code, registered.label from setup cross join registered;
