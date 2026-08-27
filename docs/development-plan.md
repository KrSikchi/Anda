# Anda — Development & Deployment Plan

## Current state

- Frontend: Vite + React + TypeScript PWA in `web/`.
- Backend: Supabase PostgreSQL migrations, RLS, RPCs, Realtime publication, and Edge Function in `supabase/`.
- App wiring: frontend uses Supabase anonymous auth, real room create/join/leave RPCs, IndexedDB persistence, realtime transport, and production build output.

## Verification

```bash
cd web
npm install
npm test
npm run build
```

Expected frontend checks:

- 21 Vitest tests passing.
- Production assets generated in `web/dist/`.

## Supabase Deployment

Prerequisites:

- Supabase project ref.
- Supabase access token available through `supabase login` or `SUPABASE_ACCESS_TOKEN`.
- Frontend env values in `web/.env.local`:

```bash
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<public-anon-key>
```

Deploy backend:

```bash
npx supabase link --project-ref <project-ref>
npx supabase db push
npx supabase functions deploy low-stock-notify
```

Configure function secrets:

```bash
npx supabase secrets set VAPID_PUBLIC_KEY=<public-key> VAPID_PRIVATE_KEY=<private-key>
```

After deploy:

- Enable anonymous sign-ins in Supabase Auth.
- Configure the Database Webhook for `low_stock_alerts` inserts to call `low-stock-notify`.
- Run a smoke test: create room, join room from another browser/device, add purchase, record usage, verify realtime update.

## Frontend Deployment

Supabase hosts the backend for this project. Deploy `web/dist/` to a static host such as Vercel, Cloudflare Pages, Netlify, or Supabase Storage behind a CDN.
