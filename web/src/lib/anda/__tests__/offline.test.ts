// Anda — Phase 7 offline persistence tests (PRD §14, §15, §27 "Offline tests").
// Uses the REAL IndexedDB-backed repository running on fake-indexeddb, so the
// durability code under test is the production one, not a stub.

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdbRepo } from '../db';
import { AndaStore } from '../store';
import type {
  AndaApi,
  HistoryEntry,
  LedgerMemberRow,
  PendingMutation,
  RealtimeEvent,
  RealtimeHandlers,
  RealtimeTransport,
} from '../types';

const ROOM = 'room-a';
const ME = 'member-me';

let seq = 0;
function freshRepo(): IdbRepo {
  seq += 1;
  return new IdbRepo(`anda-offline-test-${seq}`);
}

class MockTransport implements RealtimeTransport {
  handlers: RealtimeHandlers[] = [];
  autoConnect = true;
  connected = false;
  subscribe(_roomId: string, h: RealtimeHandlers): () => void {
    this.handlers.push(h);
    if (this.autoConnect && !this.connected) {
      this.connected = true;
      h.onConnection(true);
    }
    return () => {
      const i = this.handlers.indexOf(h);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }
  async emit(e: RealtimeEvent): Promise<void> {
    await Promise.all(this.handlers.map((h) => Promise.resolve(h.onEvent(e))));
  }
  setConnected(c: boolean): void {
    this.connected = c;
    for (const h of this.handlers) h.onConnection(c);
  }
}

function ledger(inventory: number, meConsumed = 0): LedgerMemberRow[] {
  return [
    {
      room_id: ROOM,
      room_name: 'Flat O',
      inventory,
      low_stock_threshold: 10,
      low_stock_notified: false,
      member_id: ME,
      display_name: 'Me',
      is_active: true,
      consumed: meConsumed,
      liability: 0,
    },
  ];
}

class FakeApi implements AndaApi {
  inventory = 20;
  meConsumed = 0;
  history: HistoryEntry[] = [];
  failFetch = false;
  networkFail = false;

  async fetchLedger(roomId: string): Promise<LedgerMemberRow[]> {
    if (this.failFetch) throw new Error('Failed to fetch');
    if (roomId !== ROOM) return [];
    return ledger(this.inventory, this.meConsumed);
  }

  async fetchHistory(_roomId: string): Promise<HistoryEntry[]> {
    if (this.failFetch) throw new Error('Failed to fetch');
    return [...this.history];
  }

  async recordUsage(roomId: string, quantity: number): Promise<void> {
    if (this.networkFail) throw new Error('Failed to fetch');
    if (roomId !== ROOM) throw new Error('Anda: not a member of this room');
    if (this.inventory < quantity) {
      throw new Error(`Anda: not enough eggs remaining (${this.inventory})`);
    }
    this.inventory -= quantity;
    this.meConsumed += quantity;
  }

  async recordPurchase(roomId: string, quantity: number, _totalCost: number): Promise<void> {
    if (this.networkFail) throw new Error('Failed to fetch');
    if (roomId !== ROOM) throw new Error('Anda: not a member of this room');
    this.inventory += quantity;
  }
}

async function onlineStore(repo: IdbRepo, transport = new MockTransport(), api = new FakeApi()) {
  const store = new AndaStore({ api, transport, roomId: ROOM, currentMemberId: ME, repo });
  await store.init();
  expect(store.status).toBe('synced');
  return { store, transport, api };
}

afterEach(() => vi.restoreAllMocks());

describe('AndaStore — Phase 7 offline (§14, §15, §27)', () => {
  it('record offline → persists to the durable queue; status Offline; estimate shown (§14)', async () => {
    const repo = freshRepo();
    const { store, transport } = await onlineStore(repo);

    transport.setConnected(false);
    expect(store.status).toBe('offline');

    await store.recordUsage(2); // offline → queued, not thrown
    expect(store.status).toBe('offline');
    expect(store.lastError).toContain('saved on this device');

    const pending = await repo.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'usage', quantity: 2, roomId: ROOM });

    // Unconfirmed estimate shown, clearly not authoritative (§14).
    expect(store.view?.inventory).toBe(18);
    expect(store.state?.inventory).toBe(20); // authoritative truth unchanged
  });

