// Anda — local room identity (PRD §15, §33, §44).
//
// One place decides "which room am I in, and as whom".
//
// Before this module the answer lived in two places at once —
// localStorage['anda.session'] and IndexedDB meta/identity — which is how a
// device can end up believing two different things after a partial write or a
// cleared cache. IndexedDB is now the durable record (PRD §33 asks for
// structured local persistence); localStorage is a synchronous mirror used
// only to avoid a blank screen during the first paint, and is always
// reconciled against IndexedDB on load.

import { IdbRepo } from './db';

const IDENTITY_KEY = 'identity';
const MIRROR_KEY = 'anda.identity.v1';

export interface LocalIdentity {
  roomId: string;
  roomName: string;
  shareCode: string;
  memberId: string;
  displayName: string;
  isHost: boolean;
  lowStockThreshold: number;
  savedAt: number;
}

let repo: IdbRepo | null = null;

function identityRepo(): IdbRepo {
  repo ??= new IdbRepo();
  return repo;
}

function isUsable(value: unknown): value is LocalIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<LocalIdentity>;
  return (
    typeof v.roomId === 'string' &&
    v.roomId.length > 0 &&
    typeof v.memberId === 'string' &&
    v.memberId.length > 0
  );
}

/** Synchronous best-effort read, used only to avoid a flash of Landing. */
export function readIdentitySync(): LocalIdentity | null {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isUsable(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Authoritative read: IndexedDB first, mirror only if IDB is unavailable. */
export async function loadIdentity(): Promise<LocalIdentity | null> {
  try {
    const stored = await identityRepo().loadMeta<unknown>(IDENTITY_KEY);
    if (isUsable(stored)) {
      writeMirror(stored);
      return stored;
    }
  } catch {
    // Private-mode browsers can refuse IndexedDB; fall through to the mirror.
  }
  return readIdentitySync();
}

export async function saveIdentity(identity: LocalIdentity): Promise<void> {
  const record: LocalIdentity = { ...identity, savedAt: Date.now() };
  writeMirror(record);
  try {
    await identityRepo().saveMeta(IDENTITY_KEY, record);
  } catch {
    // The mirror is enough to keep the session usable this run.
  }
}

export async function clearIdentity(): Promise<void> {
  try {
    localStorage.removeItem(MIRROR_KEY);
  } catch {
    /* ignore */
  }
  try {
    await identityRepo().saveMeta(IDENTITY_KEY, null);
  } catch {
    /* ignore */
  }
}

function writeMirror(identity: LocalIdentity): void {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(identity));
  } catch {
    /* ignore */
  }
}

/** Adapt a create/join result or a recovered membership into local identity. */
export function identityFromMembership(input: {
  room_id: string;
  room_name: string;
  share_code: string;
  member_id: string;
  display_name: string;
  low_stock_threshold: number;
  is_host?: boolean;
}): LocalIdentity {
  return {
    roomId: input.room_id,
    roomName: input.room_name,
    shareCode: input.share_code,
    memberId: input.member_id,
    displayName: input.display_name,
    isHost: input.is_host ?? false,
    lowStockThreshold: input.low_stock_threshold,
    savedAt: Date.now(),
  };
}
