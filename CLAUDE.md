# Pay Parking: notes for Claude Code

Gate POS (Entry / Exit) and Owner dashboard for a pay-and-park site in Goa. Owner: Saroj Kumar Chowdhary (Sai Express).
React 19 + Vite + TypeScript. Live at https://pay-parking-ekb.pages.dev (Cloudflare Pages, production branch `codex/pay-parking-live`).
Backend: Supabase project `uovkdgrloqenejnskeer` (Mumbai, ap-south-1; moved 25 Nov 2026 from grzmwiegmlefjkjkzbuk, Sydney), Edge Function `parking` (supabase/functions/parking/index.ts). Payments: Razorpay (test keys now).

## How things are wired
- `src/engine.ts` holds every parking rule (bill, tickets, payments, audit). The Edge Function imports it, so client and server use the same code.
- The whole database is ONE JSON row (`parking_runtime`), saved with optimistic versioning. Every device polls `snapshot` every 5 s. Fine for a pilot. Move to proper tables before real traffic.
- **Login is switched off for now.** The site is built with `VITE_OPEN_ACCESS=true` (`.env.production`), and the server's `PARKING_OPEN_ACCESS=true` secret gives role `open` (full access) to requests with no login or device key. To bring login back, remove both.
- Edge Function deploys: the deployed `index.ts` is a one-line stub that imports this file from GitHub raw at a pinned commit. To deploy, push, then redeploy the stub with the new commit hash (or deploy with the Supabase CLI: `supabase functions deploy parking --no-verify-jwt`).

## Payments at the exit gate (`src/RazorpayCheckout.tsx`)
- **Show UPI QR**: the server creates a Razorpay single-use UPI QR (`payments/qr_codes`) for the exact amount. The POS shows it large and polls `check-payment` every 3 s. The server confirms the captured payment with Razorpay, then marks the ticket Paid.
  - Test-mode QRs cannot be paid from real UPI apps. Live keys are needed for that.
- **Card / other · Razorpay**: Razorpay Standard Checkout window. In test mode use card 4111 1111 1111 1111, or UPI `success@razorpay`.
- **Switch to cash**: closes the QR, order or link only after Razorpay confirms nothing was captured.

## Next task: scanning improvements (`src/PlateScanner.tsx`, `src/plate-worker.ts`, `src/plate-reading.ts`)
Current: Tesseract.js with a custom `indplate` model reads a fixed strip of the live video. There's no plate detection, and jsQR runs at the same time every 90 ms on the main thread.
Planned:
1. Ticket QR: use the native `BarcodeDetector` (fast on Android Chrome), with jsQR as the fallback and run less often.
2. Find the plate region before OCR: contrast/edge-based rectangle detection, then a tight crop and deskew.
3. Two-line motorcycle plates: split rows and join them.
4. Tap-to-capture at full resolution, a torch toggle (`applyConstraints({ advanced: [{ torch: true }] })`), and show the frozen frame with the reading.
5. Keep the manual entry path one tap away.
Hardware: an Android POS machine with a built-in barcode scanner and a camera. Brand and model are unknown, so stay generic. The built-in scanner most likely types the ticket QR like a keyboard and ends with Enter. Catch fast keystrokes on the Exit screen.

## Plate model: owner's decision (24 Nov 2026)
- Train first on public, openly licensed Indian plate datasets: Roboflow Universe Indian plate sets (check each set's licence; many are CC BY 4.0), Mendeley NPDS (about 19k images, COCO), and the IEEE DataPort Indian ANPR sets. Don't scrape random web images.
- Pipeline: small plate detector (YOLO nano, exported to ONNX/TFLite) → crop and deskew → plate OCR (fine-tuned on Indian and Goa fonts plus the existing synthetic crops) → vote across 2–3 frames → auto-fill.
- Learning: the owner said yes to saving scans. Store the plate crop, the raw reading and the operator-confirmed plate. Auto-delete after a set number of days. Retrain periodically and ship new model versions to devices.
- Target "instant": auto-fill within about 1 second of the plate entering the frame, on a mid-range Android POS.
- An Android wrapper (Capacitor) with ML Kit text recognition is the recommended fast path.

## Rules
- Money is integer paise; times are UTC ms shown in Asia/Kolkata.
- Work on a branch. Pushing to `codex/pay-parking-live` publishes to the live site, so ask the owner first.
- Never commit `.env` or Razorpay or Supabase server keys.
