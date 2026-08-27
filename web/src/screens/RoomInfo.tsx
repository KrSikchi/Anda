// Anda — Room info / members / leave (PRD §23: view members, leave, room code).

import { useState } from 'react';
import { useAndaStore } from '../lib/anda/react';
import type { AndaStore } from '../lib/anda/store';
import { theme } from '../lib/anda/theme';
import { s, SyncBadge } from '../ui';

interface Props {
  store: AndaStore;
  shareCode: string | null;
  onLeave: () => Promise<void>;
  onNavigate: (v: string) => void;
}

export function RoomInfo({ store, shareCode, onLeave, onNavigate }: Props) {
  useAndaStore(store);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const view = store.view;

  const handleLeave = async () => {
    await onLeave();
  };

  return (
    <div style={s.root}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 16 }}>
        <button onClick={() => onNavigate('dashboard')} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 22, color: theme.text, padding: 0 }}>‹</button>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, flex: 1 }}>Room</h1>
        <SyncBadge status={store.status} />
      </div>

      <div style={s.card}>
        <h3 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600 }}>Room code</h3>
        <p style={{ fontSize: 22, fontWeight: 800, letterSpacing: 3, color: theme.accent, margin: 0 }}>
          {shareCode ?? '------'}
        </p>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: theme.muted }}>Share this code for others to join</p>
      </div>

      <div style={s.card}>
        <h3 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600 }}>Members</h3>
        {view && view.members.map((m) => (
          <div key={m.member_id} style={{ ...s.row, border: 'none', padding: '8px 0' }}>
            <div>
              <span>{m.display_name}</span>
              {m.member_id === store.currentMemberId && (
                <span style={{ marginLeft: 6, fontSize: 12, color: theme.accent }}>(you)</span>
              )}
              {!m.is_active && (
                <span style={{ marginLeft: 6, fontSize: 12, color: theme.muted }}>(left)</span>
              )}
            </div>
            <div style={{ fontSize: 13, color: theme.muted }}>{m.consumed} eggs</div>
          </div>
        ))}
        {!view && <p style={{ color: theme.muted }}>No member data.</p>}
      </div>

      {!confirmLeave ? (
        <button onClick={() => setConfirmLeave(true)} style={{ ...s.btnDanger, marginTop: 8 }}>Leave room</button>
      ) : (
        <div>
          <p style={{ fontSize: 14, color: theme.danger, marginBottom: 8 }}>
            You won't lose your history, but you won't be able to record usage. Are you sure?
          </p>
          <button onClick={handleLeave} style={{ ...s.btnDanger, marginBottom: 8 }}>Yes, leave</button>
          <button onClick={() => setConfirmLeave(false)} style={{ ...s.btnOutline }}>Cancel</button>
        </div>
      )}
    </div>
  );
}