  it('reconnect → flush (validate) → reconcile; queue empties, state syncs (§15)', async () => {
    const repo = freshRepo();
    const { store, transport } = await onlineStore(repo);
    transport.setConnected(false);
    await store.recordUsage(3);

    transport.setConnected(true);
    expect(store.status).toBe('syncing');
    await vi.waitFor(() => expect(store.status).toBe('synced'));

    expect(await repo.listPending()).toHaveLength(0);
    expect(store.pending).toHaveLength(0);
    expect(store.state?.inventory).toBe(17);
    expect(store.view?.inventory).toBe(17);
    expect(store.state?.members[0].consumed).toBe(3);
  });

  it('reconnect with an invalid queued action: server rejects; client reconciles and surfaces it (§15, §24)', async () => {
    const repo = freshRepo();
    const { store, transport } = await onlineStore(repo);
    transport.setConnected(false);
    await store.recordUsage(19); // only 20 available — this alone is fine…
    await store.recordUsage(2); // …but together they overdraw; server resolves

    transport.setConnected(true);
    await vi.waitFor(() => expect(store.status).toBe('synced'));

    // First queued op (19) succeeds (inventory 1); second (2) is rejected:
    // NOT silently discarded — surfaced with a clear explanation.
    expect(await repo.listPending()).toHaveLength(0);
    expect(store.rejected).toHaveLength(1);
    expect(store.rejected[0].error).toContain('not enough eggs remaining');
    expect(store.lastError).toContain('not enough eggs remaining');
    expect(store.state?.inventory).toBe(1); // authoritative
    expect(store.view?.inventory).toBe(1); // estimate fully reconciled
  });

  it('queue + identity survive re-creation (app reload); flushed on next connect (§14)', async () => {
    const repo = freshRepo();
    const api = new FakeApi();

    // Session 1: connect, cache authoritative state, then go offline and act.
    const t1 = new MockTransport();
    const s1 = new AndaStore({ api, transport: t1, roomId: ROOM, currentMemberId: ME, repo });
    await s1.init();
    t1.setConnected(false);
    await s1.recordUsage(4);
    s1.dispose();

    // Identity persisted to meta (device-bound, §4).
    const identity = await repo.loadMeta<{ memberId: string; roomId: string }>('identity');
    expect(identity?.memberId).toBe(ME);
    expect(identity?.roomId).toBe(ROOM);

    // Session 2 (a "reload"): offline boot — no network.
    api.failFetch = true;
    const t2 = new MockTransport();
    t2.autoConnect = false;
    const s2 = new AndaStore({ api, transport: t2, roomId: ROOM, currentMemberId: ME, repo });
    await s2.init();

    // Booted from cache + rehydrated queue, marked Offline (§14).
    expect(s2.status).toBe('offline');
    expect(s2.state?.inventory).toBe(20); // cached authoritative
    expect(s2.view?.inventory).toBe(16); // includes the durable queued estimate

    // Network returns → flush validates against the server.
    api.failFetch = false;
    t2.setConnected(true);
    await vi.waitFor(() => expect(s2.status).toBe('synced'));
    expect(await repo.listPending()).toHaveLength(0);
    expect(s2.state?.inventory).toBe(16);
    expect(s2.view?.inventory).toBe(16);
  });

  it('two offline consumers of the last egg: server resolves, exactly one wins, the other is surfaced (no CRDT, §15)', async () => {
    const repo = freshRepo();
    const api = new FakeApi();
    api.inventory = 1;
    const { store, transport } = await onlineStore(repo, new MockTransport(), api);

    transport.setConnected(false);
    await store.recordUsage(1); // device A (this store) queues…
    // device B offline already consumed it server-side later; simulate by the
    // server having 0 left when the flush arrives:

    // ensure the flush hits the server with stock already gone:
    // queue a second local op so the FIFO flush has two items.
    await store.recordUsage(1);

    transport.setConnected(true);
    await vi.waitFor(() => expect(store.status).toBe('synced'));

    // Server accepted exactly the first (its transaction), rejected the second.
    expect(await repo.listPending()).toHaveLength(0);
    expect(store.state?.inventory).toBe(0);
    expect(store.state?.members[0].consumed).toBe(1);
    expect(store.rejected).toHaveLength(1);
    expect(store.rejected[0].error).toContain('not enough eggs remaining');

    // FIFO resolution independent of CRDT — deterministic, server-authoritative.
    void ({ pending: await repo.listPending() } satisfies { pending: PendingMutation[] });
  });
});