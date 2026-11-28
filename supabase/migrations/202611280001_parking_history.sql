-- Step 2 (28 Nov 2026): permanent history in proper tables, next to the live state row.
-- Every save of parking_runtime copies its tickets, payments and new audit entries here (trigger below),
-- so the app keeps working unchanged and nothing it trims from the state row is ever lost.
--  * parking_events   : append-only log; each row carries a SHA-256 fingerprint chained to the row before,
--                       and update/delete are refused, so any later change would be detectable.
--  * parking_ticket_history  : one row per ticket, latest version (+ frozen receipt).
--  * parking_payment_history : one row per payment.
--  * parking_backups  : a full copy of the state every night (kept 30 days), see the cron job at the end.

create table if not exists public.parking_events (
  seq bigint generated always as identity primary key,
  event_id text not null unique,          -- id of the audit entry in the app
  at timestamptz not null,
  at_ms bigint not null,                  -- exact app time (ms), used in the fingerprint
  actor text not null default '',
  kind text not null,
  ticket_id text,
  text text not null default '',
  amount_paise bigint,
  recorded_at timestamptz not null default now(),
  prev_hash text not null,
  hash text not null
);
create index if not exists parking_events_ticket on public.parking_events (ticket_id);
create index if not exists parking_events_at on public.parking_events (at);

