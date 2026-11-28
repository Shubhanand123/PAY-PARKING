# PARKER — handoff for a new Claude session (28 Nov 2026)

Work branch: `claude/receipts`. Live site = branch `codex/pay-parking-live` (Cloudflare Pages). **Do not push to the live branch, deploy the Edge Function, or apply new migrations until the owner has tested and says "go live".**

## Live now
- App 3.9 (update button), website with occupancy ring + Daily Summary, Scanned/Typed labels, scan pictures saved.
- Supabase project `uovkdgrloqenejnskeer` (Mumbai), Edge Function `parking` v7 (stub importing commit 61cdbe4).

## Built, not live (test only)
- APK 3.12 release (new YOLOX finder + 4-corner straightening, auto focus, auto light). 3.13/3.14 ideas (multi-frame vote, night brightening) exist as debug builds from another session.
- Step 1 SKC numbers: `src/numbers.ts` (SKC-GA1-YYMM-NNNNN-C, receipts SKC-R-YYMM-NNNNNN), tests `tests/numbers.test.ts`.
- Step 2+3 history tables + nightly backup: `supabase/migrations/202611280001_parking_history.sql` — tested on a local Postgres copy, NOT applied to the live project.
- Step 4 (in progress): SKC logo (`public/skc.png`) on slips/receipts, feedback line on receipts, Owner → Tickets: ticket detail with tabs Entry slip / Receipt / History, search by full/short/old ticket number with check-digit warning.

## Still to build (owner approved, format A, plan phases 1–4)
1. Edge Function actions: `ticketHistory(id)` (from parking_events), vehicle history and search from parking_tickets.
2. Reports & export: date range, Tickets / Payments-GST / Vehicle / Complaints / Audit; CSV + printable PDF with letterhead and a check code; public verify page.
3. Day closing (cash count vs expected, lock).
4. Complaint system: customer page button (receipt QR page), smiley quick rating + form (name, mobile, type, message, ≤3 photos, consent), complaint numbers SKC-C-YYMM-NNN, status page/chat reply; owner card + Complaints section + detail (call/WhatsApp, linked ticket, status, reply, internal note), photo viewer, monthly summary; private storage bucket; privacy policy + parking terms pages (DPDP Act); retention 180 days after closed.
5. Later: staff roles, WhatsApp/SMS (paid), desktop layout, auto zoom for far plates, training on gate scans.
Mockups were approved: existing customer page + bottom-sheet form with smileys; owner dashboard yellow complaints card.

## Owner still has to send
Business name, address, GSTIN, grievance-officer name + phone/email (for receipts, reports and privacy policy).

## Rules
Commits end with the Co-Authored-By/Claude-Session lines the session gives. Never commit secrets. Training: see `training/README.md`. iOS app is not set up (Android/Capacitor only).
