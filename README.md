# Anda

A shared egg inventory & settlement ledger for small shared living groups.
Narrow by design — if a flatmate needs instructions, it is still too complicated.

## Repository layout

```
docs/                          → engineering documentation (PRD §33)
supabase/
  migrations/                  → version-controlled PostgreSQL migrations (§25)
  tests/                       → local-only validation suites (archival stubs + pgbench races)
  functions/
    _shared/                   → pure VAPID / payload / delivery helpers (unit-tested)
    low-stock-notify/          → Deno Edge Function (§16/§17 delivery)
web/                           → frontend: Vite + React + TypeScript + PWA (§19, §1)
  src/lib/anda/                → realtime/offline store, transport, typed RPC API + tests
```

## Status (PRD §28 sequence)

- Phase 2 — Data model: **done** (migration `0001_initial_schema.sql`, validated locally).
- Phase 3 — Room lifecycle: **done** (migration `0002_room_lifecycle.sql`; create/join/leave, host code-regeneration + soft-delete, device-bound identity, server-side authorization; 42 RPC-level tests).
- Phase 4 — Ledger: **done** (migration `0003_ledger.sql`; purchases, usage, derived inventory, FIFO-costed liability, compensating corrections, history; 52 RPC-level tests).
- Phase 5 — Atomicity: **done** (migration `0004_atomicity.sql`; room-row serialization extended to purchases (D19); real-concurrency verification via pgbench races A–F; 20 assertions; see `docs/atomicity.md`).
- Phase 6 — Realtime: **done** (migration `0005_realtime.sql` publishes ledger tables; client store with room-scoped subscriptions, derived-state recompute, sync indicators, optimistic reconciliation; 8 store tests in `web/`; see `docs/realtime.md`).
- Phase 7 — Offline persistence: **done** (IndexedDB via `idb`: durable cache, member identity, pending mutation queue; reconnect flush with server validation; rejected items surfaced never discarded; 5 offline tests incl. reload-persistence and last-egg conflict; see `docs/offline.md`).
- Phase 8 — Notifications: **done** (migration `0006_notifications.sql`: `push_subscriptions` (room→member→device, owner-RLS), `low_stock_alerts` internal episode queue, same-transaction threshold-crossing state machine; Supabase Edge Function `low-stock-notify` + pure VAPID/payload helpers; 24 SQL + 8 unit tests; see `docs/notifications.md`).
- Phase 9 — UX refinement: **done** (React UI on the solid store: Welcome/Create/Join screens, Dashboard with stock + member liability + low-stock warning + sync indicator, Usage and Purchase entry modals with stepper controls, History with correction links, Room info with leave flow; mobile-first PWA; see `web/src/screens/`).
- Phase 10 — Full verification & deployment: next (end-to-end production-like deployment, cross-device testing, security boundary verification).
- Phase 6 — Realtime (Supabase Realtime, room-scoped).
- Phase 7 — Offline persistence (IndexedDB, pending queue, reconciliation).
- Phase 8 — Notifications (Web Push, low-stock threshold crossing).
- Phase 9 — UX refinement. Phase 10 — Full verification & deployment.

## Local validation

Requires PostgreSQL ≥ 13 (Supabase runs ≥ 15).

```bash
createdb anda_test
psql -X -d anda_test -f supabase/tests/local_auth_stub.sql
psql -X -d anda_test -f supabase/migrations/0001_initial_schema.sql
psql -X -d anda_test -f supabase/migrations/0002_room_lifecycle.sql
psql -X -d anda_test -f supabase/migrations/0003_ledger.sql
psql -X -d anda_test -f supabase/migrations/0004_atomicity.sql
psql -X -d anda_test -f supabase/migrations/0005_realtime.sql
psql -X -d anda_test -f supabase/migrations/0006_notifications.sql
psql -X -d anda_test -f supabase/tests/schema_validation.sql   # Phase 2 gate (43 checks)
psql -X -d anda_test -f supabase/tests/room_lifecycle.sql      # Phase 3 gate (42 checks)
psql -X -d anda_test -f supabase/tests/ledger.sql              # Phase 4 gate (52 checks)

# Phase 5 gate — atomicity (requires pgbench, ships with PostgreSQL)
psql -X -v ON_ERROR_STOP=1 -d anda_test -f supabase/tests/atomicity_setup.sql
# … generate scripts from supabase/tests/pgbench/*.tmpl.sql, run the pgbench
# races (see docs/atomicity.md), then:
psql -X -d anda_test -f supabase/tests/atomicity_assert.sql    # Phase 5 assertions (20 checks)
psql -X -d anda_test -f supabase/tests/notifications.sql       # Phase 8 gate (24 checks)

# Local: install & run the web app (Phase 9 UI)
cd web && npm install && npm run dev    # vite dev server (PWA-ready)

# Test: all suites
cd web && npm test                       # 21 tests: realtime (8), offline (5),
                                         # low-stock push helpers (8)
```

The stub is LOCAL ONLY and mirrors Supabase's `auth.uid()` so RLS policies can be exercised.