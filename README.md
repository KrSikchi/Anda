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
- Phase 3 — Room lifecycle (create/join/leave, member identity, host ops): next.
- Phase 4 — Ledger (purchases, usage, derived inventory, liability, corrections).
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
psql -X -d anda_test -f supabase/tests/schema_validation.sql
```

The stub is LOCAL ONLY and mirrors Supabase's `auth.uid()` so RLS policies can be exercised.