// Anda — low-stock notification Edge Function (Supabase / Deno)
//
// Triggered by a Supabase Database Webhook on INSERT into low_stock_alerts
// (migration 0006, decision D29), or can be invoked manually.
//
// Flow (§16, §17):
//   1. read the alert (room_id, inventory, threshold)
//   2. load the room's push subscriptions joined to active members
//   3. deliver a Web Push message to each valid subscription (RFC 8291/8292,
//      VAPID-signed ES256 JWT per the spec)
//   4. remove/expire subscriptions the push service reports as gone (404/410)
//   5. mark the alert delivered (audit trail)
//
// Environment (secrets never ship to the client — PRD §21):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (set automatically by Supabase)
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY      (deployment secret config)
//   webhook payload: { type: 'INSERT', table: 'low_stock_alerts',
//                      record: { id, room_id, inventory, threshold } }

import { createClient } from 'npm:@supabase/supabase-js@2';
import { WebPush } from 'npm:@negrel/webpush@0.3.4';
import { buildLowStockPayload } from '../_shared/payload.ts';
import { classifyDeliveryError, filterActiveSubscriptions } from '../_shared/delivery.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';

Deno.serve(async (req) => {
  if (!supabaseUrl || !serviceKey || !vapidPublic || !vapidPrivate) {
    return new Response('E_MISSING_CONFIG', { status: 500 });
  }

  let body: { record?: Record<string, unknown>; room_id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response('E_BAD_JSON', { status: 400 });
  }

  const alertId = typeof body.record?.id === 'string' ? body.record.id : undefined;
  const roomId =
    (typeof body.record?.room_id === 'string' ? body.record.room_id : undefined) ??
    (typeof body.room_id === 'string' ? body.room_id : undefined);
  const inventory =
    typeof body.record?.inventory === 'number'
      ? body.record.inventory
      : undefined;

  if (!roomId) return new Response('E_NO_ROOM', { status: 400 });

  const supabase = createClient(supabaseUrl, serviceKey);

  // Room name for the message + authoritative inventory if the webhook did
  // not include it.
  const { data: room } = await supabase
    .from('rooms')
    .select('name, low_stock_threshold')
    .eq('id', roomId)
    .single();

  let effectiveInventory = inventory;
  if (effectiveInventory === undefined) {
    const { data: latest } = await supabase
      .from('low_stock_alerts')
      .select('inventory')
      .eq('room_id', roomId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    effectiveInventory = typeof latest?.inventory === 'number' ? latest.inventory : 0;
  }

  // §17 steps 1–2: active members' valid subscriptions (service role bypasses
  // RLS for the membership join; active-member filtering still enforced here).
  const { data: subs, error: subsError } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth_secret, members(is_active)')
    .eq('room_id', roomId);

  if (subsError) return new Response(`E_SUBS:${subsError.message}`, { status: 500 });

  const active = filterActiveSubscriptions(subs ?? []);
  const payload = new TextEncoder().encode(
    JSON.stringify(buildLowStockPayload(effectiveInventory, room?.name ?? 'Your flat')),
  );

  const driver = new WebPush();
  let sent = 0;
  let removed = 0;
  let retry = 0;

  for (const sub of active) {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth_secret },
    };
    try {
      const res = await driver.send(payload, subscription, {
        subject: 'mailto:anda@localhost', // configurable
        publicKey: vapidPublic,
        privateKey: vapidPrivate,
      });
      const verdict = classifyDeliveryError(res.statusCode ?? 200);
      if (verdict === 'ok') {
        sent += 1;
      } else if (verdict === 'remove' || verdict === 'invalid') {
        // §17 step 4: clean up dead/invalid endpoints.
        await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        removed += 1;
      } else {
        retry += 1;
      }
    } catch {
      retry += 1;
    }
  }

  // Audit trail: record that this episode was delivered on.
  if (alertId) {
    await supabase
      .from('low_stock_alerts')
      .update({ delivered_at: new Date().toISOString() })
      .eq('id', alertId);
  }

  return Response.json(
    { delivered: sent, removedInvalid: removed, transientRetry: retry, roomId },
    { status: 200 },
  );
});