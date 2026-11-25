-- Saved plate scans for training the plate reader (the owner agreed to saving scans).
-- One row per saved scan: the plate picture (private storage bucket "scans"), what the scanner read,
-- and the plate the operator finally saved. Deleted after 30 days by the server's daily clean-up.
create table public.parking_scans (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  path text not null unique,
  read_plate text not null check (read_plate ~ '^[A-Z0-9]{0,20}$'),
  confirmed_plate text not null check (confirmed_plate ~ '^[A-Z0-9]{4,20}$'),
  ticket_id text not null,
  source text not null default 'entry'
);
create index parking_scans_created_at on public.parking_scans (created_at);
alter table public.parking_scans enable row level security;
revoke all on public.parking_scans from public, anon, authenticated;
grant select, insert, delete on public.parking_scans to service_role;
grant usage, select on sequence public.parking_scans_id_seq to service_role;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('scans', 'scans', false, 204800, array['image/jpeg']) on conflict (id) do nothing;
