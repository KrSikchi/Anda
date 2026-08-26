// Anda — push-delivery helpers for the low-stock Edge Function (§17).
// Pure, framework-free: unit-testable in Node/Deno alike.

/** What to do with an endpoint given a push-service response. */
export type EndpointVerdict = 'ok' | 'remove' | 'invalid' | 'retry';

/**
 * §17 step 4 — "Handle invalid/expired subscriptions appropriately":
 *  - 404/410 Gone        → endpoint dead: remove it
 *  - 400/401/403         → undeliverable config: treat as invalid (removed by
 *                          the caller after a bounded retry budget)
 *  - 429/5xx             → transient: retry later
 *  - 2xx                 → delivered
 */
export function classifyDeliveryError(status: number): EndpointVerdict {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 404 || status === 410) return 'remove';
  if (status === 400 || status === 401 || status === 403) return 'invalid';
  return 'retry';
}

/** Shape of a push_subscriptions row (as returned by the API). */
export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth_secret: string;
  members?: { is_active?: boolean } | Array<{ is_active?: boolean }> | null;
}

/**
 * Keep only subscriptions whose owning member is ACTIVE (PRD §17 step 1:
 * "Determine the room's active members. Retrieve valid notification
 * subscriptions."). Handles both object and array forms of the joined member.
 */
export function filterActiveSubscriptions(rows: PushSubscriptionRow[]): PushSubscriptionRow[] {
  return rows.filter((r) => {
    const m = r.members;
    if (Array.isArray(m)) return m.length > 0 && m.some((x) => x?.is_active);
    return !!m?.is_active;
  });
}