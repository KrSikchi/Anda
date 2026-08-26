# Anda

A shared egg inventory & settlement ledger for small shared living groups.
Narrow by design — if a flatmate needs instructions, it is still too complicated.

## Repository layout

```
docs/                         → engineering documentation (PRD §33)
supabase/
  migrations/                 → version-controlled PostgreSQL migrations (§25)
  tests/                      → local-only validation (auth.uid() stub + schema suite)
```

## Status (PRD §28 sequence)

- Phase 2 — Data model: **done** (migration `0001_initial_schema.sql`, validated locally).
- Phase 3 — Room lifecycle: **done** (migration `0002_room_lifecycle.sql`; create/join/leave, host code-regeneration + soft-delete, device-bound identity, server-side authorization; 42 RPC-level tests + 43-schema regression green).
- Phase 4 — Ledger (purchases, usage, derived inventory, liability, corrections): next.
- Phase 5 — Atomicity (server-side validation, negative-inventory prevention).
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
psql -X -d anda_test -f supabase/tests/schema_validation.sql   # Phase 2 gate (43 checks)
psql -X -d anda_test -f supabase/tests/room_lifecycle.sql      # Phase 3 gate (42 checks)
```

The stub is LOCAL ONLY and mirrors Supabase's `auth.uid()` so RLS policies can be exercised.