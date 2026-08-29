# Anda — Account, balances and settlement

Scope: the financial half of the Account screen, and the boundary that keeps it
replaceable. PRD §27–§30, §45, §46.

---

## 1. Units

Every monetary value is an **integer number of paise** (`Minor`). ₹12.00 is
`1200`.

| Boundary | Representation |
|---|---|
| User input (Buy sheet) | text, parsed to paise by `parseMoneyToMinor` |
| Client → server | `bigint` paise (`p_unit_price_minor`, `p_amount_minor`) |
| Postgres storage | `purchases.unit_price_minor bigint`, `settlements.amount_minor bigint` |
| Derived read | `room_ledger.liability_minor`, `settled_minor`, `outstanding_minor` |
| Screen | `formatMinor()` → `₹12.00` |

`total_cost` is retained as exact `numeric(10,2)` for reporting and history;
it is computed from the integer unit price, never the other way round.
JavaScript floats never enter the authoritative path — `parseMoneyToMinor` is
string-based for exactly that reason (PRD §22).

## 2. Liability — unchanged from the ledger phase

`room_ledger` computes each member's liability with the FIFO interval-overlap
allocation from migration 0003 (D15/D16):

- consumption events are consumed in chronological order,
- each draws from the earliest purchase batches first,
- liability is attributed to the member who recorded the original usage,
- a correction reduces that original's effective amount.

Migration 0008 changed only the arithmetic unit of that computation (integer
paise instead of a derived numeric). The semantics are identical, so historical
balances do not move when the migration is applied.

## 3. What Account displays

| Element | Definition |
|---|---|
| **Overall Balance** | Σ `outstanding_minor` over active members — the room's total egg debt |
| **per-member row** | that member's `outstanding_minor` = liability − settled (floored at zero) |
| **Settled** | they owed something and have now cleared it |
| **Even** | they have never owed anything |

The overall figure therefore equals the sum of the rows beneath it, matching
the supplied design.

## 4. Settlement

**What it records.** That one member has covered an amount of what they owe.
It is a record of something that happened between flatmates. No payment is
processed, no money moves through Anda, and there is no netting engine
(PRD §30).

**Server rules** (`record_settlement`, migration 0009):

1. caller must be an active member of the room,
2. the counterparty must be an active member of the *same* room,
3. the counterparty cannot be the caller,
4. the amount must be greater than zero,
5. the amount cannot exceed what the caller still owes.

**Counterparty rule (provisional).** The PRD deliberately leaves "who do I
settle with?" open (§29: do not invent financial semantics). The chosen rule
lives in one function, `settlementCounterparty()` in `web/src/lib/anda/finance.ts`:

> settle with the flatmate who has fronted the most money for eggs
> (`purchased_minor`); if nobody has bought anything yet, fall back to the room
> host.

It is presentation-level only — the schema stores `from_member_id` and
`to_member_id` explicitly, so a future engine can reinterpret existing rows
without a migration.

**Why it is honest rather than a demo.** The swipe-to-reveal interaction the
design specifies writes a real row, appears in Activity, and moves the balance.
It is not a timer that pretends to settle.

## 5. Deferred on purpose (PRD §46)

- the final settlement mathematics / multi-member optimisation,
- positive vs negative balance wording,
- correction UI (the ledger already supports corrections; only the screen is
  missing),
- partial settlement — the UI settles the full outstanding amount.

Each is reachable without touching the Account screen: replace the shaping
functions in `finance.ts`, or add an RPC and point `AndaApi` at it.

## 6. Where the rules live

| Concern | Location |
|---|---|
| FIFO liability | Postgres (`room_ledger`, migration 0003/0008/0009) |
| Settlement validity | Postgres (`record_settlement`, migration 0009) |
| Money parsing/formatting | `web/src/lib/anda/finance.ts` (pure) |
| Balance shaping + counterparty | `web/src/lib/anda/finance.ts` (pure) |
| Rendering | `web/src/screens/Account.tsx` (no arithmetic) |

No component computes money. That is the boundary PRD §45 asks for.
