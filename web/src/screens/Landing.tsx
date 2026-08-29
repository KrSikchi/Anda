// Anda — Landing (PRD §10, §11).
//
// The entry point, not the in-room Home. Three things: create a room, join a
// room, sign in — with sign in deliberately secondary. No marketing copy, no
// onboarding carousel, and authentication is never a gate (PRD §10, §16).

import { Navigate, useNavigate } from 'react-router-dom';
import { useSession } from '../session/SessionProvider';
import { Button, Card, Loading, Avatar } from '../components/ui';
import { Icon } from '../components/Icon';

export function Landing() {
  const { identity, booting, recovered, enterRecovered, backend, auth } = useSession();
  const navigate = useNavigate();

  if (booting) {
    return (
      <div className="screen">
        <Loading label="Opening Anda…" />
      </div>
    );
  }

  // A valid local session goes straight back into its room (PRD §11).
  if (identity) return <Navigate to={`/room/${identity.roomId}`} replace />;

  return (
    <div className="landing">
      <div className="landing__mark">🥚</div>
      <h1 className="landing__title">Anda</h1>
      <p className="landing__tagline">Eggs, sorted.</p>

      <div className="landing__actions">
        <Button onClick={() => navigate('/create-room')}>Create a room</Button>
        <Button variant="ghost" onClick={() => navigate('/join-room')}>
          Join a room
        </Button>
      </div>

      {recovered.length > 0 ? (
        <div style={{ marginTop: 28, textAlign: 'left' }}>
          <Card>
            <span className="label">Your rooms</span>
            <div className="stack" style={{ marginTop: 10 }}>
              {recovered.map((room) => (
                <button
                  key={room.room_id}
                  type="button"
                  className="row"
                  onClick={async () => {
                    await enterRecovered(room);
                    navigate(`/room/${room.room_id}`);
                  }}
                  style={{
                    width: '100%',
                    border: 'none',
                    background: 'var(--surface-sunken)',
                    borderRadius: 'var(--r-md)',
                    padding: 12,
                    cursor: 'pointer',
                  }}
                >
                  <Avatar name={room.display_name} size="sm" />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 600 }}>{room.room_name}</span>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {room.member_count} member{room.member_count === 1 ? '' : 's'} · joined as{' '}
                      {room.display_name}
                    </span>
                  </span>
                  <Icon name="arrow_forward" size={20} />
                </button>
              ))}
            </div>
          </Card>
        </div>
      ) : null}

      <p className="landing__signin">
        Already have an account?{' '}
        <button
          type="button"
          className="btn btn--link"
          onClick={() => navigate('/sign-in')}
        >
          Sign in
        </button>
      </p>

      {backend.kind === 'demo' ? (
        <p className="muted" style={{ marginTop: 24, fontSize: 13 }}>
          Running without Supabase configured — this session is stored in memory only.
          {auth.kind === 'permanent' ? ' Sign in is simulated.' : ''}
        </p>
      ) : null}
    </div>
  );
}
