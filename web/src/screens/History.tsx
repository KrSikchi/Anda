// Anda — Transaction history screen (PRD §23: enough to understand corrections).

import { useAndaStore } from '../lib/anda/react';
import type { AndaStore } from '../lib/anda/store';
import { theme } from '../lib/anda/theme';
import { s, SyncBadge, ErrorBanner } from '../ui';

interface Props {
  store: AndaStore;
  onBack: () => void;
}

export function History({ store, onBack }: Props) {
  useAndaStore(store);

  return (
    <div style={s.root}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 16 }}>
        <button onClick={onBack} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 22, color: theme.text, padding: 0 }}>‹</button>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, flex: 1 }}>History</h1>
        <SyncBadge status={store.status} />
      </div>

      <ErrorBanner error={store.lastError} onDismiss={() => store.clearError()} />

      {!store.history || store.history.length === 0 ? (
        <p style={{ color: theme.muted, padding: 40, textAlign: 'center' }}>No transactions yet.</p>
      ) : (
        store.history.map((h) => (
          <div key={h.entry_id} style={s.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <span style={{
                  display: 'inline-block',
                  padding: '1px 8px',
                  borderRadius: 20,
                  fontSize: 11,
                  fontWeight: 600,
                  background: h.kind === 'purchase' ? theme.successBg : h.kind === 'correction' ? theme.accentBg : theme.surface,
                  color: h.kind === 'purchase' ? theme.success : h.kind === 'correction' ? theme.accent : theme.text,
                  marginBottom: 4,
                }}>
                  {h.kind === 'purchase' ? 'PURCHASE' : h.kind === 'correction' ? 'CORRECTION' : 'USAGE'}
                </span>
                <div style={{ fontSize: 13, color: theme.muted }}>
                  {h.member_name} · {new Date(h.recorded_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 700, fontSize: 16, color: h.quantity > 0 ? theme.text : theme.success }}>
                  {h.quantity > 0 ? `+${h.quantity}` : h.quantity}
                </div>
                <div style={{ fontSize: 12, color: theme.muted }}>{h.detail}</div>
              </div>
            </div>
            {h.correction_of && (
              <div style={{ marginTop: 8, fontSize: 12, color: theme.muted, borderTop: `1px solid ${theme.border}`, paddingTop: 6 }}>
                Fixes entry {h.correction_of.slice(0, 8)}…
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}