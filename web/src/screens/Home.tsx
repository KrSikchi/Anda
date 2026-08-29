// Anda — Home (PRD §18).
//
// Priorities, in order: room name, current egg count, Eat, Buy.
// Financial information is deliberately absent — the PRD is explicit that
// money is an Account concern, not a Home concern, even though the app tracks
// it. This screen is what a flatmate sees when they open Anda to record eggs.

import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useSession } from '../session/SessionProvider';
import { useAndaStore } from '../lib/anda/react';
import { Icon } from '../components/Icon';
import { SyncBadge, Banner, Loading, EmptyState } from '../components/ui';
import { EatSheet } from '../components/EatSheet';
import { BuySheet } from '../components/BuySheet';

export function Home() {
  const { store, identity } = useSession();
  const s = useAndaStore(store);
  const [sheet, setSheet] = useState<'eat' | 'buy' | null>(null);

  if (!identity) return <Navigate to="/" replace />;

  // Offline with nothing cached is a real state, not a loading screen that
  // never resolves (PRD §41).
  if (s && !s.view && s.status === 'offline') {
    return (
      <div className="screen screen--room">
        <header className="topbar">
          <span className="brand-dot" />
          <span className="topbar__title">{identity.roomName}</span>
          <SyncBadge status="offline" />
        </header>
        <EmptyState
          icon="cloud_off"
          title="No saved data on this device"
          body="Connect once and Anda will cache this room for next time."
        />
      </div>
    );
  }

  if (!s || !s.view) {
    return (
      <div className="screen">
        <Loading label="Opening your room…" />
      </div>
    );
  }

  const view = s.view;
  const low = view.inventory <= view.lowStockThreshold;
  const queued = s.pending.length;

  return (
    <div className="screen screen--room">
      <header className="topbar">
        <span className="brand-dot" />
        <span className="topbar__title">{view.roomName}</span>
        <SyncBadge status={s.status} />
      </header>

      {s.lastError ? (
        <div style={{ marginBottom: 12 }}>
          <Banner tone="error" icon="error" onDismiss={() => s.clearError()}>
            {s.lastError}
          </Banner>
        </div>
      ) : null}

      {s.rejected.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <Banner tone="warn" icon="sync_problem" onDismiss={() => s.dismissRejected()}>
            {s.rejected.length} saved change{s.rejected.length === 1 ? '' : 's'} could not be
            applied: {s.rejected[s.rejected.length - 1].error}
          </Banner>
        </div>
      ) : null}

      <div className="card">
        <div className={`inventory${low ? ' inventory--low' : ''}`}>
          <div className="inventory__count">{view.inventory}</div>
          <div className="inventory__label">Eggs Remaining</div>
        </div>
      </div>

      {low ? (
        <div style={{ marginTop: 12 }}>
          <Banner tone="warn" icon="warning">
            Running low — {view.inventory} left. You'll be told once it drops to{' '}
            {view.lowStockThreshold}.
          </Banner>
        </div>
      ) : null}

      <div className="tiles">
        <button
          type="button"
          className="tile tile--primary"
          onClick={() => setSheet('eat')}
          disabled={view.inventory === 0}
          style={view.inventory === 0 ? { opacity: 0.5 } : undefined}
        >
          <Icon name="restaurant" size={28} />
          Eat
        </button>
        <button type="button" className="tile" onClick={() => setSheet('buy')}>
          <Icon name="shopping_basket" size={28} />
          Buy
        </button>
      </div>

      {queued > 0 ? (
        <p className="muted center" style={{ marginTop: 16 }}>
          {queued} change{queued === 1 ? '' : 's'} saved on this device — waiting to sync
        </p>
      ) : null}

      {sheet === 'eat' ? <EatSheet onClose={() => setSheet(null)} /> : null}
      {sheet === 'buy' ? <BuySheet onClose={() => setSheet(null)} /> : null}
    </div>
  );
}
