# Anda — Phase 0 Audit: UI/UX Migration Readiness

Scope: the PRD "UI/UX Migration & MVP Implementation" directive, §7 (Phase 0 audit) and
§8 (Phase 0 completion criteria). This document is the artifact that must exist before any
architectural change. Every claim below was read out of the repository at
`4c652f2` (branch `master`), not assumed.

Source-of-truth hierarchy in force (PRD §2): PRD → working app behaviour → Stitch
visuals → engineering judgment.

---

## 1. Stack inventory

| Concern | What exists |
|---|---|
| Framework | Vite 5 + React 18 + TypeScript 5.6 (`strict`, `noUnusedLocals/Parameters`) |
| Package manager | npm (lockfile present, no workspace root package.json) |
| Build | `tsc --noEmit && vite build`; `vite preview` for local prod check |
| Routing | **None.** `App.tsx` holds a `useState<View>` union: `welcome \| dashboard \| usage \| purchase \| history \| roominfo` |
| Styling | Inline `React.CSSProperties` + a token object (`web/src/lib/anda/theme.ts`, 17 tokens). No CSS file, no Tailwind, no CSS-in-JS |
| Backend | Supabase (Postgres + Auth(anonymous) + Realtime + Edge Functions) |
| DB access | **RPC-only.** No table grants; every mutation is a `SECURITY DEFINER` function |
| Realtime | Supabase Realtime, 4 published tables, client-side `room_id=eq.<id>` filter |
| Offline | IndexedDB via `idb` — stores `meta`, `cache`, `pending` |
| Auth | Supabase **anonymous** sessions only (`ensureAnonymousSession()`); no email/password anywhere |
| PWA | `vite-plugin-pwa`, `registerType: 'autoUpdate'`, manifest + 192/512 icons, workbox app-shell globs |
| Notifications | `low-stock-notify` Edge Function + pure VAPID/payload/delivery helpers; `push_subscriptions` + `low_stock_alerts` tables |
| Tests | Vitest (node env, no jsdom): `store.test.ts`, `offline.test.ts`, `push.test.ts`; Postgres suites under `supabase/tests/` |
| Env | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |
| Deploy | Unknown/static-host compatible; **no `vercel.json`, no `_redirects`, no CI config present** |

---

## 2. Answers to the §8 completion criteria

1. **How the current user is identified.** `members.auth_user_id = auth.uid()`. The client
   calls `ensureAnonymousSession()` → Supabase anonymous JWT → `auth.uid()` derived
   **server-side from the verified JWT**. `members.id` is the app-level member UUID.
   Display name is cosmetic and authorizes nothing. *(docs/member-identity.md, mig 0001 D1)*
2. **How a member is associated with a room.** `members.room_id` FK
   (`ON DELETE RESTRICT`), plus composite FK `purchases(room_id, member_id) → members(room_id, id)`
   guaranteeing same-room integrity. A partial unique index allows a device one *active*
   membership per room.
3. **How egg purchases are stored.** `purchases(room_id, member_id, quantity > 0,
   total_cost numeric(10,2) ≥ 0, cost_per_egg GENERATED = total_cost/quantity, recorded_at)`.
   Append-only: a trigger raises on `UPDATE`/`DELETE`.
4. **How egg usage is stored.** `egg_usage(room_id, member_id, quantity, correction_of,
   recorded_at)`. Positive = consumption; negative + `correction_of` = compensating
   correction, composite-FK'd to the original usage **in the same room**. Append-only.
5. **How inventory is calculated.** Derived, never stored:
   `Σ purchases.quantity − Σ egg_usage.quantity` (corrections are negative usage, so they
   subtract correctly). Computed in `room_ledger()`.
6. **How the app synchronizes data.** Realtime `postgres_changes` on `rooms, members,
   purchases, egg_usage`; every event triggers a full `syncFromAuthoritative()` refetch of
   `room_ledger` + `room_history`. Room-scoped three ways: publication, RLS, client filter.
7. **How local identity persists.** Two places: Supabase's own session storage (the JWT),
   **and** `localStorage['anda.session'] = { room_id, member_id, share_code }`. The store
   also writes `meta/identity` into IndexedDB. Two sources of truth for "where am I" —
   a latent bug surface.
8. **How authentication works.** Anonymous only. `signInAnonymously()` on first
   create/join. Sign-in that is not gated by anything; no email, no password, no OAuth,
   no session recovery across devices.
9. **How deployment works.** Static SPA build; env injected via `import.meta.env`. No
   rewrite rules are committed, so deep links (which the new routing requires) currently
   have no server-side fallback.

---

