begin;

create table public.parking_sites (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  operator_name text not null check (btrim(operator_name) <> ''),
  address text not null default '',
  phone text not null default '',
  capacity integer not null check (capacity > 0),
  pay_at_entry boolean not null default false,
  cancel_needs_reason boolean not null default false
);

create table public.parking_tariffs (
  site_id uuid not null references public.parking_sites (id),
  version integer not null check (version > 0),
  effective_at timestamptz not null default now(),
  grace_minutes integer not null check (grace_minutes >= 0),
  rates jsonb not null check (jsonb_typeof(rates) = 'object' and rates <> '{}'::jsonb),
  note text not null default '',
  primary key (site_id, version)
);

create table public.parking_tickets (
  id bigint generated always as identity primary key,
  token uuid not null unique default gen_random_uuid(),
  site_id uuid not null references public.parking_sites (id),
  plate text not null check (plate ~ '^[A-Z0-9]{4,20}$'),
  category text not null check (btrim(category) <> ''),
  tariff_version integer not null,
  entry_at timestamptz not null default now(),
  entry_gate text not null,
  prepaid_hours integer not null default 0 check (prepaid_hours >= 0),
  status text not null default 'inside' check (status in ('inside', 'paid', 'exited', 'cancelled')),
  billed_at timestamptz,
  total_paise integer check (total_paise >= 0),
  exit_at timestamptz check (exit_at >= entry_at),
  exit_gate text,
  cancelled_at timestamptz,
  cancel_reason text,
  prints integer not null default 0 check (prints >= 0),
  revision integer not null default 0 check (revision >= 0),
  foreign key (site_id, tariff_version) references public.parking_tariffs (site_id, version),
  check ((status = 'exited') = (exit_at is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check (status not in ('paid', 'exited') or (billed_at is not null and total_paise is not null))
);

create unique index parking_one_active_plate_per_site
on public.parking_tickets (site_id, plate) where status in ('inside', 'paid');

create table public.parking_payments (
  receipt_no bigint generated always as identity primary key,
  ticket_id bigint not null references public.parking_tickets (id),
  kind text not null check (kind in ('prepaid', 'exit')),
  method text not null default 'cash' check (method = 'cash'),
  amount_paise integer not null check (amount_paise > 0),
  collected_at timestamptz not null default now(),
  gate text not null,
  unique (ticket_id, kind)
);

create table public.parking_audit (
  id bigint generated always as identity primary key,
  site_id uuid not null references public.parking_sites (id),
  ticket_id bigint references public.parking_tickets (id),
  event_type text not null,
  gate text,
  happened_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb
);

alter table public.parking_sites enable row level security;
alter table public.parking_tariffs enable row level security;
alter table public.parking_tickets enable row level security;
alter table public.parking_payments enable row level security;
alter table public.parking_audit enable row level security;

-- The parking API will authorize devices and use server-side access.
-- Browser roles must not be able to read or alter gate records directly.
revoke all on public.parking_sites, public.parking_tariffs, public.parking_tickets,
  public.parking_payments, public.parking_audit from public, anon, authenticated;
grant select, insert, update on public.parking_sites, public.parking_tickets to service_role;
grant select, insert on public.parking_tariffs, public.parking_payments, public.parking_audit to service_role;
grant usage, select on sequence public.parking_tickets_id_seq,
  public.parking_payments_receipt_no_seq, public.parking_audit_id_seq to service_role;

commit;
