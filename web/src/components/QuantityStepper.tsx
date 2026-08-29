// Anda — quantity stepper (PRD §19, §38). Large touch targets, no typing.

import { Icon } from './Icon';

export function QuantityStepper({
  value,
  onChange,
  min = 1,
  max = 999,
  step = 1,
  disabled = false,
  label = 'Quantity',
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  label?: string;
}) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next));

  return (
    <div className="stepper" role="group" aria-label={label}>
      <button
        type="button"
        className="stepper__btn"
        onClick={() => onChange(clamp(value - step))}
        disabled={disabled || value <= min}
        aria-label={`Decrease by ${step}`}
      >
        <Icon name="remove" size={26} />
      </button>
      <div className="stepper__value" aria-live="polite" aria-atomic="true">
        {value}
      </div>
      <button
        type="button"
        className="stepper__btn"
        onClick={() => onChange(clamp(value + step))}
        disabled={disabled || value >= max}
        aria-label={`Increase by ${step}`}
      >
        <Icon name="add" size={26} />
      </button>
    </div>
  );
}