create table if not exists public.parking_ticket_history (
  id text primary key,
  token text not null,
  plate text not null,
  category text,
  status text not null,
  entry_at timestamptz,
  entry_gate text,
  entry_by text,
  exit_at timestamptz,
  exit_gate text,
  exit_by text,
  total_paise bigint,
  rev int,
  receipt jsonb,
  data jsonb not null,
  first_seen timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists parking_ticket_history_plate on public.parking_ticket_history (plate);
create index if not exists parking_ticket_history_entry on public.parking_ticket_history (entry_at);

create table if not exists public.parking_payment_history (
  id text primary key,
  ticket_id text not null,
  amount_paise bigint not null,
  method text not null,
  kind text,
  receipt_no text,
  provider_payment_id text,
  at timestamptz not null,
  actor text,
  data jsonb not null
);
create index if not exists parking_payment_history_ticket on public.parking_payment_history (ticket_id);
create index if not exists parking_payment_history_at on public.parking_payment_history (at);

create table if not exists public.parking_backups (
  day date primary key,
  version bigint,
  db jsonb not null,
  created_at timestamptz not null default now()
);

-- Only the server (service role) touches these tables.
alter table public.parking_events enable row level security;
alter table public.parking_ticket_history enable row level security;
alter table public.parking_payment_history enable row level security;
alter table public.parking_backups enable row level security;

-- The log cannot be edited or deleted, by anyone.
create or replace function public.parking_events_locked() returns trigger language plpgsql as $$
begin
  raise exception 'parking_events is append-only: entries cannot be changed or deleted';
end $$;
drop trigger if exists parking_events_no_change on public.parking_events;
create trigger parking_events_no_change before update or delete on public.parking_events
  for each row execute function public.parking_events_locked();
drop trigger if exists parking_events_no_truncate on public.parking_events;
create trigger parking_events_no_truncate before truncate on public.parking_events
  for each statement execute function public.parking_events_locked();

-- Copy the state row into the history tables.
create or replace function public.parking_copy_history(state jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  e jsonb; t jsonb; p jsonb;
  last_hash text;
  h text;
begin
  -- events: in the order the app wrote them; skip ones already recorded
  select hash into last_hash from parking_events order by seq desc limit 1;
  last_hash := coalesce(last_hash, 'genesis');
  for e in select value from jsonb_array_elements(coalesce(state->'audit', '[]'::jsonb)) loop
    if e->>'id' is null or exists (select 1 from parking_events where event_id = e->>'id') then continue; end if;
    h := encode(digest(last_hash || '|' || (e->>'id') || '|' || coalesce(e->>'at','') || '|' || coalesce(e->>'by','') || '|' ||
                       coalesce(e->>'kind','') || '|' || coalesce(e->>'ticketId','') || '|' || coalesce(e->>'text','') || '|' ||
                       coalesce(e->>'amountPaise',''), 'sha256'), 'hex');
    insert into parking_events (event_id, at, at_ms, actor, kind, ticket_id, text, amount_paise, prev_hash, hash)
    values (e->>'id', to_timestamp((e->>'at')::bigint / 1000.0), (e->>'at')::bigint, coalesce(e->>'by',''), coalesce(e->>'kind',''),
            e->>'ticketId', coalesce(e->>'text',''), (e->>'amountPaise')::bigint, last_hash, h);
    last_hash := h;
  end loop;

  for t in select value from jsonb_array_elements(coalesce(state->'tickets', '[]'::jsonb)) loop
    insert into parking_ticket_history as x (id, token, plate, category, status, entry_at, entry_gate, entry_by, exit_at, exit_gate, exit_by, total_paise, rev, receipt, data)
    values (t->>'id', t->>'token', t->>'plate', t->>'category', t->>'status',
            to_timestamp((t->>'entryAt')::bigint / 1000.0), t->>'entryGate', t->>'entryBy',
            case when t ? 'exitAt' then to_timestamp((t->>'exitAt')::bigint / 1000.0) end, t->>'exitGate', t->>'exitBy',
            (t->>'totalPaise')::bigint, (t->>'rev')::int, t->'receipt', t)
    on conflict (id) do update set
      status = excluded.status, plate = excluded.plate, category = excluded.category,
      exit_at = excluded.exit_at, exit_gate = excluded.exit_gate, exit_by = excluded.exit_by,
      total_paise = excluded.total_paise, rev = excluded.rev, receipt = coalesce(excluded.receipt, x.receipt),
      data = excluded.data, updated_at = now()
    where x.rev is distinct from excluded.rev or x.data is distinct from excluded.data;
  end loop;

  for p in select value from jsonb_array_elements(coalesce(state->'payments', '[]'::jsonb)) loop
    insert into parking_payment_history (id, ticket_id, amount_paise, method, kind, receipt_no, provider_payment_id, at, actor, data)
    values (p->>'id', p->>'ticketId', (p->>'amountPaise')::bigint, p->>'method', p->>'kind', p->>'receiptNo',
            p->>'providerPaymentId', to_timestamp((p->>'at')::bigint / 1000.0), p->>'by', p)
    on conflict (id) do nothing;
  end loop;
end $$;

create or replace function public.parking_runtime_history() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  begin
    perform public.parking_copy_history(new.db);
  exception when others then
    -- never block the parking itself; the next save copies again (everything is idempotent)
    raise warning 'parking history copy failed: %', sqlerrm;
  end;
  return new;
end $$;
drop trigger if exists parking_runtime_history on public.parking_runtime;
create trigger parking_runtime_history after insert or update of db on public.parking_runtime
  for each row execute function public.parking_runtime_history();

revoke all on function public.parking_copy_history(jsonb) from public, anon, authenticated;

-- Copy what exists now.
select public.parking_copy_history(db) from public.parking_runtime;

-- Check the fingerprint chain: returns the first broken row, or nothing when the log is intact.
create or replace function public.parking_events_verify() returns table(seq bigint, problem text)
language plpgsql security definer set search_path = public, extensions as $$
declare r record; prev text := 'genesis'; h text;
begin
  for r in select * from parking_events order by parking_events.seq loop
    h := encode(digest(prev || '|' || r.event_id || '|' || r.at_ms::text || '|' || r.actor || '|' ||
                       r.kind || '|' || coalesce(r.ticket_id,'') || '|' || r.text || '|' || coalesce(r.amount_paise::text,''), 'sha256'), 'hex');
    if r.prev_hash <> prev or r.hash <> h then seq := r.seq; problem := 'fingerprint does not match'; return next; return; end if;
    prev := r.hash;
  end loop;
end $$;
revoke all on function public.parking_events_verify() from public, anon, authenticated;

-- Nightly backup at 2:00 am India time (20:30 UTC), keep 30 days.
select cron.unschedule(jobid) from cron.job where jobname = 'parking-nightly-backup';
select cron.schedule('parking-nightly-backup', '30 20 * * *', $$
  insert into public.parking_backups (day, version, db)
  select (now() at time zone 'Asia/Kolkata')::date, version, db from public.parking_runtime
  on conflict (day) do update set version = excluded.version, db = excluded.db, created_at = now();
  delete from public.parking_backups where day < (now() at time zone 'Asia/Kolkata')::date - 30;
$$);
