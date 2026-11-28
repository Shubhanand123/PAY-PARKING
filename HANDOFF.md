# PARKER — handoff for a new Claude session (28 Nov 2026)

**LIVE since 28 Nov 2026, 8:00 pm IST (owner said "go live"):** migrations 202611280001 (history tables renamed parking_ticket_history / parking_payment_history because old empty parking_tickets/parking_payments exist) and 202611280002 applied; Edge Function v8 = commit d04db1f; website = d04db1f. APK update button still 3.9; release APK 3.14 (versionCode 35) sent to the owner for a POS test — publish it on the update button only after the owner confirms the scanner works.

Work branch: `claude/receipts`. Live site = branch `codex/pay-parking-live` (Cloudflare Pages). **Do not push to the live branch, deploy the Edge Function, or apply new migrations until the owner has tested and says "go live".**

## Live now
- App 3.9 (update button), website with occupancy ring + Daily Summary, Scanned/Typed labels, scan pictures saved.
- Supabase project `uovkdgrloqenejnskeer` (Mumbai), Edge Function `parking` v7 (stub importing commit 61cdbe4).

## Built, not live (test only)
- APK 3.12 release (new YOLOX finder + 4-corner straightening, auto focus, auto light). 3.13/3.14 ideas (multi-frame vote, night brightening) exist as debug builds from another session.
- Step 1 SKC numbers: `src/numbers.ts` (SKC-GA1-YYMM-NNNNN-C, receipts SKC-R-YYMM-NNNNNN), tests `tests/numbers.test.ts`.
- Step 2+3 history tables + nightly backup: `supabase/migrations/202611280001_parking_history.sql` — tested on a local Postgres copy, NOT applied to the live project.
- Step 4 (done): SKC logo (`public/skc.png`) on slips/receipts, feedback line on receipts, Owner → Tickets: ticket detail with tabs Entry slip / Receipt / History / All visits, search by full/short/old ticket number with check-digit warning, "Search the permanent history too".
  Server actions `ticketHistory`, `vehicleHistory`, `searchHistory` (Owner only) read `parking_events` / `parking_tickets`; until migration 202611280001 is applied they answer from the live state row (`source: 'live'`).
- Step 5 Reports & export (`src/reports.ts`, Owner → Reports): Tickets / Payments & GST / Vehicles / Day closing / Complaints & feedback / Activity log, date range with presets, preview, CSV (BOM, formula-safe), printed A4 PDF with letterhead + check code + QR. Server action `issueReport` builds the report itself, stores code + totals + SHA-256 of the CSV in `db.reports`; public page `#/verify/CODE` (action `verifyReport`). GST split 18% (9+9, SAC 9967) only when a GSTIN is set.
- Step 6 Day closing (`src/closing.ts`, Owner → Day closing): counts notes/coins against all cash not yet counted (shift-style, since the last close); a difference needs a note; saving stamps those payments with `closeId` (locked, never counted twice) and the close record is permanent. Offline cash sent late lands in the next close and is flagged "sent late". Owner only.
- Step 7 Complaints (`src/complaints.ts`, `src/CustomerCare.tsx`, Owner → Complaints + yellow card on Overview): ticket page has smileys (one rating per ticket), "Raise a complaint" bottom sheet (type chips, message, ≤3 photos shrunk to JPEG ≤1280 px, name, mobile, consent), complaint numbers SKC-C-YYMM-NNN, conversation on the ticket page, customer can write back (reopens a resolved one). Owner: monthly summary, list, detail with Call / WhatsApp, linked ticket, photos viewer (5-min signed links), reply / reply & resolve, status, internal notes (never sent to the customer).
  Privacy: complaints, ratings, reports and cash closes are stripped from every non-Owner snapshot and from the ticket page (`publishState`, `customerView`); the activity log only records complaint number + type. Retention: resolved → closed after 7 quiet days; closed → deleted with photos after 180 days (Edge Function `ping` → `tidyComplaints`).
  Public pages `#/privacy`, `#/terms` (DPDP Act wording, grievance officer from Settings → Grievance officer), links in the ticket page footer.
  Migration `202611280002_parking_complaints.sql` (private `complaints` storage bucket) — written, NOT applied.
- Tests: `tests/closing-complaints-reports.test.ts`, `tests/server-care.test.ts` (all 28 pass: `node --test --experimental-strip-types tests/*.test.ts`).

## To go live (only after the owner tests and says "go live")
1. Apply migrations 202611280001 (history tables, cron backup) and 202611280002 (complaints bucket).
2. Deploy the Edge Function `parking` (stub pointing at the new commit).
3. Merge `claude/receipts` into `codex/pay-parking-live` (Cloudflare Pages publishes).
Until the bucket exists, complaints with photos fail with "photos could not be saved" (without photos they work).

## Still to build (owner approved, later)
Staff roles, WhatsApp/SMS (paid), desktop layout, auto zoom for far plates, training on gate scans. Per-close 58 mm print slip (now printed from Reports → Day closing). Owner to review the privacy/terms wording (e.g. "we reply within 7 days").

## Owner still has to send
Business name, address, GSTIN, grievance-officer name + phone/email (for receipts, reports and privacy policy).

## Rules
Commits end with the Co-Authored-By/Claude-Session lines the session gives. Never commit secrets. Training: see `training/README.md`. iOS app is not set up (Android/Capacitor only).
