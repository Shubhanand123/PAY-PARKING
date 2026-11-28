-- Step 7 (28 Nov 2026): photos customers attach to a complaint (at most 3 per complaint).
-- Private bucket: only the server (service role) reads or writes it; the Owner dashboard gets a
-- 5-minute signed link per photo. Photos are deleted with their complaint 180 days after it is closed
-- (Edge Function daily clean-up). The complaints themselves live in the parking_runtime state row,
-- are sent only to the Owner, and are copied nowhere else except the nightly backup (kept 30 days).
-- NOT applied to the live project yet: apply after the owner has tested and says "go live".
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('complaints', 'complaints', false, 409600, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
