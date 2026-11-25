-- Owner PIN works on any device: a new device asks the server for the Owner's device key with mobile + PIN.
-- Wrong PINs are counted; 5 in a row lock PIN sign-in for 15 minutes.
alter table public.parking_owner_recovery add column if not exists failed_attempts integer not null default 0;
alter table public.parking_owner_recovery add column if not exists locked_until timestamptz;
