// Anda — presentational primitives shared by every screen (PRD §49).
// No business rules live here: these render state, they never compute it.

import type { ReactNode } from 'react';
import { Icon } from './Icon';
import type { SyncStatus } from '../lib/anda/types';
import { initials } from '../lib/anda/finance';

/* ------------------------------------------------------------------ button */

export function Button({
  children,
  onClick,
  variant = 'primary',
  type = 'button',
  disabled = false,
  busy = false,
  icon,
  fullWidth = true,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'quiet' | 'danger' | 'link';
  type?: 'button' | 'submit';
  disabled?: boolean;
  busy?: boolean;
  icon?: string;
  fullWidth?: boolean;
}) {
  return (
    <button
      type={type}
      className={`btn btn--${variant}`}
      style={fullWidth ? undefined : { width: 'auto' }}
      onClick={onClick}
      disabled={disabled || busy}
    >
      {busy ? <span className="spinner" /> : icon ? <Icon name={icon} size={20} /> : null}
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------- card */

export function Card({
  children,
  tone = 'plain',
  className = '',
}: {
  children: ReactNode;
  tone?: 'plain' | 'tint' | 'warn';
  className?: string;
}) {
  const toneClass = tone === 'tint' ? ' card--tint' : tone === 'warn' ? ' card--warn' : '';
  return <div className={`card${toneClass} ${className}`}>{children}</div>;
}

/* ------------------------------------------------------------------ inputs */

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  inputMode,
  maxLength,
  autoFocus,
  disabled,
  className = '',
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  type?: string;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'email';
  maxLength?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <input
      className={`input ${className}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      type={type}
      inputMode={inputMode}
      maxLength={maxLength}
      autoFocus={autoFocus}
      disabled={disabled}
      aria-label={ariaLabel}
    />
  );
}

/* ------------------------------------------------------------------ avatar */

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const cls = size === 'lg' ? ' avatar--lg' : size === 'sm' ? ' avatar--sm' : '';
  return (
    <span className={`avatar${cls}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/* ------------------------------------------------------------------- state */

export function SyncBadge({ status }: { status: SyncStatus }) {
  const copy =
    status === 'synced' ? 'Synced' : status === 'syncing' ? 'Syncing' : 'Offline';
  return (
    <span className={`badge badge--${status}`}>
      <Icon name={status === 'offline' ? 'cloud_off' : status === 'syncing' ? 'sync' : 'cloud_done'} size={14} />
      {copy}
    </span>
  );
}

export function Banner({
  tone,
  children,
  onDismiss,
  icon,
}: {
  tone: 'error' | 'warn' | 'info';
  children: ReactNode;
  onDismiss?: () => void;
  icon?: string;
}) {
  return (
    <div className={`banner banner--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {icon ? <Icon name={icon} size={18} /> : null}
      <span style={{ flex: 1 }}>{children}</span>
      {onDismiss ? (
        <button className="banner__close" onClick={onDismiss} aria-label="Dismiss">
          <Icon name="close" size={18} />
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  icon = 'egg_alt',
  title,
  body,
}: {
  icon?: string;
  title: string;
  body?: string;
}) {
  return (
    <div className="empty">
      <Icon name={icon} size={40} />
      <p style={{ fontWeight: 600, color: 'var(--text)' }}>{title}</p>
      {body ? <p style={{ marginTop: 4 }}>{body}</p> : null}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="empty" role="status">
      <span className="spinner" style={{ width: 24, height: 24 }} />
      <p style={{ marginTop: 12 }}>{label}</p>
    </div>
  );
}
