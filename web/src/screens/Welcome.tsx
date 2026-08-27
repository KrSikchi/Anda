// Anda — Welcome / Start screen (choose Create or Join a room). PRD §23.

import { useState } from 'react';
import { theme } from '../lib/anda/theme';
import { ensureAnonymousSession } from '../lib/anda/client';
import type { AndaApi, RoomMembership } from '../lib/anda/types';

type RoomLifecycleApi = AndaApi & Required<Pick<AndaApi, 'createRoom' | 'joinRoom'>>;

interface Props {
  api: RoomLifecycleApi;
  onEnterRoom: (membership: RoomMembership) => void;
}

export function Welcome({ api, onEnterRoom }: Props) {
  const [mode, setMode] = useState<'pick' | 'create' | 'join'>('pick');

  if (mode === 'create') return <CreateForm api={api} onBack={() => setMode('pick')} onDone={onEnterRoom} />;
  if (mode === 'join') return <JoinForm api={api} onBack={() => setMode('pick')} onDone={onEnterRoom} />;

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '80px 24px', textAlign: 'center', background: theme.bg, minHeight: '100dvh' }}>
      <div style={{ fontSize: 48, marginBottom: 8 }}>🥚</div>
      <h1 style={{ fontSize: 32, fontWeight: 700, margin: '0 0 4px', color: theme.text }}>Anda</h1>
      <p style={{ color: theme.muted, margin: '0 0 40px' }}>The shared egg ledger for your flat.</p>
      <button onClick={() => setMode('create')} style={btn}>Create a room</button>
      <div style={{ height: 12 }} />
      <button onClick={() => setMode('join')} style={btnOutline}>Join a room</button>
    </div>
  );
}

const btn: React.CSSProperties = {
  width: '100%', padding: 16, border: 'none', borderRadius: 12,
  fontSize: 17, fontWeight: 600, cursor: 'pointer',
  color: '#fff', background: theme.accent,
};
const btnOutline: React.CSSProperties = {
  width: '100%', padding: 15, border: `1px solid ${theme.accent}`,
  borderRadius: 12, fontSize: 17, fontWeight: 500, cursor: 'pointer',
  color: theme.accent, background: 'transparent',
};

/* ── Create room ────────────────────────────────────────────────────────── */

function CreateForm({ api, onBack, onDone }: { api: RoomLifecycleApi; onBack: () => void; onDone: (membership: RoomMembership) => void }) {
  const [name, setName] = useState('');
  const [display, setDisplay] = useState('');
  const [membership, setMembership] = useState<RoomMembership | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim() || !display.trim()) return;
    setError(null);
    try {
      await ensureAnonymousSession();
      setMembership(await api.createRoom(name, display));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (membership) {
    return (
      <div style={{ maxWidth: 480, margin: '0 auto', padding: '60px 24px', textAlign: 'center', background: theme.bg, minHeight: '100dvh' }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🥚</div>
        <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>Room created!</h2>
        <p style={{ color: theme.muted, margin: '0 0 24px' }}>Share this code with your flatmates:</p>
        <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: 4, color: theme.accent, background: theme.accentBg, borderRadius: 12, padding: '20px 0', marginBottom: 24 }}>{membership.share_code}</div>
        <button onClick={() => onDone(membership)} style={btn}>Go to your room</button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '40px 24px', background: theme.bg, minHeight: '100dvh' }}>
      <button onClick={onBack} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 22, color: theme.text, padding: 0, marginBottom: 20 }}>‹ Back</button>
      <h2 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 20px' }}>Create a room</h2>
      <label style={{ display: 'block', fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Room name</label>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Flat 42" style={input} />
      <label style={{ display: 'block', fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Your display name</label>
      <input value={display} onChange={e => setDisplay(e.target.value)} placeholder="e.g. Alice" style={input} />
      {error && <p style={{ color: theme.danger, marginTop: 0 }}>{error}</p>}
      <button onClick={handleCreate} disabled={!name.trim() || !display.trim()} style={{ ...btn, opacity: (!name.trim() || !display.trim()) ? 0.5 : 1 }}>Create</button>
    </div>
  );
}

/* ── Join room ──────────────────────────────────────────────────────────── */

function JoinForm({ api, onBack, onDone }: { api: RoomLifecycleApi; onBack: () => void; onDone: (membership: RoomMembership) => void }) {
  const [code, setCode] = useState('');
  const [display, setDisplay] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleJoin = async () => {
    if (!code.trim() || !display.trim()) return;
    setError(null);
    try {
      await ensureAnonymousSession();
      onDone(await api.joinRoom(code, display));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '40px 24px', background: theme.bg, minHeight: '100dvh' }}>
      <button onClick={onBack} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 22, color: theme.text, padding: 0, marginBottom: 20 }}>‹ Back</button>
      <h2 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 20px' }}>Join a room</h2>
      <label style={{ display: 'block', fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Room code</label>
      <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="e.g. K7P4Q2" style={{ ...input, textTransform: 'uppercase', letterSpacing: 3, fontSize: 20 }} maxLength={6} />
      <label style={{ display: 'block', fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Your display name</label>
      <input value={display} onChange={e => setDisplay(e.target.value)} placeholder="e.g. Alice" style={input} />
      {error && <p style={{ color: theme.danger, marginTop: 0 }}>{error}</p>}
      <button onClick={handleJoin} disabled={!code.trim() || !display.trim()} style={{ ...btn, opacity: (!code.trim() || !display.trim()) ? 0.5 : 1 }}>Join</button>
    </div>
  );
}

const input: React.CSSProperties = {
  width: '100%', padding: '12px 14px',
  border: `1px solid ${theme.border}`, borderRadius: 10, fontSize: 16,
  outline: 'none', boxSizing: 'border-box',
  background: theme.bg, color: theme.text, marginBottom: 12,
};
