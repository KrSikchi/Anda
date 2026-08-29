// Anda — low-stock push notifications (PRD §35, §36).
//
// Supplemental: Anda is fully usable with this switched off, and nothing here
// gates a room. There is no email or account requirement — a subscription is
// tied to the device and the room member, exactly as §36 asks.
//
// The delivery side already exists server-side (migration 0006: an episode
// queue, a threshold-crossing state machine that fires once per episode, and a
// `low-stock-notify` Edge Function). This module only does the device half:
// ask for permission, hand the resulting subscription to the server, and clean
// up honestly when a subscription expires or the user changes their mind.

import type { AndaApi } from './types';

export type PushState = 'unsupported' | 'denied' | 'off' | 'on' | 'busy';

const PREF_KEY = 'anda.push.enabled';

const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function vapidConfigured(): boolean {
  return Boolean(vapidPublicKey && vapidPublicKey.length > 0);
}

export function currentPushState(): PushState {
  if (!pushSupported() || !vapidConfigured()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return localStorage.getItem(PREF_KEY) === 'true' ? 'on' : 'off';
}

/** VAPID application server keys are base64url; PushManager wants raw bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalised);
  // Backed by an explicit ArrayBuffer so the type is a plain BufferSource.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * Subscribe this device to low-stock alerts for a room.
 * Returns the resulting state so the UI can explain what happened rather
 * than silently doing nothing (PRD §39).
 */
export async function enableLowStockAlerts(
  api: AndaApi,
  roomId: string,
): Promise<PushState> {
  if (!pushSupported() || !vapidConfigured() || !api.addPushSubscription) {
    return 'unsupported';
  }

  let permission = Notification.permission;
  if (permission === 'default') permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';

  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();

    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey!),
      }));

    const json = subscription.toJSON();
    const endpoint = json.endpoint ?? '';
    const p256dh = json.keys?.p256dh ?? '';
    const auth = json.keys?.auth ?? '';
    if (!endpoint || !p256dh || !auth) return 'denied';

    await api.addPushSubscription(roomId, endpoint, p256dh, auth);
    localStorage.setItem(PREF_KEY, 'true');
    return 'on';
  } catch (err) {
    // A subscription that has gone stale is the common case, not a hard
    // failure: drop it and let the caller retry (PRD §36).
    console.warn('Anda: push subscription failed', err);
    return 'denied';
  }
}

/** Stop alerts for this device. Expired endpoints are cleaned up either way. */
export async function disableLowStockAlerts(
  api: AndaApi,
  roomId: string,
): Promise<PushState> {
  localStorage.removeItem(PREF_KEY);

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      const { endpoint } = subscription;
      await subscription.unsubscribe();
      if (endpoint && api.removePushSubscription) {
        await api.removePushSubscription(roomId, endpoint).catch(() => undefined);
      }
    }
  } catch (err) {
    console.warn('Anda: could not remove push subscription', err);
  }

  return 'off';
}
