# Pay Parking

Gate POS (Entry / Exit) and Owner dashboard for a pay-and-park site. React + Vite + TypeScript, deployed on Cloudflare Workers (static assets).

- `npm install` then `npm run dev` for local development
- `npm run build` builds to `dist/` (what Cloudflare serves)
- Cloudflare build settings: build command `npm run build`, deploy command `npx wrangler deploy`

Any unknown path serves `index.html` (single-page app), so ticket/QR links open directly.

Status: demo data is stored in the browser (localStorage). Supabase (database + staff PIN login) is the next milestone.
Never commit `.env` files or keys; see `.env.example`.
