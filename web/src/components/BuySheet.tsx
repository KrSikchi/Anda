// Anda — Buy sheet (PRD §21, §22).
//
// Two steps, matching the supplied design:
//   1. How many eggs?
//   2. What is the price per egg?  → total is derived and shown
//
// The unit price is the input and the authoritative stored value. The total is
// only ever displayed — it is never entered and never divided back into a unit
// price. Money is integer paise from the keystroke onwards.

import { useState } from 'react';
import { Sheet } from './Sheet';
import { QuantityStepper } from './QuantityStepper';
import { Button, Banner, TextInput } from './ui';
import { useSession } from '../session/SessionProvider';
import { useAndaStore } from '../lib/anda/react';
import {
  formatMinor,
  parseMoneyToMinor,
  purchaseTotalMinor,
} from '../lib/anda/finance';

export function BuySheet({ onClose }: { onClose: () => void }) {
  const { store } = useSession();
  const s = useAndaStore(store);
  const [step, setStep] = useState<'quantity' | 'price'>('quantity');
  const [quantity, setQuantity] = useState(12);
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const unitPriceMinor = parseMoneyToMinor(price);
  const totalMinor =
    unitPriceMinor === null ? 0 : purchaseTotalMinor(quantity, unitPriceMinor);

  const submit = async () => {
    if (!s || unitPriceMinor === null) return;
    setBusy(true);
    setError(null);
    try {
      await s.recordPurchase(quantity, unitPriceMinor);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : 'Could not record that purchase. Try again.',
      );
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={step === 'quantity' ? 'How many eggs?' : 'What is the price per egg?'}
      onClose={onClose}
    >
      {step === 'quantity' ? (
        <>
          <QuantityStepper
            value={quantity}
            onChange={setQuantity}
            min={1}
            max={999}
            disabled={busy}
          />
          <div style={{ marginTop: 24 }}>
            <Button onClick={() => setStep('price')} icon="arrow_forward">
              Next
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="money-input">
            <span className="money-input__symbol">₹</span>
            <TextInput
              className="input--money"
              value={price}
              onChange={setPrice}
              placeholder="6.00"
              inputMode="decimal"
              autoFocus
              ariaLabel="Price per egg in rupees"
            />
          </div>

          <div
            className="row row--between"
            style={{
              marginTop: 16,
              padding: '14px 16px',
              background: 'var(--surface-sunken)',
              borderRadius: 'var(--r-md)',
            }}
          >
            <span style={{ fontWeight: 600 }}>
              Total Price ({quantity} egg{quantity === 1 ? '' : 's'})
            </span>
            <span className="money" style={{ fontWeight: 800, fontSize: 18 }}>
              {formatMinor(totalMinor)}
            </span>
          </div>

          <p className="muted" style={{ marginTop: 8 }}>
            {unitPriceMinor === null
              ? 'Enter the price of one egg, not the whole carton.'
              : `${formatMinor(unitPriceMinor)} per egg × ${quantity}`}
          </p>

          {error ? (
            <div style={{ marginTop: 12 }}>
              <Banner tone="error" icon="error">
                {error}
              </Banner>
            </div>
          ) : null}

          <div style={{ marginTop: 20 }} className="stack">
            <Button
              onClick={submit}
              busy={busy}
              disabled={unitPriceMinor === null}
              icon="add_circle"
            >
              Stock
            </Button>
            <Button variant="quiet" onClick={() => setStep('quantity')} disabled={busy}>
              Back
            </Button>
          </div>
        </>
      )}
    </Sheet>
  );
}
