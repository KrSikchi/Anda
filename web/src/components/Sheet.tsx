// Anda — bottom sheet: the interaction pattern the supplied design uses for
// Eat, Buy and every other focused, single-decision task.

import { useEffect, type ReactNode } from 'react';
import { Icon } from './Icon';

export function Sheet({
  title,
  onClose,
  children,
  closable = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  closable?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closable) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, closable]);

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && closable) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet__handle" />
        {closable ? (
          <button className="sheet__close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={20} />
          </button>
        ) : null}
        <h2 className="sheet__title">{title}</h2>
        {children}
      </div>
    </div>
  );
}
