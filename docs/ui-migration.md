# Anda — UI/UX migration notes

How the supplied design was integrated, what was deliberately left out, and
what is still open. Read alongside `docs/ui-migration-audit.md` (the pre-change
inventory) and `docs/account-finance.md` (the money rules).

---

## 1. What the reference contained

The supplied Stitch material described eight screens: landing/join, Home,
Activity, an activity detail sheet, Account, the two-step Restock (Buy) sheet,
and the Eat sheet. Content, hierarchy, copy and Material Symbols icon names
were available. **No CSS was available**, so colors, type scale, spacing, radii
and shadows were not specified by the reference.

Where the reference did not specify the visual system, the app's existing
palette was kept (warm off-white, egg amber) and the reference was followed for
composition, component hierarchy and interaction pattern. See §5.

## 2. Route map (PRD §9)

| Route | Screen |
|---|---|
| `/` | Landing — Anda / "Eggs, sorted." / Create / Join / Sign in |
| `/create-room` | Create room → room code → enter |
| `/join-room` | Join by 6-character code |
| `/sign-in` | Optional email/password |
| `/room/:roomId` | Home — room name, count, Eat, Buy |
| `/room/:roomId/activity` | Activity — the ledger by day |
| `/room/:roomId/account` | Account — identity, money, settlement, room |

`vercel.json` and `public/_redirects` were added so deep links survive a hard
refresh on either host.

## 3. Excluded from the reference, by instruction

These appeared in the supplied design and are **not** implemented:

- multi-room switcher, multiple active rooms, "Add New Room"
- Room Settings, Invite Roommate and "Personal Account" as separate concepts
- Inventory History as a separate destination (Activity *is* the ledger)
- any bottom-navigation tab beyond Home / Activity / Account

Room code, members and leaving the room live inside Account instead. There is
no host dashboard.

## 4. Screen-by-screen

**Home** — room name, egg count, Eat and Buy. No balances: PRD §18 is explicit
that money is not a Home concern, even though the app tracks it. Low-stock
warning appears at or below the threshold.

**Eat** — "How many eggs did you use?" → stepper → Confirm. Optimistic, then
server-validated; the stepper is capped at what is available, and a concurrent
shortfall still produces a real rejection that is explained in plain copy.

**Buy** — "How many eggs?" → Next → "What is the price per egg?" → the total is
derived and shown. The unit price is what gets stored (PRD §21).

**Activity** — actor, action, quantity or value, time; grouped Today /
Yesterday / Older. Purchases, usage, corrections and settlements all appear.

**Account** — identity and auth state, room code with copy, Overall Balance,
per-member balances with swipe-to-settle, low-stock alerts opt-in, and leave
room.

## 5. Known fidelity gap

Typography and color could not be matched to the reference because no CSS was
supplied. The structure, spacing rhythm, component hierarchy, sheet motion and
icon set follow the design; the palette is Anda's existing warm egg theme.
Supplying the Stitch `code.html` style blocks would let the tokens in
`web/src/styles/global.css` be corrected without touching any component.

## 6. Still open

| Item | Note |
|---|---|
| SQL suites not executed here | No PostgreSQL in the authoring sandbox. `supabase/tests/identity_settlement.sql` (35 checks for 0007/0008/0009) is written and ready, and `ledger.sql`, `atomicity_setup.sql` and `notifications.sql` were updated to the new paise unit-price contract. Run all of them locally before applying 0007–0009 (PRD §43). |
| Settlement mathematics | Final rules deferred (PRD §46); boundary is in place. |
| Correction UI | Ledger supports it; no screen yet. |
| Push delivery | Device registration is done; end-to-end delivery needs a live Supabase project with VAPID configured. |

## 7. Verification performed

- 46 automated tests, including one test that walks the complete MVP journey
  (create room → code → buy → eat → Activity → Account) and one that checks a
  room which no longer answers for this device is not repainted from cache.
- `tsc --noEmit` clean; production build clean with the service worker
  generated.
- Purchase unit price, rollback isolation and post-rejection reconciliation are
  covered by unit tests.
