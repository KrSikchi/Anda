// Anda — Main app shell with view-based routing.

import { useState, useEffect, useRef } from 'react';
import { AndaStore } from './lib/anda/store';
import { AndaContext } from './lib/anda/context';
import { Welcome } from './screens/Welcome';
import { Dashboard } from './screens/Dashboard';
import { UsageEntry } from './screens/UsageEntry';
import { PurchaseEntry } from './screens/PurchaseEntry';
import { History } from './screens/History';
import { RoomInfo } from './screens/RoomInfo';
import { theme } from './lib/anda/theme';

type View = 'welcome' | 'dashboard' | 'usage' | 'purchase' | 'history' | 'roominfo';

// Mock store for development — will be replaced by real Supabase wiring.
function createMockStore(): AndaStore {
  const api = {
    fetchLedger: async () => [
      {
        room_id: 'mock-room',
        room_name: 'Flat 42',
        inventory: 12,
        low_stock_threshold: 10,
        low_stock_notified: false,
        member_id: 'member-me',
        display_name: 'Alice',
        is_active: true,
        consumed: 4,
        liability: 32,
      },
      {
        room_id: 'mock-room',
        room_name: 'Flat 42',
        inventory: 12,
        low_stock_threshold: 10,
        low_stock_notified: false,
        member_id: 'member-other',
        display_name: 'Bob',
        is_active: true,
        consumed: 6,
        liability: 48,
      },
    ],
    fetchHistory: async () => [
      { entry_id: '1', kind: 'usage' as const, recorded_at: new Date().toISOString(), quantity: 2, member_id: 'member-me', member_name: 'Alice', correction_of: null, detail: 'eggs used' },
      { entry_id: '2', kind: 'purchase' as const, recorded_at: new Date(Date.now() - 86400000).toISOString(), quantity: 30, member_id: 'member-me', member_name: 'Alice', correction_of: null, detail: '96 total · 8 per egg' },
    ],
    recordUsage: async () => {},
    recordPurchase: async () => {},
  };
  const transport = {
    subscribe: () => () => {},
  };
  return new AndaStore({ api, transport, roomId: 'mock-room', currentMemberId: 'member-me' });
}

export default function App() {
  const [view, setView] = useState<View>('welcome');
  const storeRef = useRef<AndaStore | null>(null);
  const [store, setStore] = useState<AndaStore | null>(null);

  useEffect(() => {
    const s = createMockStore();
    storeRef.current = s;
    setStore(s);
    s.init().then(() => {
      // Once store loads successfully, go to dashboard
      if (storeRef.current?.state) setView('dashboard');
    }).catch(() => setView('welcome'));
  }, []);

  if (!store) {
    return <div style={{ maxWidth: 480, margin: '0 auto', padding: '80px 24px', textAlign: 'center', color: theme.muted, background: theme.bg, minHeight: '100dvh' }}>Loading…</div>;
  }

  const navItems: Array<{ key: View; label: string; show: boolean }> = [
    { key: 'dashboard', label: '🥚 Stock', show: store.state !== null },
    { key: 'history', label: '📃 History', show: store.state !== null },
    { key: 'roominfo', label: '⚙ Room', show: store.state !== null },
  ];

  const renderScreen = () => {
    switch (view) {
      case 'welcome': return <Welcome onNavigate={(v) => setView(v as View)} />;
      case 'usage': return <UsageEntry store={store} onBack={() => setView('dashboard')} />;
      case 'purchase': return <PurchaseEntry store={store} onBack={() => setView('dashboard')} />;
      case 'history': return <History store={store} onBack={() => setView('dashboard')} />;
      case 'roominfo': return <RoomInfo store={store} onNavigate={(v) => setView(v as View)} />;
      case 'dashboard':
      default:
        return <Dashboard store={store} onNavigate={(v) => setView(v as View)} />;
    }
  };

  return (
    <AndaContext.Provider value={store}>
      <div style={{ background: theme.bg, minHeight: '100dvh' }}>
        {renderScreen()}
        {/* bottom navigation — only when in a room */}
        {store.state !== null && view !== 'usage' && view !== 'purchase' && (
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