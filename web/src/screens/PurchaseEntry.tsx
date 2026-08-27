// Anda — Purchase entry modal (PRD §23: quantity + total cost).

import { useState } from 'react';
import { theme } from '../lib/anda/theme';
import type { AndaStore } from '../lib/anda/store';
import { s } from '../ui';

interface Props {
  store: AndaStore;
  onBack: () => void;
}

export function PurchaseEntry({ store, onBack }: Props) {
  const [qty, setQty] = useState(12);
  const [cost, setCost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    const c = parseFloat(cost);
    if (busy || qty < 1 || Number.isNaN(c) || c < 0) return;
    setBusy(true);
    setError(null);
    try {
      await store.recordPurchase(qty, c);
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
        <div style={{ fontSize: 48, marginBottom: 8 }}>📦</div>
        <p style={{ fontWeight: 700, fontSize: 18 }}>
          {qty} eggs added
        </p>
      </div>
    );
  }

  const perEgg = qty > 0 && !Number.isNaN(parseFloat(cost)) && parseFloat(cost) >= 0
    ? (parseFloat(cost) / qty).toFixed(2)
    : null;

  return (
    <div style={s.root}>
      <button
        onClick={onBack}
        style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 22, color: theme.text, padding: 0, marginBottom: 20 }}
      >
        ‹ Back
      </button>
      <h2 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 20px' }}>Add eggs</h2>
      {error && (
        <div style={{ background: theme.dangerBg, border: `1px solid ${theme.danger}`, borderRadius: 10, padding: 12, marginBottom: 12, color: theme.danger, fontSize: 14 }}>
          {error}
        </div>
      )}

      <div style={s.card}>
        <label style={{ display: 'block', fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Quantity</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', marginBottom: 16 }}>
          <button onClick={() => setQty(Math.max(1, qty - 6))} style={stepperBtn} disabled={busy}>−</button>
          <span style={{ fontSize: 32, fontWeight: 700, minWidth: 50, textAlign: 'center' }}>{qty}</span>
          <button onClick={() => setQty(qty + 6)} style={stepperBtn} disabled={busy}>+</button>
        </div>

        <label style={{ display: 'block', fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Total cost (₹)</label>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          placeholder="e.g. 96"
          disabled={busy}
          style={field}
        />
        {perEgg !== null && (
          <p style={{ fontSize: 13, color: theme.muted, margin: '8px 0 0' }}>
            ≈ ₹{perEgg} per egg
          </p>
        )}
      </div>

      <button
        onClick={submit}
        disabled={busy || qty < 1 || Number.isNaN(parseFloat(cost)) || parseFloat(cost) < 0}
        style={{ ...s.btn, opacity: busy || qty < 1 || Number.isNaN(parseFloat(cost)) || parseFloat(cost) < 0 ? 0.5 : 1 }}
      >
        {busy ? 'Adding…' : `Add ${qty} eggs`}
      </button>
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

const field: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  border: `1px solid ${theme.border}`,
  borderRadius: 10,
  fontSize: 16,
  outline: 'none',
  boxSizing: 'border-box',
  background: theme.bg,
  color: theme.text,
};