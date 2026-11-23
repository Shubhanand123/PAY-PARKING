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

### Connected cash pilot

The production build uses the parking Edge Function specified in `.env.production`.
It starts with an empty ticket history. Verify company details, vehicle rates and
capacity in Owner before admitting vehicles. Run `supabase/setup-device.sql` in the
parking project's SQL Editor once per device. Choose `owner`, `entry` or `exit`
and give each device a distinct label. Enter the returned code on that device
only. To revoke a code, set the corresponding device's `enabled` field to false.

The live API uses `parking_device_runtime`. The earlier normalized schema
migration is a prototype and is not needed by this implementation. To deploy
the Edge Function manually, bundle its entrypoint and the shared parking engine.
The gateway JWT check is disabled because the function validates device keys
itself and exposes a read-only customer ticket view by opaque QR token.

Scan Plate opens the camera or file chooser. Frame the registration closely
and verify the detected text before saving. At exit, Scan ticket or plate reads a ticket QR or a number plate
from the same live camera. Browser printing uses the
OS print dialog. POS printer and camera behavior must be checked on the chosen
hardware. Cash checkout requires an online connection. Razorpay is deferred.

### Owner and gate sign-in

Owner and POS accounts open separate workspaces. To switch to mobile sign-in
for the first Owner, choose Owner dashboard → Use existing owner setup. Open
Devices → Owner access and generate a code for the intended Owner mobile
number. In a signed-out browser, choose Owner dashboard → Forgot password,
enter that mobile and code, and create a password. Codes are valid for 30
minutes and can be used once. Generating another code for a mobile number
replaces the previous unused code. Password recovery invalidates older Owner
sessions. Creating an additional Owner leaves existing Owner accounts active.

In Owner → Devices, choose the POS operator's mobile number and Entry, Exit,
or Entry + Exit access. Generate a one-time setup code and give it privately
to the operator. On the gate device the operator opens Gate POS → Forgot
password, enters the same mobile number and code, and creates their own PIN.
The code expires after 30 minutes. The device remembers the mobile number and
its setup credential after setup. Repeat with a fresh code when replacing the
gate device or resetting a PIN. Resetting invalidates prior sessions.
Deactivation disables access from the Owner dashboard.

The UI uses mobile numbers as the sign-in identifier. Supabase Auth receives
an internal email alias because SMS authentication is disabled on the project.
The publishable key in the production configuration is safe for client use.

### Live plate scanning

The entry and exit plate buttons scan live video frames inside the camera guide.
Two strong, agreeing frames can fill the editable plate field immediately.
Weaker or conflicting readings require more frames or manual review. Similar active records at
exit are presented for operator confirmation. Camera frames stay in the browser
and are not retained by the scanner.

The browser loads the fine-tuned model from `public/ocr`. The starter model
and model modifications are documented in its NOTICE. The first training set
used 500 synthetic crops emphasizing Goa, Bharat series, and V/Y letter pairs.
A separate set of 120 synthetic crops used a fourth font absent from training.
The packaged model read 119/120 full plates and 47/47 containing V or Y. The
previous browser model read 111/120 and 43/47 respectively on the same crops.
These tests do not measure accuracy on road footage. Retraining should use
permissioned, transcribed crops from the actual gate, with separate test vehicles
and capture sessions. Include motorcycles with two-line plates, commercial and
EV plates, glare, blur, distance and nighttime captures. A compatible model
can be served by setting `VITE_PLATE_OCR_MODEL_PATH` to the directory containing
`indplate.traineddata.gz`.
