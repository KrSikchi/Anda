// Anda — session, identity and room store for the whole app (PRD §15–§17).
//
// One owner for "who am I, which room am I in, and what does that room look
// like right now". Screens read it; they never construct a store or touch
// localStorage themselves.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AndaStore } from '../lib/anda/store';
import { IdbRepo } from '../lib/anda/db';
import {
  clearIdentity,
  identityFromMembership,
  loadIdentity,
  readIdentitySync,
  saveIdentity,
  type LocalIdentity,
} from '../lib/anda/identity';
import type { AndaBackend } from '../lib/anda/backend';
import { createDemoBackendAdapter, createSupabaseBackend } from '../lib/anda/backend';
import { hasSupabaseEnv, supabase } from '../lib/anda/client';
import type { AuthState } from '../lib/anda/auth';
import type { MembershipSummary, RoomMembership } from '../lib/anda/types';

interface SessionValue {
  backend: AndaBackend;
  /** Restored room identity, or null when the user has no room yet. */
  identity: LocalIdentity | null;
  auth: AuthState;
  /** Live room store, present only while inside a room. */
  store: AndaStore | null;
  booting: boolean;
  /** Rooms recovered from a signed-in identity (PRD §17). */
  recovered: MembershipSummary[];
  enterRoom(membership: RoomMembership, opts?: { isHost?: boolean }): Promise<void>;
  enterRecovered(membership: MembershipSummary): Promise<void>;
  leaveRoom(): Promise<void>;
  refreshAuth(): Promise<void>;
  clearRecovered(): void;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}

const IDENTITY_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function isFresh(identity: LocalIdentity): boolean {
  return Date.now() - identity.savedAt < IDENTITY_TTL_MS;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const backend = useMemo<AndaBackend>(
    () =>
      hasSupabaseEnv() && supabase
        ? createSupabaseBackend(supabase)
        : createDemoBackendAdapter(),
    [],
  );

  const [identity, setIdentity] = useState<LocalIdentity | null>(() => {
    const mirrored = readIdentitySync();
    return mirrored && isFresh(mirrored) ? mirrored : null;
  });
  const [auth, setAuthState] = useState<AuthState>({ kind: 'none' });
  const [store, setStore] = useState<AndaStore | null>(null);
  const [booting, setBooting] = useState(true);
  const [recovered, setRecovered] = useState<MembershipSummary[]>([]);
  const disposed = useRef(false);

  // Restore identity from IndexedDB and read the current auth state.
  useEffect(() => {
    disposed.current = false;
    void (async () => {
      try {
        const stored = await loadIdentity();
        if (!disposed.current && stored && isFresh(stored)) setIdentity(stored);
      } catch {
        /* keep the mirrored identity */
      }
      try {
        const state = await backend.auth.state();
        if (!disposed.current) setAuthState(state);
      } catch {
        /* offline at boot: stay 'none' until the network answers */
      }
      if (!disposed.current) setBooting(false);
    })();
    return () => {
      disposed.current = true;
    };
  }, [backend]);

  // One store per room membership, disposed when the room changes.
  useEffect(() => {
    if (!identity) {
      setStore(null);
      return;
    }
    const next = new AndaStore({
      api: backend.api,
      transport: backend.transport,
      repo: new IdbRepo(),
      roomId: identity.roomId,
      currentMemberId: identity.memberId,
    });
    setStore(next);
    void next.init();
    return () => {
      next.dispose();
    };
  }, [identity, backend]);

  const enterRoom = useCallback(
    async (membership: RoomMembership, opts: { isHost?: boolean } = {}) => {
      const next = identityFromMembership({ ...membership, is_host: opts.isHost ?? false });
      await saveIdentity(next);
      setIdentity(next);
    },
    [],
  );

  const enterRecovered = useCallback(async (membership: MembershipSummary) => {
    const next = identityFromMembership({
      room_id: membership.room_id,
      room_name: membership.room_name,
      share_code: membership.share_code,
      member_id: membership.member_id,
      display_name: membership.display_name,
      low_stock_threshold: membership.low_stock_threshold,
      is_host: membership.is_host,
    });
    await saveIdentity(next);
    setRecovered([]);
    setIdentity(next);
  }, []);

  const refreshAuth = useCallback(async () => {
    try {
      setAuthState(await backend.auth.state());
    } catch {
      /* transient */
    }
  }, [backend]);

  const signOut = useCallback(async () => {
    await backend.auth.signOut();
    await clearIdentity();
    setIdentity(null);
    setRecovered([]);
    await refreshAuth();
  }, [backend, refreshAuth]);

  const leaveRoom = useCallback(async () => {
    if (identity) {
      try {
        await backend.api.leaveRoom?.(identity.roomId);
      } catch {
        // Leaving must still clear the device even if the call fails.
      }
    }
    await clearIdentity();
    setIdentity(null);
    setRecovered([]);
  }, [backend, identity]);

  const clearRecovered = useCallback(() => setRecovered([]), []);

  // A signed-in identity with no local room can recover its rooms from the
  // server (PRD §17, §51). Runs once per auth state, never on a cold anon boot.
  useEffect(() => {
    if (booting || identity || auth.kind !== 'permanent') return;
    if (!backend.api.myMemberships) return;
    void (async () => {
      try {
        const rooms = await backend.api.myMemberships?.();
        if (!disposed.current && rooms && rooms.length > 0) setRecovered(rooms);
      } catch {
        /* no rooms, or offline */
      }
    })();
  }, [booting, identity, auth.kind, backend]);

  const value = useMemo<SessionValue>(
    () => ({
      backend,
      identity,
      auth,
      store,
      booting,
      recovered,
      enterRoom,
      enterRecovered,
      leaveRoom,
      refreshAuth,
      clearRecovered,
      signOut,
    }),
    [
      backend,
      identity,
      auth,
      store,
      booting,
      recovered,
      enterRoom,
      enterRecovered,
      leaveRoom,
      refreshAuth,
      clearRecovered,
      signOut,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