## 3. Capability → implementation → new requirement → required change

| Existing capability | Current implementation | New UI requirement (PRD) | Required change |
|---|---|---|---|
| App shell | `App.tsx` view-state switch | Real routes: `/`, `/create-room`, `/join-room`, `/sign-in`, `/room/:roomId{/activity,/account}` (§9) | Add `react-router-dom`; keep file layout; add host rewrite config for deep links |
| Landing | `Welcome.tsx` (`pick` → `create`/`join`) | Landing is entry, not Home: Anda / "Eggs, sorted." / Create / Join / secondary Sign in (§10–11) | Re-skin + add Sign in link; restore room on valid session |
| Bottom nav | `Stock / History / Room` | `Home / Activity / Account` only (§6) | Retarget; **Room** tab dissolved — room code + members + leave move into Account (§27) |
| Home | `Dashboard.tsx` shows stock + **per-member liability** | Home prioritises room name, count, Eat, Buy; **no money** (§18) | Strip liability card; add Eat/Buy entry points per Stitch |
| Eat | `UsageEntry.tsx` full-screen with stepper | Stepper + Eat, optimistic → validate → commit → reconcile (§19–20) | Keep store semantics; restyle; singular "Eat" action |
| Buy | `PurchaseEntry.tsx` asks **total cost**, derives per-egg | Ask **unit price**, store unit price, derive total (§21–22) | UI flip **+ schema change + RPC signature change** |
| Activity | `History.tsx`, card-per-entry, kind badges | Ledger rows: actor / action / quantity / time; less social (§25–26) | Restyle rows; extend event kinds (settlement, membership) |
| Account | `RoomInfo.tsx` (`⚙ Room` tab) | Identity + auth state + money + room info + settlement, one screen (§27–30) | New screen; absorbs Room tab; add Sign in block |
| Identity | Anonymous JWT ↔ `members.auth_user_id` | Optional email/password that **upgrades** the same member, never duplicates (§15–17, §44) | New auth flow + RPCs; see §4.1 |
| Money | `numeric(10,2)` in DB; `parseFloat` in client | Integer minor units; one financial boundary module (§22, §45) | New `finance` module; paise on the wire; see §4.2 |
| Settlement | `settlements` table exists, **inert** (no RPC, no UI) | Visually in MVP; swipe-to-reveal; real transaction later (§29–30) | UI + finance-service boundary; minimal RPC only if UI cannot be honest without it |
| Realtime | 4 tables, room-scoped | Same, plus settlement/membership events (§31) | Add `settlements` to publication when it becomes live |
| Optimistic UI | Store pushes overlay, drops on confirm, clears all on reject | Same + human-readable error (§32) | Behaviour already correct; **bug:** rollback clears the *entire* pending array |
| Offline | IndexedDB cache + durable pending queue, flush on reconnect | Same (§33–34) | Keep; pending payload must follow the new unit-price shape; unify the two local-identity stores |
| Notifications | Threshold-crossing trigger + episode table + Edge Function | Same; no spam; no auth prerequisite (§35–36) | Already compliant — verify only |
| PWA | Manifest, icons, SW, app shell | Unchanged (§37) | Preserve; do not regress during re-skin |
| Errors | `toFriendly()` + `VALIDATION_MARKERS` → banner | Full state matrix (§39) | Extend mapping; add per-screen empty/loading states (§40–41) |

---

## 4. Gaps requiring schema / auth work

### 4.1 Identity — highest risk (PRD §15–17, §44, §51)

Current state is exactly the "browser/device UUID → member" shape the PRD calls out as
wrong. The goal shape is `auth user → persistent UUID → membership → room`, with the
existing member upgraded in place rather than duplicated.

Preferred path (Supabase supports in-place anonymous → permanent upgrade): the anonymous
user calls `updateUser({ email, password })`; **the `auth.uid()` does not change**, so
`members.auth_user_id` keeps pointing at the same row → same member, same history, same
balances, same room. That is the §44 outcome by construction, with zero data migration.

What is still missing even on the happy path:

- **Session bootstrap on a fresh device.** After clearing browser state, sign-in yields the
  same permanent uid but the client has no idea which room it belongs to. Needed: a
  read RPC (e.g. `my_memberships()`) returning active `{room_id, room_name, share_code,
  member_id, display_name}` rows for `auth.uid()`. This is the §51 "authenticated user can
  recover after clearing local browser state" case, and it is currently unsatisfiable.
- **Single local identity store.** `localStorage['anda.session']` and
  IndexedDB `meta/identity` both exist. Collapse to IndexedDB (the durable one) and treat
  localStorage as a read-through cache only.
