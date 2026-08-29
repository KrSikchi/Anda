// Anda — swipe-to-reveal row (PRD §29).
//
// The supplied design reveals a Settle action by dragging a balance row. The
// interaction is preserved, but it is wired to a real settlement transaction
// rather than a demo timer (PRD §3), and it keeps a visible button as well:
// a swipe-only affordance is unreachable by keyboard and by anyone using a
// screen reader (PRD §47 allows deviations for accessibility).

import { useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

const REVEAL = 120;
const TRIGGER = 72;

export function SwipeRow({
  children,
  actionLabel,
  onAction,
  disabled = false,
}: {
  children: ReactNode;
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    startX.current = e.clientX;
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging || disabled) return;
    const delta = startX.current - e.clientX;
    setOffset(Math.max(0, Math.min(REVEAL, delta)));
  };

  const finish = () => {
    if (!dragging) return;
    setDragging(false);
    if (offset >= TRIGGER) {
      setOffset(0);
      onAction();
      return;
    }
    setOffset(0);
  };

  return (
    <div className="swipe">
      <div className="swipe__action" aria-hidden={offset === 0}>
        <Icon name="check" size={18} />
        {actionLabel}
      </div>
      <div
        className={`swipe__surface${dragging ? '' : ' swipe__surface--still'}`}
        style={{ transform: `translateX(-${offset}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
      >
        {children}
        {!disabled ? (
          <button
            type="button"
            className="btn btn--ghost"
            style={{ width: 'auto', minHeight: 38, marginLeft: 'auto', padding: '0 14px', fontSize: 14 }}
            onClick={onAction}
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
