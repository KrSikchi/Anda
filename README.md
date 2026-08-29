# Anda

A shared egg inventory & settlement ledger for small shared living groups.
Narrow by design — if a flatmate needs instructions, it is still too complicated.

## Repository layout

```
docs/                          → engineering documentation
supabase/
  migrations/                  → version-controlled PostgreSQL migrations
  tests/                       → local-only validation suites (archival stubs + pgbench races)
  functions/
    _shared/                   → pure VAPID / payload / delivery helpers (unit-tested)
    low-stock-notify/          → Deno Edge Function (low-stock delivery)
web/                           → frontend: Vite + React + TypeScript + PWA
  src/lib/anda/                → realtime/offline store, transport, typed RPC API
  src/lib/anda/finance.ts      → money parsing, formatting, balance shaping
  src/screens/                 → Landing, Create/Join/Sign in, Home, Activity, Account
  src/components/              → sheets, stepper, bottom nav, swipe row, primitives
  src/session/                 → identity, room store and auth for the whole app
```

## Status

Backend and platform (Phases 2–8 of the original plan) are unchanged and still
validated by their own SQL suites:

| Phase | State |
|---|---|
| Data model — `0001_initial_schema.sql` | done (43 schema checks) |
| Room lifecycle — `0002_room_lifecycle.sql` | done (42 RPC checks) |
| Ledger — `0003_ledger.sql` | done (52 RPC checks) |
| Atomicity — `0004_atomicity.sql` | done (pgbench races A–F, 20 assertions — `docs/atomicity.md`) |
| Realtime — `0005_realtime.sql` | done (`docs/realtime.md`) |
| Offline persistence | done (`docs/offline.md`) |
| Notifications — `0006_notifications.sql` | done (`docs/notifications.md`) |

The UI/UX migration added three additive migrations on top:

| Migration | Adds |
|---|---|
| `0007_identity_recovery.sql` | `my_memberships()` — recover rooms after signing in on a device with no local state |
| `0008_purchase_unit_price.sql` | `purchases.unit_price_minor` (integer paise per egg, authoritative); `record_purchase` takes the unit price; liability returned in paise; `is_host` |
| `0009_settlements_live.sql` | `settlements.amount_minor`, `record_settlement`, `member_outstanding_minor`, settlements in `room_history` and Realtime |

None of these are destructive. `0008` backfills historical pricing from the
total each purchase was recorded with, and the only dropped column is the
`cost_per_egg` **generated** column, which is recomputed from the new source.
See the migration headers for the reasoning and `docs/ui-migration-audit.md`
for the pre-change inventory.

Remaining: full production verification — cross-device testing and a security
boundary pass (`docs/ui-migration.md` §6).

## Local validation

Requires PostgreSQL ≥ 13 (Supabase runs ≥ 15).

```bash
createdb anda_test
psql -X -d anda_test -f supabase/tests/local_auth_stub.sql
for f in supabase/migrations/*.sql; do psql -X -d anda_test -f "$f"; done
psql -X -d anda_test -f supabase/tests/schema_validation.sql   # 43 checks
psql -X -d anda_test -f supabase/tests/room_lifecycle.sql      # 42 checks
psql -X -d anda_test -f supabase/tests/ledger.sql              # 52 checks

# Atomicity gate (requires pgbench, ships with PostgreSQL)
psql -X -v ON_ERROR_STOP=1 -d anda_test -f supabase/tests/atomicity_setup.sql
# … generate scripts from supabase/tests/pgbench/*.tmpl.sql, run the pgbench
# races (see docs/atomicity.md), then:
psql -X -d anda_test -f supabase/tests/atomicity_assert.sql    # 20 checks
psql -X -d anda_test -f supabase/tests/notifications.sql       # 24 checks
psql -X -d anda_test -f supabase/tests/identity_settlement.sql # 0007/0008/0009 (31 checks)

# Web app
cd web && npm install
npm run dev      # vite dev server (PWA-ready)
npm test         # 46 tests: MVP journey (5), realtime (8), offline (5),
                 # money boundary (16), optimistic reconciliation (4),
                 # low-stock push helpers (8)
npm run build    # tsc --noEmit && vite build (service worker generated)
```

The stub is LOCAL ONLY and mirrors Supabase's `auth.uid()` so RLS policies can
be exercised.

## Running without Supabase

With `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` unset the app runs against
an in-memory backend that mirrors the server's rules (derived inventory, no
negative stock, FIFO liability, unit-price purchases, settlement cap). It
starts **empty** — no rooms, members or balances — so nothing on screen is
prototype data. The UI says when it is in this mode.

## Environment

Copy `web/.env.example` to `web/.env.local`:

| Variable | Required | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | yes (production) | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | yes (production) | public anon key — never a service-role key |
| `VITE_VAPID_PUBLIC_KEY` | no | Web Push low-stock alerts. The private half stays in Edge Function secrets. |
