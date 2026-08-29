// Anda — optional sign in (PRD §16, §17, §28, §44).
//
// Authentication is an upgrade to an identity that already exists, not a
// gate in front of the product. Two situations reach this screen and they are
// genuinely different, so the copy adapts:
//
//   anonymous session on this device → "Keep your account". Calling
//     updateUser() converts that same auth user into a permanent one, so the
//     member, the room, the history and the balances all survive untouched
//     (PRD §44: same member, same history — never a duplicate person).
//
//   no local session (new or cleared device) → "Sign in". There is nothing
//     here to upgrade, so the rooms are recovered from the server afterwards
//     via my_memberships() (migration 0007).

import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useSession } from '../session/SessionProvider';
import { Button, Field, TextInput, Banner, Card, Avatar } from '../components/ui';
import { Icon } from '../components/Icon';

export function SignIn() {
  const { backend, auth, refreshAuth } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isUpgrade = auth.kind === 'anonymous';
  const ready = email.trim().length > 3 && password.length >= 6;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      if (isUpgrade) await backend.auth.upgrade(email.trim(), password);
      else await backend.auth.signIn(email.trim(), password);
      await refreshAuth();
      navigate(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen screen--narrow">
      <button
        type="button"
        className="topbar__action"
        onClick={() => navigate(next)}
        aria-label="Back"
        style={{ marginLeft: -8 }}
      >
        <Icon name="arrow_back" size={22} />
      </button>

      <h1 className="h2" style={{ marginBottom: 4 }}>
        {isUpgrade ? 'Keep your account' : 'Sign in'}
      </h1>
      <p className="muted" style={{ marginBottom: 24 }}>
        {isUpgrade
          ? 'Add an email and password so your room and history survive a new phone or a cleared browser.'
          : 'Sign in to get your rooms back on this device.'}
      </p>

      <div className="stack">
        <Field label="Email">
          <TextInput
            value={email}
            onChange={setEmail}
            type="email"
            inputMode="email"
            placeholder="you@example.com"
            autoFocus
          />
        </Field>

        <Field
          label="Password"
          hint={isUpgrade ? undefined : 'At least 6 characters.'}
        >
          <TextInput
            value={password}
            onChange={setPassword}
            type="password"
            placeholder="••••••••"
          />
        </Field>

        {error ? (
          <Banner tone="error" icon="error">
            {error}
          </Banner>
        ) : null}

        <Button onClick={submit} busy={busy} disabled={!ready}>
          {isUpgrade ? 'Create sign-in' : 'Sign in'}
        </Button>

        <Button variant="quiet" onClick={() => navigate(next)}>
          Not now
        </Button>
      </div>

      <Card>
        <div className="row">
          <Avatar name="?" size="sm" />
          <p className="muted" style={{ fontSize: 13 }}>
            Anda never asks for an email to use a room. Signing in is only there so you
            don't lose your history.
          </p>
        </div>
      </Card>

      {backend.kind === 'demo' ? (
        <p className="muted center" style={{ marginTop: 16, fontSize: 13 }}>
          Demo mode: sign-in is simulated, nothing is sent anywhere.
        </p>
      ) : null}
    </div>
  );
}
