# Pay Parking

React + Vite + TypeScript app for the entry gate, exit gate and owner dashboard.

## Local preview

Run `npm ci` and `npm run dev`. Open the Vite URL, create an entry slip, then go to Exit and open the slip by ticket number or vehicle plate. Record cash and close the ticket. Check Owner → Tickets for the result. Company and site names are editable in Owner → Settings.

This preview stores its tickets in the current browser. Use sample vehicles and test amounts.

## Cloudflare Pages

In Cloudflare, create a **Pages** project from the GitHub repository `Shubhanand123/PAY-PARKING`. Set the build command to `npm run build` and the output directory to `dist`. Set the build environment variable `NODE_VERSION` to `24.22.3`. Select the branch you intend to publish. For a Git-connected Pages project the build produces the assets directly. No Workers deploy command is required.

Pages serves the SPA using its default fallback when the build has no top-level `404.html`. Ticket links use the `/#/t/<token>` route. For a direct-upload Pages project, `npm run deploy` builds and uploads the site using an authenticated Wrangler session and the Pages project name in `wrangler.jsonc`.

## Supabase

The migration in `supabase/migrations` defines storage for sites, tariff versions, tickets, cash receipts and audit events. Apply it only to the intended parking project. It prevents duplicate active plates within a site and duplicate cash receipts of the same kind for a ticket. Direct browser access to these tables is denied.

The preview still uses browser storage. Before switching the gates to Supabase, implement the server API for device access, ticket lookup, tariff calculation and transactional cash checkout. Staff accounts and PINs are deferred. Razorpay is deferred until after the preview is published. Do not put Supabase server keys in Vite or GitHub.
