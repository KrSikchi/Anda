# Anda — Database Schema

Scope: MVP exactly as defined in the binding PRD (Section 28, Phase 2 — Data Model).
Canonical artifact: `supabase/migrations/0001_initial_schema.sql` (version-controlled; this document is a concise summary).

## Entities (PRD §6, §7–§10)

| Entity | Purpose | Key columns | PRD |
|---|---|---|---|
| `rooms` | Room identity, share code, host, lifecycle, low-stock state | `id`, `name`, `share_code` (6-char `[A-Z0-9]`, unique), `host_member_id`, `low_stock_threshold` (default 10), `low_stock_notified` (default false), `is_active` | §6, §23, §16 |
| `members` | Device-bound pseudonymous identity | `id` (member_id), `room_id`, `auth_user_id` (anonymous-auth binding), `display_name`, `is_active` | §4, §6 |
| `purchases` | Purchases ledger (immutable) | `room_id`, `member_id`, `quantity` (>0), `total_cost` (≥0), `cost_per_egg` (generated = total_cost/quantity), `recorded_at` | §8 |
| `egg_usage` | Usage + corrective ledger (immutable) | `room_id`, `member_id`, `quantity` (usage >0 / correction <0), `correction_of`, `recorded_at` | §9, §10 |
| `settlements` | Structural-only, inert in MVP | `room_id`, `from_member_id`, `to_member_id`, `amount`, `status`, `recorded_at` | §6 (D7) |

## Core invariants (DB-enforced, never app-level only — PRD §25)

1. **Inventory is derived, never stored** (§7): `inventory = Σ purchases.quantity − Σ egg_usage.quantity`.
2. **Ledger rows are append-only** (§7, §10, §29): `UPDATE`/`DELETE` on `purchases`/`egg_usage` raises via trigger. Mistakes are fixed with a compensating negative `egg_usage` linked via `correction_of`.
3. **Correction semantics** (§10): plain usage must be `quantity > 0`; a correction must be `quantity < 0` and reference an existing usage **in the same room** (composite FK `(room_id, correction_of) → egg_usage(room_id, id)`).
4. **Historical pricing preserved** (§8): `cost_per_egg` is a generated column (`total_cost / NULLIF(quantity,0)` — the `NULLIF` guard keeps `CHECK(quantity>0)` the clean rejection surface instead of a division error); each purchase keeps its own price. Liability costing strategy (deterministic, FIFO-style) is a Phase 4 ledger-query concern.
5. **Soft deletion only** (§3, §6): all FKs are `ON DELETE RESTRICT`, so hard deletes are impossible once history exists. Living members keep history; `is_active=false` removes write access (enforced later in SECURITY DEFINER RPCs) and RLS read access.
6. **Host identity** (§6): `rooms.host_member_id` NOT NULL; FK is `DEFERRABLE INITIALLY DEFERRED` because a room and its host are created in one transaction. Same-room guarantee via composite FK to `members(room_id, id)`.
7. **Device-bound membership** (§4): a device (one `auth_user_id`) may hold only one *active* membership per room (partial unique index); leaving + re-joining produces a fresh active member.

## Authorization (PRD §5, §21)

- **RLS is the read boundary**: `SELECT` policies grant access only via `public.is_active_room_member(room_id)` (SECURITY DEFINER helper; reads `auth.uid()` — the Supabase anonymous-auth principal bound in `members.auth_user_id`). This is D1 (see migration header).
- **No direct write path exists for the API roles**: no `INSERT`/`UPDATE`/`DELETE` policies and no grants. Every mutation must go through SECURITY DEFINER Postgres functions (Phases 3–5) that re-validate membership, activeness, and ledger integrity server-side. The browser is never trusted.
- Soft-deleted rooms (`is_active=false`) are fully invisible — including their members and ledger rows — because `is_active_room_member` requires the room to be active as well as the member (validated by tests R6a–R6d). Inactive members read nothing.

## Migration discipline (PRD §25, §28)

- Schema is version-controlled under `supabase/migrations/`, each file one transaction.
- `0002_room_lifecycle.sql` adds the five Phase-3 SECURITY DEFINER RPCs that are the only write path: `create_room`, `join_room`, `leave_room`, `regenerate_room_code`, `soft_delete_room` (see `docs/member-identity.md` for the catalog and authorization detail). It also enables `pgcrypto` (for `gen_random_bytes`-based share-code generation, §21) — available in Supabase's default extension set.
- `0003_ledger.sql` adds the Phase-4 ledger: `record_purchase`, `record_usage` (atomic check-and-write), `correct_usage`, `room_ledger`, `room_history`, plus the one-correction-per-usage index (see `docs/ledger.md`).
- `0004_atomicity.sql` is the Phase-5 hardening: `record_purchase` now takes the room-row `FOR UPDATE` lock too (D19), so every stock mutation for a room is total-ordered; concurrency verified with pgbench races (see `docs/atomicity.md`). No schema change.
- Deferred to later phases by design: low-stock crossing trigger (Phase 8). This keeps the PRD's incremental sequence intact — nothing is skipped, nothing is pulled forward.

## Local validation (Phase 2 gate)

See `supabase/tests/` — a local-only `auth.uid()` stub plus suites covering the schema-level and room-lifecycle rows of the PRD §27 matrix (constraints, derivation, immutability, RLS cross-room isolation, inactive-member lockout, room soft-delete invisibility, device identity, host powers, code regeneration).