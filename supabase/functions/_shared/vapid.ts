// Anda — VAPID (RFC 8292) helpers for the low-stock push Edge Function.
// Pure ECMAScript over WebCrypto (works in Node ≥ 19, Deno, browsers) and
// therefore unit-testable in the repo's vitest suite.
//
// A VAPID JWT is an ES256 JWT whose `aud` is the push service origin and whose
// `sub` identifies the application server (a mailto: or https: URL).

export interface VapidKeys {
  /** base64url of the 65-byte uncompressed P-256 public point (0x04 UX UY). */
  publicKey: string;
  /** base64url of the 32-byte private scalar. */
  privateKey: string;
}

export const VAPID_DEFAULT_PAYLOAD: Record<string, unknown> = {};

function bytesToB64u(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = '';
  bytes.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uToBytes(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const binary = atob(b64 + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// WebCrypto's BufferSource expects a concrete ArrayBuffer. Normalize inputs so
// the helpers type-check under strict lib settings (Uint8Array generic).
function toBufferSource(input: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(input.length);
  copy.set(input);
  return copy.buffer as ArrayBuffer;
}

const EC_JWK: { name: 'ECDSA'; namedCurve: 'P-256' } = { name: 'ECDSA', namedCurve: 'P-256' };

function pointToJwk(publicKeyB64u: string): { x: string; y: string } {
  const raw = b64uToBytes(publicKeyB64u);
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error('VAPID public key must be an uncompressed P-256 point (65 bytes, 0x04 prefix)');
  }
  return { x: bytesToB64u(raw.subarray(1, 33)), y: bytesToB64u(raw.subarray(33, 65)) };
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const kp = await crypto.subtle.generateKey(EC_JWK, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: bytesToB64u(raw), privateKey: jwk.d ?? '' };
}

export async function createVapidJwt(
  sub: string,
  aud: string,
  keys: VapidKeys,
  expSeconds: number = 12 * 3600,
): Promise<string> {
  const enc = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud, exp: now + expSeconds, sub };
  const signingInput = `${bytesToB64u(enc.encode(JSON.stringify(header)))}.${bytesToB64u(
    enc.encode(JSON.stringify(payload)),
  )}`;

  const { x, y } = pointToJwk(keys.publicKey);
  const privateJwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x, y, d: keys.privateKey, ext: true };
  const privateKey = await crypto.subtle.importKey('jwk', privateJwk, EC_JWK, false, ['sign']);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    toBufferSource(enc.encode(signingInput)),
  );
  return `${signingInput}.${bytesToB64u(sig)}`;
}

export async function verifyVapidJwt(jwt: string, publicKeyB64u: string): Promise<boolean> {
  const parts = jwt.split('.');
  if (parts.length !== 3) return false;
  const [h, p, s] = parts;
  const { x, y } = pointToJwk(publicKeyB64u);
  const publicJwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x, y, ext: true };
  const publicKey = await crypto.subtle.importKey('jwk', publicJwk, EC_JWK, false, ['verify']);
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    toBufferSource(b64uToBytes(s)),
    toBufferSource(new TextEncoder().encode(`${h}.${p}`)),
  );
}

export function decodeVapidJwt<T>(jwt: string): T | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = new TextDecoder().decode(b64uToBytes(parts[1]));
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}