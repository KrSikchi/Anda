# Anda — Offline Persistence (PRD §14, §15)

## Local persistence — IndexedDB (via `idb`, per PRD: "Dexie or idb may be used")

One database (`anda`) with three object stores (`web/src/lib/anda/db.ts`):

| Store | Contents | Purpose |
|---|---|---|
| `meta` | device-bound member identity: `{ memberId, roomId }` (§4) | identity persists on the device; restored on reload |
| `cache` | last authoritative `room_ledger` rows + recent `room_history` | offline boot shows the last known truth — clearly marked not live |
| `pending` | durable FIFO queue of offline mutations | intent is never lost; flushed and server-validated on reconnect |

## Data flow (PRD §14)

```
OFFLINE                    ONLINE (reconnect)
user action                pending queue
   ↓                            ↓
queue to IndexedDB              server validation (§11, §15)
   ↓                            ↓
estimate shown, status=Offline  success → drop + refetch authoritative
                                rejection → surface, never discard (§24)
                                transient  → keep queued, retry later
```

## Decisions (PRD §32)

- **D20** `idb` as the IndexedDB wrapper (PRD explicitly allows idb or Dexie).
- **D21** Queue is FIFO and each item is validated independently by the server
  on flush. The canonical offline conflict — two devices consuming the last
  egg — resolves here: the server accepts valid transactions and rejects the
  rest per the atomic check (§11), with no CRDT and no local authority (§15).
- **D22** Unconfirmed local state is never presented as final: `store.state` is
  always server truth; `store.view` adds pending *estimates*; a rejected flush
  fully reconciles `view` to `state` and records the item in `store.rejected`
  (surfaced in UI, §24) — nothing is silently discarded.
- **D23** Member identity is persisted in `meta`; the Supabase anonymous
  session persists in its own storage (managed by `@supabase/supabase-js`).
  A reload resumes identity and rehydrates the queue (§4).
- **D24** Offline boot hydrates from `cache` and rehydrates pending ops, marks
  `Offline`; first `online`/reconnect flushes through the server.
- **D25** Connectivity signal = Realtime connection callbacks + `window`
  `online`/`offline` events (`navigator.onLine`), combined in `isOffline()`.

## Validation failures vs. connectivity failures

- A server **validation rejection** (`Anda: …` with one of the
  `VALIDATION_MARKERS` in `store.ts`, e.g. `not enough eggs remaining`) is
  authoritative: the queued item is dropped, the user is told why (§24), and
  the estimate is reconciled to server truth.
- A **transient network error** (e.g. fetch failed) keeps the item queued and
  marks `Offline` — the intent is never lost.

## PRD §27 Offline tests — `web/src/lib/anda/__tests__/offline.test.ts`

Real IndexedDB (fake-indexeddb) is used — the durability code under test is
the production `IdbRepo`, not a stub:

1. Record offline → persisted to the durable queue; status `Offline`; estimate
   shown, authoritative state unchanged.
2. Reconnect → flush (validate) → reconcile; queue empties, state syncs.
3. Reconnect with an invalid queued action → server rejects; client reconciles
   and surfaces it (never silently discarded).
4. Queue + identity survive re-creation (app reload); offline boot from cache +
   queue; flushed on next connect.
5. Two offline consumers of the last egg → server resolves FIFO + atomic check;
   exactly one wins, the other is surfaced (no CRDT).