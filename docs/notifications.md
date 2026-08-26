# Anda — Low-Stock Notifications (PRD §16, §17)

## State machine (§16) — one notification per low-stock episode

Authoritative inventory is recomputed inside the same transaction as every
ledger mutation (decision D27: an AFTER-INSERT trigger on `purchases` and
`egg_usage` calls `update_low_stock_state`; ledger rows are append-only in 0001,
so INSERT triggers cover every possible change, and the surrounding RPC already
serializes on the room row — atomic, rollback-safe, aligned with §11).

| State | Transition | Effect |
|---|---|---|
| `inventory > threshold` | any mutation | re-arm: `low_stock_notified = false` |
| `inventory ≤ threshold`, flag false | any mutation | flag := true; insert ONE `low_stock_alerts` row (the notification) |
| `inventory ≤ threshold`, flag true | further decrements | nothing — no spam (10→9→8 silent) |

The flag persists on `rooms.low_stock_notified` (0001) and is reset **only** by
rising above the threshold again — a later crossing (11→10 after restock)
produces a second notification. An episode that *starts* at/below the threshold
(first purchase) emits one alert too (decision D26: "one per episode").

Corrections participate: a compensating transaction that raises stock above the
threshold re-arms; subsequent crossings notify again.

## Subscription identity (§17) — `room → member → device`

- `push_subscriptions` (migration 0006): `(room_id, member_id, endpoint, p256dh,
  auth_secret)`, unique per endpoint, same-room composite FK, braces-enforced
  endpoint/key formats. Writes only via SECURITY DEFINER RPCs
  (`add_push_subscription` upserts on endpoint; `remove_push_subscription` is
  owner-scoped). RLS read = owner-only (`member_id = current_member_id(room_id)`).
- Delivery (edge function step 1–2): subscribes are joined to members and
  filtered to **active** members; an inactive (left) member's device receives
  nothing (its row remains for the audit trail).
- No email, no accounts — identity is the device-bound member (§4).

## Delivery pipeline (D29, D30)

```
ledger mutation commits
   ↓ (same transaction)
update_low_stock_state → INSERT low_stock_alerts (episode queue, private)
   ↓ (Supabase Database Webhook, INSERT)
supabase/functions/low-stock-notify  (Deno Edge Function, service role)
   ↓
load active members' subscriptions → send Web Push (VAPID ES256 + RFC 8291
encryption via @negrel/webpush) → mark delivered_at
   ↓
404/410 Gone → delete endpoint; 400/401/403 → remove after retry budget;
429/5xx → leave for retry
```

- `low_stock_alerts` is RLS-enabled with **no** member policies: it is an
  internal queue + audit trail, not a product screen (service role bypasses RLS
  for delivery/marking).
- Pure helpers (`supabase/functions/_shared/`) are unit-tested in Node:
  VAPID key generation/sign/verify, friendly payload copy, endpoint-verdict
  classification, active-subscription filtering. Full end-to-end delivery timing
  is verified at Phase 10 against the hosted edge + push service.

## PRD §27 Notification tests — `supabase/tests/notifications.sql`

| Check | Verifies |
|---|---|
| N1a–N1f | exactly one alert on 11→10 crossing; no spam on 8/7; restock re-arms; second crossing → second alert; still-low → none |
| N2a–N2b | correction-driven re-arm; third-episode crossing → third alert |
| N3a–N3c | starting at 5 (low) → one alert; restock re-arms; later crossing → second |
| S1–S6 | upsert-on-endpoint dedup; delivery joins active members only; non-member / inactive / malformed values rejected; owner-only remove |
| R1–R2 | RLS: owner sees only their subscription; alerts invisible to members; non-member sees nothing |