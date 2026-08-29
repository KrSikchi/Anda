// Anda — Activity (PRD §25, §26).
//
// The historical ledger: actor, action, quantity or value, and when. Grouped
// by day, no prose and no social commentary. Room-scoped by construction —
// the data comes from a room-scoped RPC and is refreshed by room-scoped
// Realtime events (PRD §31).

import { Navigate } from 'react-router-dom';
import { useSession } from '../session/SessionProvider';
import { useAndaStore } from '../lib/anda/react';
import { Icon } from '../components/Icon';
import { SyncBadge, EmptyState, Loading, Banner } from '../components/ui';
import { formatMinor } from '../lib/anda/finance';
import type { HistoryEntry } from '../lib/anda/types';

const ICONS: Record<HistoryEntry['kind'], string> = {
  purchase: 'shopping_basket',
  usage: 'remove_circle',
  correction: 'undo',
  settlement: 'payments',
};


function groupLabel(iso: string): string {
  const today = new Date();
  const date = new Date(iso);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return 'Older';
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Newest first, then grouped into Today / Yesterday / Older. */
function group(entries: HistoryEntry[]): Array<{ label: string; items: HistoryEntry[] }> {
  const buckets: Array<{ label: string; items: HistoryEntry[] }> = [];
  for (const entry of entries) {
    const label = groupLabel(entry.recorded_at);
    const last = buckets[buckets.length - 1];
    if (last && last.label === label) last.items.push(entry);
    else buckets.push({ label, items: [entry] });
  }
  return buckets;
}

function Delta({ entry }: { entry: HistoryEntry }) {
  if (entry.kind === 'settlement') {
    return (
      <span className="entry__delta entry__delta--positive">
        {formatMinor(entry.amount_minor ?? 0)}
      </span>
    );
  }
  const qty = entry.quantity ?? 0;

  // A purchase puts eggs in; eating takes them out; a correction puts back
  // the eggs it undoes (corrections are stored negative — §10).
  if (entry.kind === 'correction') {
    return (
      <span className="entry__delta entry__delta--positive">+{Math.abs(qty)}</span>
    );
  }
  if (entry.kind === 'purchase') {
    return <span className="entry__delta entry__delta--positive">+{qty}</span>;
  }
  return <span className="entry__delta entry__delta--negative">−{qty}</span>;
}

export function Activity() {
  const { store, identity } = useSession();
  const s = useAndaStore(store);

  if (!identity) return <Navigate to="/" replace />;
  if (!s) return <div className="screen"><Loading /></div>;

  const entries = s.history ?? [];
  const buckets = group(entries);

  return (
    <div className="screen screen--room">
      <header className="topbar">
        <h1 className="topbar__title">Activity</h1>
        <SyncBadge status={s.status} />
      </header>

      {s.lastError ? (
        <div style={{ marginBottom: 12 }}>
          <Banner tone="error" icon="error" onDismiss={() => s.clearError()}>
            {s.lastError}
          </Banner>
        </div>
      ) : null}

      {s.history === null ? (
        <Loading label="Loading activity…" />
      ) : entries.length === 0 ? (
        <EmptyState
          icon="receipt_long"
          title="Nothing yet"
          body="Eggs you eat or buy will show up here."
        />
      ) : (
        buckets.map((bucket) => (
          <section key={bucket.label}>
            <h2 className="list__group">{bucket.label}</h2>
            <ul className="list">
              {bucket.items.map((entry) => (
                <li key={entry.entry_id} className="entry">
                  <span className={`entry__icon entry__icon--${entry.kind}`}>
                    <Icon name={ICONS[entry.kind]} size={20} />
                  </span>
                  <div className="entry__body">
                    <div className="entry__title">
                      {entry.member_name}
                      {entry.member_id === s.currentMemberId ? ' (you)' : ''}
                    </div>
                    <div className="entry__meta">
                      {entry.detail} · {timeLabel(entry.recorded_at)}
                    </div>
                  </div>
                  <Delta entry={entry} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
