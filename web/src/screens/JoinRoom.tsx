// Anda — Join room (PRD §14).
//
// Room code + display name. The code is validated server-side only: the client
// never decides whether a room exists, and a malformed code gets the same
// answer as an unknown one so the endpoint cannot be used for probing.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../session/SessionProvider';
import { Button, Field, TextInput, Banner } from '../components/ui';
import { Icon } from '../components/Icon';

export function JoinRoom() {
  const { backend, enterRoom } = useSession();
  const navigate = useNavigate();

  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = code.trim().length === 6 && displayName.trim().length > 0;

  const submit = async () => {
    if (!ready || !backend.api.joinRoom) return;
    setBusy(true);
    setError(null);
    try {
      await backend.auth.ensureSession();
      const membership = await backend.api.joinRoom(code.trim().toUpperCase(), displayName);
      await enterRoom(membership);
      navigate(`/room/${membership.room_id}`);
    } catch (err) {
      setError(friendly(err));
      setBusy(false);
    }
  };

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
        Join a room
      </h1>
      <p className="muted" style={{ marginBottom: 24 }}>
        Enter the 6-digit code shared by the room owner to collaborate.
      </p>

      <div className="stack">
        <Field label="Room code">
          <TextInput
            className="input--code"
            value={code}
            onChange={(next) => setCode(next.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            placeholder="A7B2X9"
            maxLength={6}
            autoFocus
            ariaLabel="Room code"
          />
        </Field>

        <Field label="Your name">
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

        <Button onClick={submit} busy={busy} disabled={!ready} icon="arrow_forward">
          Join Room
        </Button>
      </div>

      <p className="muted center" style={{ marginTop: 20, fontSize: 13 }}>
        No account needed to join.
      </p>
    </div>
  );
}

function friendly(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('room not found')) {
    return 'That code does not match an active room. Check it and try again.';
  }
  if (message.includes('display name required')) return 'Add your display name.';
  if (message.includes('not signed in')) return 'Connection lost. Try again in a moment.';
  if (message.includes('Failed to fetch') || message.includes('network')) {
    return 'No connection. Check your internet and try again.';
  }
  return message || 'Could not join that room. Try again.';
}
