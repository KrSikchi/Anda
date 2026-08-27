# Anda — Realtime Synchronization (PRD §12, §26)

> Status: Phase 6–9 implemented and gated locally. Supabase Realtime wiring
> is in `web/src/lib/anda/transport.ts`; offline persistence (IndexedDB queue)
> in `web/src/lib/anda/db.ts` + `store.ts`. The React UI (Phase 9) is in
> `web/src/screens/` and renders with a mock store for development. Full
> end-to-end integration is verified at Phase 10 against the hosted service.
> End-to-end delivery timing (< 1–2 s) is verified against the managed
> service in Phase 10 production testing.

## Data flow (authoritative-first, never client-invented)

```
Database event (INSERT/UPDATE on rooms|members|purchases|egg_usage)
        ↓
Supabase Realtime  (publication + RLS)
        ↓
Client channel (room_id=eq.<roomId> filter)
        ↓
Client store recomputes derived state (§7):
        inventory = Σ purchases − Σ usage
        per-member consumption, FIFO liability  (via room_ledger RPC)
        synchronisation indicator  (Synced / Syncing / Offline)
```

The client **never invents state**: the store derives everything from
authoritative rows returned by `room_ledger` (and `room_history`), refetched on
every relevant event. Optimistic estimates are only a temporary display layer
and are reconciled on confirmation (§13).

## Layered room-scoping (§12)

1. **Publication** — migration `0005_realtime.sql` publishes only the four
   activity tables (`rooms`, `members`, `purchases`, `egg_usage`); `settlements`
   remains structurally inert and unpublished.
2. **RLS** — Realtime delivers only rows the subscriber may `SELECT`; migration
   0001's policies (`is_active_room_member`) scope every table to active members
   of active rooms. A subscriber therefore cannot receive another room's rows
   even before the client filter runs.
3. **Client channel** — the store subscribes with a `room_id=eq.<roomId>`
   Postgres-changes filter, so only that room's deltas are even considered by
   the application.

## Client store (`web/src/lib/anda/`)

- `transport.ts` — Supabase Realtime adapter; exposes `subscribe(roomId, …)`
  with `postgres_changes` filters per table, plus a connection-status callback.
  A `MockTransport` in tests mirrors the same contract.
- `api.ts` — thin typed client over the SECURITY DEFINER RPCs
  (`room_ledger`, `room_history`, `record_purchase`, `record_usage`) and the
  room-lifecycle RPCs.
- `store.ts` — `AndaStore`:
  - `init(roomId, currentMemberId)` — initial snapshot → `Synced`.
  - On any event for its room (or after an optimistic action's confirmation):
    **refetch `room_ledger`** and recompute derived state (inventory, members,
    liability), then → `Synced`.
  - Events for other rooms are ignored by the channel filter and again by an
    explicit `roomId` guard in the store.
  - Sync status model: `syncing` (initial load / refetch in flight / reconnect)
    → `synced`; `offline` on transport disconnect (with reconnect → `syncing`).
  - Optimistic usage/purchase adjust the visible numbers immediately; the
    authoritative refetch overwrites them; a rejected mutation (e.g.
    `Anda: not enough eggs remaining`) **reverts** the estimate and surfaces the
    friendly message (§13, §24).

## PRD §27 Realtime tests — `web/src/lib/anda/__tests__/store.test.ts`

All 8 tests green (Vitest):
- Two clients in one room: an event produced "by the other client" updates this
  store's derived state.
- Different rooms: an event for room B never reaches store A (guard + filter),
  verified at both the store layer and the transport contract.
- Recompute, never invent: after every event the store's state deep-equals the
  authoritative fixture; inventory always equals Σp − Σu.
- Sync status transitions: syncing→synced, offline→syncing→synced, and the
  rejection-flash on failed optimistic mutations.

## Operational notes

- Supabase Realtime delivers the new row on INSERT (room-scoped); the store
  additionally refetches the ledger so derived liability/chart data are never
  half-updated.
- `members.auth_user_id` is visible column-wise to room members via RLS; it is
  an anonymous UUID and is never surfaced by the UI.
- Target propagation: < 1–2 s normal conditions (§12) — governed by Supabase
  Realtime; verified end-to-end in Phase 10 production testing.
- Naming: the PRD's `sync.status` display strings are
  `Synced` / `Syncing` / `Offline` (§14, 24).