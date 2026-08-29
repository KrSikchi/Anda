// Anda — Account (PRD §27–§30).
//
// One screen doing identity, authentication state, the room's financial
// position, settlement, and the two lightweight room actions (show the code,
// leave the room). There is deliberately no Finance tab and no separate
// Profile/Settings destination (PRD §6).
//
// Money never reaches this file as arithmetic: `finance.ts` shapes the ledger
// rows into the view, and `formatMinor` renders them (PRD §45).

import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useSession } from '../session/SessionProvider';
import { useAndaStore } from '../lib/anda/react';
import { Icon } from '../components/Icon';
import { Avatar, SyncBadge, Banner, Button, Card, Loading } from '../components/ui';
import { SwipeRow } from '../components/SwipeRow';
import {
  buildAccountView,
  formatMinor,
  settlementCounterparty,
} from '../lib/anda/finance';

export function Account() {
  const { store, identity, auth, backend, leaveRoom } = useSession();
  const s = useAndaStore(store);
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [settling, setSettling] = useState(false);

  if (!identity) return <Navigate to="/" replace />;
  if (!s || !s.view) return <div className="screen"><Loading label="Loading account…" /></div>;

  const view = s.view;
  const account = buildAccountView(view.members, s.currentMemberId);
  const counterparty = settlementCounterparty(view.members, s.currentMemberId);
  const you = account.members.find((m) => m.isCurrentMember);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(identity.shareCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const settle = async () => {
    if (!you || !counterparty) return;
    setSettling(true);
    try {
      await s.recordSettlement(counterparty.member_id, you.outstandingMinor);
    } catch {
      // The store surfaces the reason in lastError; nothing else to do here.
    } finally {
      setSettling(false);
    }
  };

  return (
    <div className="screen screen--room">
      <header className="topbar">
        <h1 className="topbar__title">Account</h1>
        <SyncBadge status={s.status} />
      </header>

      {s.lastError ? (
        <div style={{ marginBottom: 12 }}>
          <Banner tone="error" icon="error" onDismiss={() => s.clearError()}>
            {s.lastError}
          </Banner>
        </div>
      ) : null}

      {/* Identity + authentication state (PRD §28) */}
      <Card>
        <div className="row">
          <Avatar name={identity.displayName} size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="h3" style={{ fontSize: 18 }}>{identity.displayName}</div>
            <div className="muted" style={{ marginTop: 2 }}>
              {auth.kind === 'permanent' && auth.email
                ? auth.email
                : 'Not signed in'}
            </div>
          </div>
        </div>

        {auth.kind === 'permanent' ? (
          <div className="row" style={{ marginTop: 12, gap: 8 }}>
            <span className="badge badge--settled">
              <Icon name="lock" size={13} /> Saved
            </span>
            <button
              type="button"
              className="btn btn--link"
              style={{ marginLeft: 'auto' }}
              onClick={async () => {
                await backend.auth.signOut();
                navigate('/');
              }}
            >
              Sign out
            </button>
          </div>
        ) : (
          <div className="stack" style={{ marginTop: 12 }}>
            <p className="muted">
              Signing in keeps your room and history if you lose this device or get a new
              phone. Anda works without it.
            </p>
            <Button
              variant="ghost"
              icon="lock"
              onClick={() => navigate(`/sign-in?next=/room/${identity.roomId}/account`)}
            >
              Sign in
            </Button>
          </div>
        )}
      </Card>

      {/* Room code — the only sharing mechanism (PRD §13, §14) */}
      <Card>
        <span className="label">Room code</span>
        <div className="sharecode" style={{ marginTop: 6 }}>
          <span className="sharecode__value">{identity.shareCode}</span>
          <Button variant="ghost" icon={copied ? 'check' : 'content_copy'} onClick={copyCode} fullWidth={false}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          Share this code for flatmates to join {view.roomName}.
        </p>
      </Card>

      {/* Financial state */}
      <Card tone="tint">
        <span className="label">Overall Balance</span>
        <div
          className="money"
          style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 4 }}
        >
          {formatMinor(account.overallMinor, { sign: true })}
        </div>
        <p className="muted" style={{ marginTop: 4 }}>
          {account.overallMinor === 0
            ? 'Nothing owed right now.'
            : 'Outstanding across the room.'}
        </p>
      </Card>

      <div style={{ marginTop: 20, marginBottom: 8 }}>
        <span className="label">Current Balances</span>
      </div>

      {!account.hasAnyBalance ? (
        <Card>
          <p className="muted center">
            No balances yet — they appear once someone eats eggs that someone else bought.
          </p>
        </Card>
      ) : (
        <div className="stack">
          {account.members.map((member) => {
            const canSettle =
              member.isCurrentMember && member.outstandingMinor > 0 && counterparty !== null;

            const row = (
              <>
                <Avatar name={member.displayName} size="sm" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {member.displayName}
                    {member.isCurrentMember ? ' (you)' : ''}
                    {member.isHost ? (
                      <span className="badge badge--even" style={{ marginLeft: 6 }}>Host</span>
                    ) : null}
                  </div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {member.consumed} egg{member.consumed === 1 ? '' : 's'} eaten
                    {!member.isActive ? ' · left the room' : ''}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="money" style={{ fontWeight: 700 }}>
                    {formatMinor(member.outstandingMinor)}
                  </div>
                  {member.state === 'settled' ? (
                    <span className="badge badge--settled">
                      <Icon name="done_all" size={12} /> Settled
                    </span>
                  ) : member.state === 'even' ? (
                    <span className="badge badge--even">Even</span>
                  ) : null}
                </div>
              </>
            );

            return canSettle ? (
              <SwipeRow
                key={member.memberId}
                actionLabel={settling ? 'Settling…' : 'Settle'}
                onAction={settle}
                disabled={settling}
              >
                {row}
              </SwipeRow>
            ) : (
              <Card key={member.memberId}>
                <div className="row">{row}</div>
              </Card>
            );
          })}
        </div>
      )}

      {you && you.outstandingMinor > 0 && counterparty ? (
        <p className="muted center" style={{ marginTop: 12 }}>
          Swipe your row to record a settlement with {counterparty.display_name}. Anda only
          records it — no money moves through the app.
        </p>
      ) : null}

      {/* Lightweight room actions live here, not in a Room tab (PRD §6) */}
      <div className="divider" />
      {!confirmLeave ? (
        <Button
          variant="danger"
          icon="logout"
          onClick={() => setConfirmLeave(true)}
        >
          Leave room
        </Button>
      ) : (
        <Card tone="warn">
          <p style={{ marginBottom: 12 }}>
            You keep your history, but you won't be able to record eggs in {view.roomName}{' '}
            unless you rejoin with the code.
          </p>
          <div className="stack">
            <Button
              variant="danger"
              onClick={async () => {
                await leaveRoom();
                navigate('/');
              }}
            >
              Yes, leave
            </Button>
            <Button variant="quiet" onClick={() => setConfirmLeave(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
