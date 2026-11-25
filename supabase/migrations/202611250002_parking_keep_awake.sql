-- Keep the parking server warm so the first UPI QR after a quiet spell is not slow.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('parking-keep-awake', '*/4 * * * *', $$
  select net.http_post(
    url := 'https://uovkdgrloqenejnskeer.supabase.co/functions/v1/parking',
    body := '{"action":"ping","args":[]}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb
  )
$$);