- **Anonymous upgrade guard.** If an anonymous user has memberships in two rooms and then
  upgrades, all of them must follow. Verify the uid-preserving upgrade against the real
  project before relying on it; fallback is an explicit rebind RPC
  (`link_identity`) that re-points `members.auth_user_id` under server-side checks.
- **No duplicate-person rule.** Any recovery path must match on existing
  `auth_user_id` first and only ever *insert* a member when no match exists.

### 4.2 Purchase unit price (PRD §21–22)

`record_purchase(p_room_id, p_quantity, p_total_cost)` and the client's
`parseFloat(total) → total` both encode the wrong input model. The PRD is explicit:
quantity + price per egg, and "do not divide a total purchase price by quantity."

Plan (additive, history-preserving, §43):

- Add `purchases.unit_price_minor bigint` (integer paise per egg).
- Backfill existing rows: `round(total_cost * 100 / quantity)`.
- `record_purchase` takes `p_unit_price_minor bigint`; stores `unit_price_minor`, and
  derives `total_cost = unit_price_minor * quantity / 100` in exact `numeric` (integer
  paise in, no float anywhere). `cost_per_egg` (generated) is redefined to
  `unit_price_minor::numeric / 100` — dropping a *derived* column is non-destructive.
- `room_ledger` returns `liability_minor bigint` (FIFO allocation now runs in paise).
- Client: a `finance` module parses decimal input strings straight to integer paise
  (never through `parseFloat`) and formats paise back to `₹x.yy`. Floats exist only in
  scratch variables, never in stored or wire values.

### 4.3 Routing & navigation

No router today. Routes per §9 with `react-router-dom`. Because the app is a static SPA
with no committed rewrite rules, deep links need either a `vercel.json` rewrite or a
`public/_redirects`; both are one-liners and both are safe to add without knowing the
final host.

### 4.4 Financial boundary (PRD §45)

There is no separation today — `Dashboard.tsx` renders `₹{m.liability}` inline. All money
formatting, paise conversion, and balance/settlement shaping will go through
`web/src/lib/anda/finance.ts` (pure, unit-testable, no React), so the Account UI can be
built before the settlement mathematics is finalised and the calculation layer can be
swapped without touching a component.

### 4.5 Settlement

The `settlements` table is structural and inert (D7). §29 asks for the interaction to
exist and be honest, not for a full engine. Plan: build the swipe-to-reveal interaction
against `finance` interfaces, backed by a minimal settlement RPC only if a purely
visual treatment would be a fake timer — which the PRD forbids. No payment processing.

---

## 5. Reusable as-is (do not rebuild)

- All eight migrations and the RPC catalogue — inventory derivation, append-only ledger,
  correction semantics, room-row serialization (D19), RLS read boundary.
- `AndaStore`: optimistic overlay, `pending`/`rejected` split, validation-vs-network error
  discrimination, cache hydration, reconnect flush.
- `IdbRepo` / `transport.ts` / `api.ts` typed RPC layer.
- Realtime three-layer room scoping, low-stock episode state machine, push helpers.
- Theme tokens — a useful cross-check against Stitch's palette, not a replacement for it.

Known defect to fix while touching the store: on rejection,
`this.pending = []` discards *all* in-flight overlays, not just the failed one.

---

## 6. Change plan (phase-mapped)

| Phase | Work | New migrations |
|---|---|---|
| 1 | Router, app shell, route guards, host rewrites | — |
| 2 | Landing / create / join in Stitch visual language | — |
| 3 | Identity: sign-in, in-place upgrade, `my_memberships()`, unified local identity | `0007_identity_link.sql` |
| 4 | Home + Eat + Buy (unit-price input) | `0008_purchase_unit_price.sql` |
| 5 | Activity ledger rows + extended event kinds | (fold into 0008 if needed) |
| 6 | Account: identity block, balances, settlement interaction | `0009_settlements_live.sql` (only if required) |
| 7–10 | Realtime, offline, notifications, PWA/responsive polish | publication top-up |

Every migration is additive, idempotent-re-runnable where possible, and applied only after
the local Postgres suites pass against representative data (§43).

---

## 7. Open items

- Stitch artifacts (HTML/CSS + `DESIGN.md` + screenshots) — **not yet available in the
  workspace**; visual fidelity work is blocked until they are.
- Whether the production Supabase project has anonymous sign-ins enabled and whether
  in-place anonymous→permanent upgrade is enabled for it (determines §4.1 happy path vs
  explicit rebind RPC).
- Deployment target (Vercel vs Cloudflare) — only affects the deep-link rewrite file.
