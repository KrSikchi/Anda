// Anda — Unit tests for the low-stock push helpers (PRD §16, §17, §27).
//
// The pure VAPID / payload / delivery-verdict / active-subscription logic in
// supabase/functions/_shared is framework-free WebCrypto code, so it is tested
// here under Node (vitest) exactly as it runs in the Deno Edge Function.

import { describe, expect, it } from 'vitest';
import {
  createVapidJwt,
  decodeVapidJwt,
  generateVapidKeys,
  verifyVapidJwt,
} from '../../../../../supabase/functions/_shared/vapid';
import { buildLowStockPayload } from '../../../../../supabase/functions/_shared/payload';
import {
  classifyDeliveryError,
  filterActiveSubscriptions,
  type PushSubscriptionRow,
} from '../../../../../supabase/functions/_shared/delivery';

describe('VAPID JWT (RFC 8292)', () => {
  it('generates keys, signs a JWT, and verifies it', async () => {
    const keys = await generateVapidKeys();
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]{80,88}$/);

    const jwt = await createVapidJwt('mailto:anda@localhost', 'https://push.example', keys);
    expect(jwt.split('.')).toHaveLength(3);
    await expect(verifyVapidJwt(jwt, keys.publicKey)).resolves.toBe(true);
  });

  it('fails verification when the JWT is tampered with', async () => {
    const keys = await generateVapidKeys();
    const jwt = await createVapidJwt('mailto:anda@localhost', 'https://push.example', keys);
    const tampered = `${jwt.slice(0, -4)}AAAA`;
    await expect(verifyVapidJwt(tampered, keys.publicKey)).resolves.toBe(false);
  });

  it('carries valid claims (aud, sub, exp in the future)', async () => {
    const keys = await generateVapidKeys();
    const jwt = await createVapidJwt('mailto:anda@localhost', 'https://push.example', keys, 3600);
    const claims = decodeVapidJwt<{ aud: string; sub: string; exp: number }>(jwt);
    expect(claims?.aud).toBe('https://push.example');
    expect(claims?.sub).toBe('mailto:anda@localhost');
    expect(claims?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe('low-stock payload (§16, §24)', () => {
  it('plural and singular copy', () => {
    expect(buildLowStockPayload(4, 'Flat A').body).toContain('4 eggs left');
    expect(buildLowStockPayload(1, 'Flat A').body).toContain('1 egg left');
  });

  it('out-of-eggs copy and episode de-dup tag', () => {
    const p0 = buildLowStockPayload(0, 'Flat A');
    expect(p0.body).toContain('All eggs are gone');
    const p7 = buildLowStockPayload(7, 'Flat A');
    expect(p7.tag).toBe('anda-low-stock'); // same tag → browser dedups per episode
    expect(p7.data.type).toBe('low-stock');
  });
});

describe('endpoint verdicts (§17 step 4)', () => {
  it('404/410 Gone → remove', () => {
    expect(classifyDeliveryError(404)).toBe('remove');
    expect(classifyDeliveryError(410)).toBe('remove');
  });

  it('400/401/403 → invalid; 429/5xx → retry; 2xx → ok', () => {
    expect(classifyDeliveryError(200)).toBe('ok');
    expect(classifyDeliveryError(201)).toBe('ok');
    expect(classifyDeliveryError(400)).toBe('invalid');
    expect(classifyDeliveryError(401)).toBe('invalid');
    expect(classifyDeliveryError(403)).toBe('invalid');
    expect(classifyDeliveryError(429)).toBe('retry');
    expect(classifyDeliveryError(500)).toBe('retry');
    expect(classifyDeliveryError(503)).toBe('retry');
  });
});

describe('active-subscription filtering (§17 step 1)', () => {
  const rows: PushSubscriptionRow[] = [
    { endpoint: 'a', p256dh: 'x', auth_secret: 'y', members: { is_active: true } },
    { endpoint: 'b', p256dh: 'x', auth_secret: 'y', members: { is_active: false } },
    { endpoint: 'c', p256dh: 'x', auth_secret: 'y', members: [{ is_active: true }] },
    { endpoint: 'd', p256dh: 'x', auth_secret: 'y', members: null },
    { endpoint: 'e', p256dh: 'x', auth_secret: 'y' },
  ];

  it('keeps only subscriptions of active members', () => {
    const kept = filterActiveSubscriptions(rows).map((r) => r.endpoint);
    expect(kept).toEqual(['a', 'c']); // object-form and array-form active members
  });
});