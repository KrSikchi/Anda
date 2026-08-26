# Anda — Transactional Ledger (PRD §7, §8, §9, §10, §11)

## Principles

- **Transactions are the source of truth.** `purchases` and `egg_usage` are append-only event rows. Inventory is never stored as a primary value (migration 0001 triggers forbid `UPDATE`/`DELETE` on ledger rows).
- **Inventory = Σ purchases.quantity − Σ egg_usage.quantity** (corrections are negative quantities). Reconstructed at read time by `room_ledger`.
- **The database is the sole authority.** All mutations are SECURITY DEFINER RPCs (`record_purchase`, `record_usage`, `correct_usage`); the browser never writes tables directly (0001 D6, RLS SELECT-only).

## RPCs (Phase 4, migration `0003_ledger.sql`)

| RPC | Effect | Integrity guarantees |
|---|---|---|
| `record_purchase(room_id, quantity, total_cost)` | append purchase event; `cost_per_egg = total_cost/quantity` (generated) | positive quantity, non-negative cost; historical batch price preserved |
| `record_usage(room_id, quantity)` | append consumption event for the caller | check-and-write serialized on the room row; rejects if it would drive inventory negative |
| `correct_usage(room_id, usage_id, corrected_quantity)` | append compensating negative row `(corrected − original)` linked to the original | one correction per usage (partial unique index); corrections strictly negative; upward/same corrections rejected |
| `room_ledger(room_id)` | main view: room fields, inventory, per-member effective consumption + FIFO liability | deterministic; computed, never stored |
| `room_history(room_id)` | history screen: merged ledger newest-first with correction links | read-only |

## Corrections (§10) — decisions D14/D15

- A mistaken **over-recording** is fixed with a compensating negative transaction linked to the original. The original row is never edited (examples: 12→2 writes −10; 5→3 writes −2).
- Only **one** correction may target an original usage.
- **Attribution**: a correction reduces the effective consumption of the member who *recorded the original* usage — liability stays correct no matter who performs the correction.
- Under-recorded usage is fixed through the ordinary usage path (the PRD defines corrections strictly as negative compensations).

## Liability costing (§8) — decision D16

- **Deterministic FIFO**: consumption events in chronological order (by `recorded_at` of each original usage, tie-broken by `id`) draw eggs from the earliest purchase batches first; each consumed egg is priced at its batch's `cost_per_egg`, via a single interval-overlap SQL pass. Historical prices are never overwritten or silently replaced by the latest price. (Test fixtures use one transaction per event so their `recorded_at` values are strictly increasing and the expected numbers are stable; production ties — same-microsecond events — break deterministically by `id`.)
- Example (from the Phase 4 suite): batches 30 @ ₹8 and 12 @ ₹5; events H4, J12→2 (corrected), S6, S25, Y5→3 (corrected), Z2 give H ₹32, J ₹16, S ₹227 (24×8 + 7×5), Y ₹15, Z ₹10 — total ₹300 = 30×8 + 12×5, fully determined by the ledger.

## Atomicity (§11) — decision D13

- `record_usage` (and `correct_usage`) take `SELECT … FOR UPDATE` on the room row inside the same transaction as the validation and the insert. All stock-mutating events for a room therefore serialize, and the availability check always runs against the latest committed ledger state — an atomic check-and-write.
- Phase 5 verifies this under true concurrency (two clients consuming the last 2 eggs; only one succeeds) and hones the locking strategy if required.

## History of prices

`purchases.cost_per_egg` is a generated column (0001, D4): `total_cost / NULLIF(quantity,0)`. Each purchase retains its own cost basis forever; corrections and liability are computed against those immutable batches.