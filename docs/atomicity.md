# Anda — Atomicity & Concurrency (PRD §11, §27 "Concurrency tests")

## Strategy (decision D13, hardened by D19)

Every stock-mutating operation — `record_usage`, `correct_usage` (shipped in 0003), and `record_purchase` (hardened in 0004, D19) — executes inside a **single SECURITY DEFINER function, which is itself one PostgreSQL transaction**, and begins by taking `SELECT … FOR UPDATE` on the room row (`rooms.id`).

Consequences:

- All stock mutations for one room are **totally serialized**: a concurrent second consumer blocks on the row lock until the first commits, then its availability sums run against the **latest committed ledger state** (statements re-snapshot under READ COMMITTED after the lock wait).
- The availability check and the ledger insert happen inside the same transaction — never "read stock, check stock, write usage" as independent operations (§11).
- Purchases serialize too (D19), so a usage is never falsely rejected by an in-flight purchase: the purchase either commits before the usage's check (more stock visible → conservative-correct) or after (unneeded).
- Append-only immutability (migration 0001 triggers) means the pool can only be observed at its committed state; there is no deletion path that could invalidate a check.

The canonical bad-race is thus impossible: inventory 2, two simultaneous `use 2` ⇒ exactly one commits; the other receives `Anda: not enough eggs remaining (0)`.

## Verification — `supabase/tests/atomicity_{setup,assert}.sql` + `supabase/tests/pgbench/*.tmpl.sql`

Real concurrency (not simulated interleavings) via **pgbench** (multi-connection, multi-thread), then assertions against the authoritative DB state:

| Race | Scenario | Verified result |
|---|---|---|
| A | stock 2; 2 clients `use 2` (§11 example) | exactly **1** recorded; loser rejected server-side |
| B | stock 0; 50 concurrent `use 1` | **0** recorded; inventory stays 0 |
| C | 50 concurrent purchases (5 eggs ₹25) | all **50** recorded; Σ = 250 |
| D | stock 24; 300 concurrent `use 1` | exactly **24** succeed; inventory 0, never negative |
| E | mixed concurrent purchases + usage | Σp − Σu = inventory ≥ 0; consumed ≤ purchased |
| F | 2 concurrent corrections of one usage | exactly **1** correction applied; effective consumption = 5 − 4 |

Plus ledger-identity checks (`inventory = Σ purchases − Σ usage`) for every race room.

## Notes on running and interpreting pgbench here

- The losing client prints `ERROR: Anda: not enough eggs remaining (0)` and pgbench reports it as **`client aborted` + `number of transactions actually processed: N−1/N`** (it does *not* increment "number of failed transactions"). That is a pgbench accounting quirk, not a missing rejection — the DB state (`atomicity_assert.sql`) is the ground truth and consistently shows exactly the invariant outcome.
- Scripts set `request.jwt.claim.sub` per session (the local auth-atom bridge) so the SECURITY DEFINER RPCs authorize the simulated device exactly as a Supabase JWT would.

## Never touched

- The check-and-write lives in application space (RPC), not as an extra trigger — `record_usage` is the *only* way to add usage, so no trigger is needed for the invariant.
- No row-level locking on `egg_usage`/`purchases`; serialization is intentionally coarser (one room row) — cheap at the 2–8 person scale and trivial to reason about (§32: minimal complexity).