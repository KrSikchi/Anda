// Anda — components shared across screens (inline-styled, mobile-first).

import { theme } from './lib/anda/theme';

/* ── design system ─────────────────────────────────────────────────────── */

export const s = {
  root: {
    maxWidth: 480, margin: '0 auto',
    padding: '24px 16px 96px',
    fontFamily: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    color: theme.text, background: theme.bg, minHeight: '100dvh',
  } as React.CSSProperties,

  card: {
    background: theme.surfaceWhite,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radius,
    padding: 16,
    marginBottom: 12,
  } as React.CSSProperties,

  cardLow: {
    background: theme.surfaceWhite,
    border: `1px solid ${theme.accent}`,
    borderRadius: theme.radius,
    padding: 16,
    marginBottom: 12,
  } as React.CSSProperties,

  input: {
    width: '100%', padding: '12px 14px',
    border: `1px solid ${theme.border}`,
    borderRadius: 10, fontSize: 16,
    outline: 'none', boxSizing: 'border-box',
    background: theme.bg, color: theme.text,
    marginBottom: 12,
  } as React.CSSProperties,

  btn: {
    width: '100%', padding: '14px', border: 'none', borderRadius: 10,
    fontSize: 16, fontWeight: 600, cursor: 'pointer',
    color: '#fff', background: theme.accent,
  } as React.CSSProperties,

  btnOutline: {
    width: '100%', padding: '13px', border: `1px solid ${theme.accent}`,
    borderRadius: 10, fontSize: 16, fontWeight: 500, cursor: 'pointer',
    color: theme.accent, background: 'transparent',
  } as React.CSSProperties,

  btnDanger: {
    width: '100%', padding: '13px', border: 'none', borderRadius: 10,
    fontSize: 16, fontWeight: 500, cursor: 'pointer',
    color: '#fff', background: theme.danger,
  } as React.CSSProperties,

  label: {
    display: 'block', fontSize: 14, fontWeight: 600,
    marginBottom: 6, color: theme.text,
  } as React.CSSProperties,

  muted: { fontSize: 13, color: theme.muted, margin: '4px 0' } as React.CSSProperties,

  row: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 0', borderBottom: `1px solid ${theme.border}`,
  } as React.CSSProperties,

  badge: {
    display: 'inline-block', padding: '2px 10px', borderRadius: 20,
    fontSize: 12, fontWeight: 600,
  } as React.CSSProperties,

  navBar: {
    position: 'fixed', bottom: 0, left: 0, right: 0,
    maxWidth: 480, margin: '0 auto',
    display: 'flex', borderTop: `1px solid ${theme.border}`,
    background: '#fff', zIndex: 10,
  } as React.CSSProperties,

  navItem: (active: boolean): React.CSSProperties => ({
    flex: 1, textAlign: 'center', padding: '10px 0', cursor: 'pointer',
    fontSize: 12, fontWeight: active ? 700 : 500,
    color: active ? theme.accent : theme.muted,
    borderTop: active ? `2px solid ${theme.accent}` : '2px solid transparent',
  }),
  egg: { fontSize: 20 } as React.CSSProperties,
};

/* ── reusable components ───────────────────────────────────────────────── */

export function SyncBadge({ status }: { status: string }) {
  const color = status === 'synced' ? theme.success : status === 'syncing' ? theme.accent : theme.danger;
  const bg = status === 'synced' ? theme.successBg : status === 'syncing' ? theme.accentBg : theme.dangerBg;
  const label = status === 'synced' ? 'Synced' : status === 'syncing' ? 'Syncing…' : 'Offline';
  return <span style={{ ...s.badge, background: bg, color }}>{label}</span>;
}

export function ErrorBanner({ error, onDismiss }: { error: string | null; onDismiss?: () => void }) {
  if (!error) return null;
  return (
    <div style={{ background: theme.dangerBg, border: `1px solid ${theme.danger}`, borderRadius: 10, padding: '10px 14px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ flex: 1, fontSize: 14, color: theme.danger }}>{error}</span>
      {onDismiss && <button onClick={onDismiss} style={{ border: 'none', background: 'none', color: theme.danger, cursor: 'pointer', fontSize: 16, fontWeight: 700 }}>×</button>}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div style={{ textAlign: 'center', padding: 60, color: theme.muted }}>{label}</div>;
}

export function Header({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 16 }}>
      {onBack && <button onClick={onBack} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 22, color: theme.text, padding: 0 }}>‹</button>}
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, flex: 1 }}>{title}</h1>
    </div>
  );
}