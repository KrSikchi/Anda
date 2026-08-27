// Anda — Main app shell with view-based routing.

import { useState, useEffect, useRef } from 'react';
import { AndaStore } from './lib/anda/store';
import { AndaContext } from './lib/anda/context';
import { createSupabaseApi } from './lib/anda/api';
import { supabase, hasSupabaseEnv } from './lib/anda/client';
import { IdbRepo } from './lib/anda/db';
import { createSupabaseTransport } from './lib/anda/transport';
import type { AndaApi, RoomMembership } from './lib/anda/types';
import { Welcome } from './screens/Welcome';
import { Dashboard } from './screens/Dashboard';
import { UsageEntry } from './screens/UsageEntry';
import { PurchaseEntry } from './screens/PurchaseEntry';
import { History } from './screens/History';
import { RoomInfo } from './screens/RoomInfo';
import { theme } from './lib/anda/theme';

type View = 'welcome' | 'dashboard' | 'usage' | 'purchase' | 'history' | 'roominfo';
type SavedSession = Pick<RoomMembership, 'room_id' | 'member_id' | 'share_code'>;
type RoomLifecycleApi = AndaApi & Required<Pick<AndaApi, 'createRoom' | 'joinRoom'>>;

const SESSION_KEY = 'anda.session';

export default function App() {
  const [view, setView] = useState<View>('welcome');
  const storeRef = useRef<AndaStore | null>(null);
  const [store, setStore] = useState<AndaStore | null>(null);
  const [api, setApi] = useState<RoomLifecycleApi | null>(null);
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasSupabaseEnv() || !supabase) {
      setSetupError('Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to web/.env.local.');
      return;
    }
    const nextApi = createSupabaseApi(supabase) as RoomLifecycleApi;
    setApi(nextApi);

    const saved = loadSession();
    if (!saved) return;
    const nextStore = new AndaStore({
      api: nextApi,
      transport: createSupabaseTransport(supabase),
      repo: new IdbRepo(),
      roomId: saved.room_id,
      currentMemberId: saved.member_id,
    });
    storeRef.current = nextStore;
    setStore(nextStore);
    setShareCode(saved.share_code);
    nextStore.init().then(() => setView('dashboard')).catch(() => setView('welcome'));
    return () => nextStore.dispose();
  }, []);

  const enterRoom = (membership: RoomMembership) => {
    if (!supabase || !api) return;
    storeRef.current?.dispose();
    saveSession(membership);
    setShareCode(membership.share_code);
    const nextStore = new AndaStore({
      api,
      transport: createSupabaseTransport(supabase),
      repo: new IdbRepo(),
      roomId: membership.room_id,
      currentMemberId: membership.member_id,
    });
    storeRef.current = nextStore;
    setStore(nextStore);
    void nextStore.init().then(() => setView('dashboard'));
  };

  const leaveRoom = async () => {
    if (store && api) await api.leaveRoom?.(store.roomId);
    storeRef.current?.dispose();
    storeRef.current = null;
    localStorage.removeItem(SESSION_KEY);
    setStore(null);
    setShareCode(null);
    setView('welcome');
  };

  if (setupError) {
    return <div style={{ maxWidth: 480, margin: '0 auto', padding: '80px 24px', color: theme.text, background: theme.bg, minHeight: '100dvh' }}>{setupError}</div>;
  }

  if (!api) {
    return <div style={{ maxWidth: 480, margin: '0 auto', padding: '80px 24px', textAlign: 'center', color: theme.muted, background: theme.bg, minHeight: '100dvh' }}>Loading…</div>;
  }

  const navItems: Array<{ key: View; label: string; show: boolean }> = [
    { key: 'dashboard', label: '🥚 Stock', show: Boolean(store?.state) },
    { key: 'history', label: '📃 History', show: Boolean(store?.state) },
    { key: 'roominfo', label: '⚙ Room', show: Boolean(store?.state) },
  ];

  const renderScreen = () => {
    switch (view) {
      case 'welcome': return <Welcome api={api} onEnterRoom={enterRoom} />;
      case 'usage': return store ? <UsageEntry store={store} onBack={() => setView('dashboard')} /> : <Welcome api={api} onEnterRoom={enterRoom} />;
      case 'purchase': return store ? <PurchaseEntry store={store} onBack={() => setView('dashboard')} /> : <Welcome api={api} onEnterRoom={enterRoom} />;
      case 'history': return store ? <History store={store} onBack={() => setView('dashboard')} /> : <Welcome api={api} onEnterRoom={enterRoom} />;
      case 'roominfo': return store ? <RoomInfo store={store} shareCode={shareCode} onLeave={leaveRoom} onNavigate={(v) => setView(v as View)} /> : <Welcome api={api} onEnterRoom={enterRoom} />;
      case 'dashboard':
      default:
        return store ? <Dashboard store={store} onNavigate={(v) => setView(v as View)} /> : <Welcome api={api} onEnterRoom={enterRoom} />;
    }
  };

  return (
    <AndaContext.Provider value={store}>
      <div style={{ background: theme.bg, minHeight: '100dvh' }}>
        {renderScreen()}
        {/* bottom navigation — only when in a room */}
        {store?.state && view !== 'welcome' && view !== 'usage' && view !== 'purchase' && (
          <div style={{
            position: 'fixed', bottom: 0, left: 0, right: 0,
            maxWidth: 480, margin: '0 auto',
            display: 'flex', borderTop: `1px solid ${theme.border}`,
            background: '#fff', zIndex: 10,
          }}>
            {navItems.filter(n => n.show).map((n) => (
              <button
                key={n.key}
                onClick={() => setView(n.key)}
                style={{
                  flex: 1, textAlign: 'center', padding: '10px 0', cursor: 'pointer',
                  fontSize: 12, fontWeight: view === n.key ? 700 : 500,
                  color: view === n.key ? theme.accent : theme.muted,
                  borderTop: view === n.key ? `2px solid ${theme.accent}` : '2px solid transparent',
                  background: 'none', borderLeft: 'none', borderRight: 'none', borderBottom: 'none',
                }}
              >
                {n.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </AndaContext.Provider>
  );
}

function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) as SavedSession : null;
  } catch {
    return null;
  }
}

function saveSession(membership: RoomMembership): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    room_id: membership.room_id,
    member_id: membership.member_id,
    share_code: membership.share_code,
  }));
}
