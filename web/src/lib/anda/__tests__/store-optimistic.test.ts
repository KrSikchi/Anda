// Anda — optimistic UI reconciliation tests (PRD §19, §32).
//
// The failure mode these guard against: a rejected mutation must roll back
// ONLY itself. An earlier implementation cleared the entire overlay on any
// rejection, so an unrelated operation submitted moments earlier disappeared
// from the screen while it was still in flight on the server.

import { describe, expect, it } from 'vitest';
import { AndaStore } from '../store';
import type {
  AndaApi,
  HistoryEntry,
  LedgerMemberRow,
  RealtimeHandlers,
  RealtimeTransport,
} from '../types';

const ROOM = 'room-a';
const ME = 'member-me';

interface Gate {
  promise: Promise<void>;
  release: (mode: 'ok' | 'reject') => void;
}

function gate(): Gate {
  let release!: (mode: 'ok' | 'reject') => void;
  const promise = new Promise<void>((resolve, reject) => {
    release = (mode) => (mode === 'ok' ? resolve() : reject(new Error('Anda: not enough eggs remaining')));
  });
  return { promise, release };
}

class GatedApi implements AndaApi {
  inventory = 20;
  usageGate: Gate | null = null;
  purchaseGate: Gate | null = null;
  readonly usageCalls: number[] = [];
  readonly purchaseCalls: Array<{ quantity: number; unitPriceMinor: number }> = [];

  async fetchLedger(): Promise<LedgerMemberRow[]> {
    return [
      {
        room_id: ROOM,
        room_name: 'Flat',
        inventory: this.inventory,
        low_stock_threshold: 10,
        low_stock_notified: false,
        member_id: ME,
        display_name: 'Me',
        is_active: true,
        is_host: true,
        consumed: 0,
        purchased_minor: 0,
        liability_minor: 0,
        settled_minor: 0,
        outstanding_minor: 0,
      },
    ];
  }

  async fetchHistory(): Promise<HistoryEntry[]> {
    return [];
  }

  async recordUsage(_roomId: string, quantity: number): Promise<void> {
    this.usageCalls.push(quantity);
    // Server-side rule the real RPC enforces (PRD §24): never below zero.
    if (quantity > this.inventory) {
      throw new Error('Anda: not enough eggs remaining');
    }
    // A gate only delays the answer; the effect still lands on success.
    if (this.usageGate) await this.usageGate.promise;
    this.inventory -= quantity;
  }

  async recordPurchase(
    _roomId: string,
    quantity: number,
    unitPriceMinor: number,
  ): Promise<void> {
    this.purchaseCalls.push({ quantity, unitPriceMinor });
    if (this.purchaseGate) await this.purchaseGate.promise;
    this.inventory += quantity;
  }
}

class ConnectedTransport implements RealtimeTransport {
  subscribe(_roomId: string, handlers: RealtimeHandlers): () => void {
    handlers.onConnection(true);
    return () => {};
  }
}

function makeStore(api = new GatedApi()) {
  const store = new AndaStore({
    api,
    transport: new ConnectedTransport(),
    roomId: ROOM,
    currentMemberId: ME,
  });
  return { store, api };
}

describe('optimistic reconciliation (§32)', () => {
  it('shows the optimistic change immediately, before the server answers', async () => {
    const { store, api } = makeStore();
    await store.init();

    api.usageGate = gate();
    const inflight = store.recordUsage(3);

    // Server has not answered yet; the UI has already moved (§32).
    expect(store.pending).toHaveLength(1);
    expect(store.view?.inventory).toBe(17);

    api.usageGate.release('ok');
    await inflight;

    expect(store.pending).toHaveLength(0);
    expect(store.view?.inventory).toBe(17);
  });

  it('rolls back only the rejected operation, not an unrelated one in flight', async () => {
    const { store, api } = makeStore();
    await store.init();

    api.usageGate = gate();
    api.purchaseGate = gate();

    const usage = store.recordUsage(2).catch(() => 'rejected');
    const purchase = store.recordPurchase(6, 600);

    // Both operations are visible as optimistic overlays.
    expect(store.pending).toHaveLength(2);

    // The server rejects the usage…
    api.usageGate.release('reject');
    expect(await usage).toBe('rejected');

    // …and the purchase overlay SURVIVES. This is the regression: the whole
    // overlay used to be wiped here, hiding an operation still in flight.
    expect(store.pending).toHaveLength(1);
    expect(store.pending[0].kind).toBe('purchase');

    api.purchaseGate.release('ok');
    await purchase;

    expect(store.pending).toHaveLength(0);
    expect(store.view?.inventory).toBe(26);
  });

  it('surfaces a rejection reason and leaves state authoritative', async () => {
    const { store, api } = makeStore();
    await store.init();
    api.inventory = 1;

    await expect(store.recordUsage(5)).rejects.toThrow();

    expect(store.lastError).toContain('not enough eggs remaining');
    expect(store.pending).toHaveLength(0);
    expect(store.view?.inventory).toBe(1);
    expect(store.status).toBe('synced');
  });

  it('sends the unit price, never a total (§21)', async () => {
    const { store, api } = makeStore();
    await store.init();

    await store.recordPurchase(12, 600);

    expect(api.purchaseCalls).toEqual([{ quantity: 12, unitPriceMinor: 600 }]);
  });
});
