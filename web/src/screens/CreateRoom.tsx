// Anda — Create room (PRD §12, §13).
//
// Two inputs: room name and the creator's display name. No account, no email,
// no verification. The code is generated server-side (PRD §12) and shown once
// the room exists with a copy action and a way in — not a host dashboard.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../session/SessionProvider';
import { Button, Field, TextInput, Banner, Card, Avatar } from '../components/ui';
import { Icon } from '../components/Icon';
import { DEFAULT_LOW_STOCK_THRESHOLD } from '../lib/anda/api';
import type { RoomMembership } from '../lib/anda/types';

export function CreateRoom() {
  const { backend, enterRoom } = useSession();
  const navigate = useNavigate();

  const [roomName, setRoomName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<RoomMembership | null>(null);
  const [copied, setCopied] = useState(false);

  const ready = roomName.trim().length > 0 && displayName.trim().length > 0;

  const submit = async () => {
    if (!ready || !backend.api.createRoom) return;
    setBusy(true);
    setError(null);
    try {
      await backend.auth.ensureSession();
      const membership = await backend.api.createRoom(
        roomName,
        displayName,
        DEFAULT_LOW_STOCK_THRESHOLD,
      );
      setCreated(membership);
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.share_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  if (created) {
    return (
      <div className="screen screen--narrow">
        <h1 className="h2" style={{ marginBottom: 4 }}>
          Room code
        </h1>
        <p className="muted" style={{ marginBottom: 20 }}>
          Share this code with your flatmates to join {created.room_name}.
        </p>

        <Card tone="tint">
          <div className="center">
            <div className="sharecode__value">{created.share_code}</div>
            <p className="muted" style={{ marginTop: 8 }}>
              This is the room's join code
            </p>
          </div>
          <div className="stack" style={{ marginTop: 16 }}>
            <Button variant="ghost" icon={copied ? 'check' : 'content_copy'} onClick={copy}>
              {copied ? 'Copied' : 'Copy code'}
            </Button>
          </div>
        </Card>

        <div style={{ marginTop: 16 }}>
          <Button
            icon="arrow_forward"
            busy={busy}
            onClick={async () => {
              await enterRoom(created, { isHost: true });
              navigate(`/room/${created.room_id}`);
            }}
          >
            Go to {created.room_name}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen screen--narrow">
      <button
        type="button"
        className="topbar__action"
        onClick={() => navigate('/')}
        aria-label="Back"
        style={{ marginLeft: -8 }}
      >
        <Icon name="arrow_back" size={22} />
      </button>

      <h1 className="h2" style={{ marginBottom: 4 }}>
        Create a room
      </h1>
      <p className="muted" style={{ marginBottom: 24 }}>
        A room is your flat's shared egg count.
      </p>

      <div className="stack">
        <Field label="Room name">
          <TextInput
            value={roomName}
            onChange={setRoomName}
            placeholder="Flat 42"
            maxLength={40}
            autoFocus
          />
        </Field>

        <Field label="Your display name" hint="This is how flatmates see you in Activity.">
          <TextInput
            value={displayName}
            onChange={setDisplayName}
            placeholder="Your name"
            maxLength={40}
          />
        </Field>

        {error ? (
          <Banner tone="error" icon="error">
            {error}
          </Banner>
        ) : null}

        <Button onClick={submit} busy={busy} disabled={!ready}>
          Create room
        </Button>
      </div>

      <div className="row" style={{ marginTop: 20 }}>
        <Avatar name={displayName || '?'} size="sm" />
        <p className="muted" style={{ fontSize: 13 }}>
          No account needed. You can add a sign-in later if you want to keep your history.
        </p>
      </div>
    </div>
  );
}

function friendly(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('room name required')) return 'Give the room a name.';
  if (message.includes('display name required')) return 'Add your display name.';
  if (message.includes('not signed in')) return 'Connection lost. Try again in a moment.';
  if (message.includes('Failed to fetch') || message.includes('network')) {
    return 'No connection. Check your internet and try again.';
  }
  return message || 'Could not create the room. Try again.';
}
