// Anda — Dashboard: main room view (PRD §23).

import { useAndaStore } from '../lib/anda/react';
import type { AndaStore } from '../lib/anda/store';
import { theme } from '../lib/anda/theme';
import { s, SyncBadge, ErrorBanner } from '../ui';

interface Props { store: AndaStore; onNavigate: (v: string) => void }

export function Dashboard({ store, onNavigate }: Props) {
  useAndaStore(store);
  const view = store.view;
  const status = store.status;

  if (!view) {
    return <div style={s.root}><p style={{ color: theme.muted, padding: 60, textAlign: 'center' }}>No room data loaded.</p></div>;
  }

  const low = view.inventory <= view.lowStockThreshold;

  return (
    <div style={s.root}>
      {/* sync + room name header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8 }}>
        <span style={{ fontSize: 6, color: theme.accent, background: theme.accentBg, borderRadius: '50%', width: 12, height: 12 }} />
        <span style={{ flex: 1, fontSize: 18, fontWeight: 700 }}>{view.roomName}</span>
        <SyncBadge status={status} />
      </div>

      <ErrorBanner error={store.lastError} onDismiss={() => store.clearError()} />

      {/* pending rejections */}
      {store.rejected.length > 0 && (
        <div style={{ background: theme.dangerBg, border: `1px solid ${theme.danger}`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <p style={{ margin: 0, fontWeight: 700, fontSize: 14, color: theme.danger }}>Rejected transactions</p>
          {store.rejected.slice(-3).map((r, i) => (
            <p key={i} style={{ margin: '4px 0 0', fontSize: 13, color: theme.danger }}>× {r.error}</p>
          ))}
        </div>
      )}

      {/* egg stock */}
      <div style={{ ...(low ? s.cardLow : s.card), textAlign: 'center', padding: '24px 16px' }}>
        <div style={{ fontSize: 48, marginBottom: 4 }}>🥚</div>
        <div style={{ fontSize: 48, fontWeight: 800, lineHeight: 1, color: low ? theme.danger : theme.text }}>{view.inventory}</div>
        <div style={{ fontSize: 14, color: low ? theme.danger : theme.muted, marginTop: 4 }}>
          {low ? `Low stock (threshold: ${view.lowStockThreshold})` : 'eggs remaining'}
        </div>
        {status === 'offline' && <div style={{ fontSize: 12, color: theme.danger, marginTop: 8 }}>Offline — saved on this device</div>}
      </div>

      {/* action buttons */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button onClick={() => onNavigate('usage')} style={{ flex: 1, ...s.btn }}>
          🥚 Use eggs
        </button>
        <button onClick={() => onNavigate('purchase')} style={{ flex: 1, ...s.btnOutline }}>
          📦 Add eggs
        </button>
      </div>

      {/* member consumption table */}
      <div style={s.card}>
        <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: theme.muted, textTransform: 'uppercase' }}>Members</h3>
        {view.members.map(m => (
          <div key={m.member_id} style={s.row}>
            <div>
              <span>{m.display_name}</span>
              {!m.is_active && <span style={{ fontSize: 11, color: theme.muted, marginLeft: 6 }}>(left)</span>}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontWeight: 600 }}>{m.consumed} eggs</div>
              <div style={{ fontSize: 12, color: theme.muted }}>₹{m.liability}</div>
            </div>
          </div>
        ))}
      </div>

      {/* nav is rendered in App */}
    </div>
  );
}