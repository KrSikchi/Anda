// Anda — Eat sheet (PRD §19, §20, §32).
//
// One action: eggs leave the inventory. There is no separate "discard" or
// "waste" category — the PRD keeps removal singular and simple.
//
// The UI responds immediately, then the server has the final word: if there
// are not enough eggs the optimistic count is rolled back and the reason is
// shown in plain language (PRD §32, §39).

import { useState } from 'react';
import { Sheet } from './Sheet';
import { QuantityStepper } from './QuantityStepper';
import { Button, Banner } from './ui';
import { useSession } from '../session/SessionProvider';
import { useAndaStore } from '../lib/anda/react';

export function EatSheet({ onClose }: { onClose: () => void }) {
  const { store } = useSession();
  const s = useAndaStore(store);
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const available = s?.view?.inventory ?? 0;

  const submit = async () => {
    if (!s) return;
    setBusy(true);
    setError(null);
    try {
      await s.recordUsage(quantity);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : 'Could not record that. Try again.',
      );
      setBusy(false);
    }
  };

  return (
    <Sheet title="How many eggs did you use?" onClose={onClose}>
      <QuantityStepper
        value={quantity}
        onChange={setQuantity}
        min={1}
        max={Math.max(1, available)}
        disabled={busy}
      />

      <p className="muted center" style={{ marginTop: 16 }}>
        {available} egg{available === 1 ? '' : 's'} remaining
      </p>

      {available === 0 ? (
        <Banner tone="warn" icon="egg_alt">
          No eggs in the room. Add a purchase first.
        </Banner>
      ) : null}

      {error ? (
        <div style={{ marginTop: 12 }}>
          <Banner tone="error" icon="error">
            {error}
          </Banner>
        </div>
      ) : null}

      <div style={{ marginTop: 20 }}>
        <Button
          onClick={submit}
          busy={busy}
          disabled={quantity > available || available === 0}
          icon="restaurant"
        >
          Confirm
        </Button>
      </div>
    </Sheet>
  );
}
