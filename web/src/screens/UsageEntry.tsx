// Anda — Usage entry modal (PRD §23: "extremely fast").

import { useState } from 'react';
import { theme } from '../lib/anda/theme';
import type { AndaStore } from '../lib/anda/store';
import { s } from '../ui';

interface Props {
  store: AndaStore;
  onBack: () => void;
}

export function UsageEntry({ store, onBack }: Props) {
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const inv = store.view?.inventory ?? 0;

  const submit = async () => {
    if (busy || qty < 1) return;
    setBusy(true);
    setError(null);
    try {
      await store.recordUsage(qty);
      setDone(true);
      setTimeout(onBack, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div style={{ ...s.root, textAlign: 'center', paddingTop: 100 }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>✅</div>
        <p style={{ fontWeight: 700, fontSize: 18 }}>
          {qty} egg{qty > 1 ? 's' : ''} used
        </p>
      </div>
    );
  }

  return (
    <div style={s.root}>
      <button
        onClick={onBack}
        style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 22, color: theme.text, padding: 0, marginBottom: 20 }}
      >
        ‹ Back
      </button>
      <h2 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 20px' }}>Use eggs</h2>
      {error && (
        <div style={{ background: theme.dangerBg, border: `1px solid ${theme.danger}`, borderRadius: 10, padding: 12, marginBottom: 12, color: theme.danger, fontSize: 14 }}>
          {error}
        </div>
      )}

      <div style={{ ...s.card, textAlign: 'center', padding: '24px 16px' }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🥚</div>
        <div style={{ fontSize: 14, color: theme.muted, marginBottom: 12 }}>
          {inv} egg{inv !== 1 ? 's' : ''} remaining
        </div>
      </div>

      <div style={s.card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center' }}>
          <button onClick={() => setQty(Math.max(1, qty - 1))} style={stepperBtn} disabled={busy}>−</button>
          <span style={{ fontSize: 32, fontWeight: 700, minWidth: 50, textAlign: 'center' }}>{qty}</span>
          <button onClick={() => setQty(qty + 1)} style={stepperBtn} disabled={busy}>+</button>
        </div>
        <button
          onClick={submit}
          disabled={busy || qty < 1}
          style={{ ...s.btn, marginTop: 16, opacity: busy || qty < 1 ? 0.5 : 1 }}
        >
          {busy ? 'Recording…' : `Use ${qty} egg${qty > 1 ? 's' : ''}`}
        </button>
      </div>
    </div>
  );
}

const stepperBtn: React.CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: '50%',
  border: `1px solid ${theme.border}`,
  background: '#fff',
  fontSize: 22,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};