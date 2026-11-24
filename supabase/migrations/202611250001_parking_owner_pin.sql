-- Owner PIN sign-in: one secret device key per Owner, handed only to devices approved with a
-- one-time recovery code. The sign-in password is derived from this key plus the PIN, so the
-- PIN alone is useless on any other device. Readable by the service role only.
alter table public.parking_owner_recovery add column if not exists device_key text check (device_key ~ '^[a-f0-9]{32,64}$');
