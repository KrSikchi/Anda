// Anda — Phase 6 realtime tests (PRD §27 "Realtime tests").
// The store is driven with a mock transport + fake RPC API; assertions are
// made on the derived state exactly as they would be with Supabase Realtime
// + PostgREST, since the store contract is transport-agnostic.

import { describe, it, expect, vi } from 'vitest';
import { AndaStore } from '../store';
import type {
  AndaApi,
  HistoryEntry,
  LedgerMemberRow,
  RealtimeEvent,
  RealtimeHandlers,
  RealtimeTransport,
} from '../types';

const ROOM = 'room-a';
const ROOM_B = 'room-b';
const ME = 'member-me';
const OTHER = 'member-other';

function ledgerFixture(
  inventory: number,
  meConsumed: number,
  otherConsumed: number,
): LedgerMemberRow[] {
  return [
    {
      room_id: ROOM,
      room_name: 'Flat A',
      inventory,
      low_stock_threshold: 10,
      low_stock_notified: false,
      member_id: ME,
      display_name: 'Me',
      is_active: true,
      consumed: meConsumed,
      liability: meConsumed * 8,
    },
    {
      room_id: ROOM,
      room_name: 'Flat A',
      inventory,
      low_stock_threshold: 10,
      low_stock_notified: false,
      member_id: OTHER,
      display_name: 'Other',
      is_active: true,
      consumed: otherConsumed,
      liability: otherConsumed * 8,
    },
  ];
}

class MockTransport implements RealtimeTransport {
  readonly handlers: RealtimeHandlers[] = [];
  connected = false;
  autoConnect = true;
  subscribe(_roomId: string, handlers: RealtimeHandlers): () => void {
    this.handlers.push(handlers);
    // Mirrors Supabase Realtime: a successful subscribe reports SUBSCRIBED.
    if (this.autoConnect && !this.connected) {
      this.connected = true;
      handlers.onConnection(true);
    }
    return () => {
      const i = this.handlers.indexOf(handlers);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }
  async emit(event: RealtimeEvent): Promise<void> {
    await Promise.all(this.handlers.map((h) => Promise.resolve(h.onEvent(event))));
  }
  setConnected(connected: boolean): void {
    this.connected = connected;
    for (const h of this.handlers) h.onConnection(connected);
  }
}

class FakeApi implements AndaApi {
  inventory = 20;
  meConsumed = 4;
  otherConsumed = 6;
  fetchLedgerCalls = 0;
  history: HistoryEntry[] = [];
  failNextUsage = false;
  /** when set, a committed usage is announced on this transport (client B) */
  transportB: MockTransport | null = null;
  /** optional gate to observe the optimistic window */
  usageGate: Promise<void> | null = null;
  private releaseUsageGate: (() => void) | null = null;

  setUsageGate(): void {
    this.usageGate = new Promise((resolve) => {
      this.releaseUsageGate = resolve;
    });
  }
  openUsageGate(): void {
    this.releaseUsageGate?.();
  }

  ledger(): LedgerMemberRow[] {
    return ledgerFixture(this.inventory, this.meConsumed, this.otherConsumed);
  }

  async fetchLedger(roomId: string): Promise<LedgerMemberRow[]> {
    this.fetchLedgerCalls += 1;
    if (roomId !== ROOM) return [];
    return this.ledger();
  }

  async fetchHistory(_roomId: string): Promise<HistoryEntry[]> {
    return [...this.history];
  }

  async recordUsage(roomId: string, quantity: number): Promise<void> {
    if (this.usageGate) await this.usageGate;
    if (this.failNextUsage) {
      this.failNextUsage = false;
      throw new Error('not enough eggs remaining (0)');
    }
    if (roomId !== ROOM) throw new Error('not a member of this room');
    this.inventory -= quantity;
    this.meConsumed += quantity;
    if (this.transportB) {
      await this.transportB.emit({
        table: 'egg_usage',
        eventType: 'INSERT',
        row: { room_id: roomId, quantity },
      });
    }
  }

  async recordPurchase(roomId: string, quantity: number, _totalCost: number): Promise<void> {
    if (roomId !== ROOM) throw new Error('not a member of this room');
    this.inventory += quantity;
    if (this.transportB) {
      await this.transportB.emit({
        table: 'purchases',
        eventType: 'INSERT',
        row: { room_id: roomId, quantity },
      });
    }
  }
}

function make(api = new FakeApi(), transport = new MockTransport()) {
  const store = new AndaStore({ api, transport, roomId: ROOM, currentMemberId: ME });
  return { store, api, transport };
}

describe('AndaStore — Phase 6 realtime (§12, §26, §27)', () => {
  it('init: loads the authoritative snapshot and reports Synced', async () => {
    const { store } = make();
    await store.init();
    expect(store.status).toBe('synced');
    expect(store.state?.inventory).toBe(20);
    expect(store.state?.members).toHaveLength(2);
    expect(store.state?.lowStockThreshold).toBe(10);
  });

  it('usage by another client updates this client’s derived state (recompute, never invent)', async () => {
    const { store, api, transport } = make();
    await store.init();

    // The other member records 3 eggs on the server (authoritative change).
    api.inventory = 17;
    api.otherConsumed = 9;
    await transport.emit({
      table: 'egg_usage',
      eventType: 'INSERT',
      row: { room_id: ROOM, quantity: 3 },
    });

    expect(store.status).toBe('synced');
    expect(store.state?.inventory).toBe(17);
    // Derived from the authoritative fixture, not incremented locally.
    expect(store.state?.inventory).toBe(api.inventory);
    const other = store.state!.members.find((m) => m.member_id === OTHER)!;
    expect(other.consumed).toBe(9);
  });

  it('purchase event increases inventory; correction event restores stock', async () => {
    const { store, api, transport } = make();
    await store.init();

    api.inventory = 22;
    await transport.emit({
      table: 'purchases',
      eventType: 'INSERT',
      row: { room_id: ROOM, quantity: 5 },
    });
    expect(store.state?.inventory).toBe(22);

    // A correction adds eggs back (compensating negative usage) →
    // authoritative inventory rises.
    api.inventory = 24;
    api.meConsumed = 2;
    await transport.emit({
      table: 'egg_usage',
      eventType: 'INSERT',
      row: { room_id: ROOM, quantity: -2, correction_of: 'usage-1' },
    });
    expect(store.state?.inventory).toBe(24);
    expect(store.state?.members.find((m) => m.member_id === ME)?.consumed).toBe(2);
  });

  it('different rooms: an event for room B never reaches room A', async () => {
    const { store, api, transport } = make();
    await store.init();
    const before = api.fetchLedgerCalls;

    await transport.emit({
      table: 'egg_usage',
      eventType: 'INSERT',
      row: { room_id: ROOM_B, quantity: 99 },
    });

    // The store's room guard short-circuits: no refetch, no state change.
    expect(api.fetchLedgerCalls).toBe(before);
    expect(store.state?.inventory).toBe(20);
  });

  it('sync status: Offline on disconnect, Syncing→Synced on reconnect with recompute', async () => {
    const { store, api, transport } = make();
    await store.init();
    expect(store.status).toBe('synced');

    transport.setConnected(false);
    expect(store.status).toBe('offline');

    // While offline, the server changes (someone else used eggs).
    api.inventory = 12;
    api.otherConsumed = 14;

    transport.setConnected(true);
    expect(store.status).toBe('syncing');
    await vi.waitFor(() => expect(store.status).toBe('synced'));
    // Recomputed from authoritative state, never from stale local data.
    expect(store.state?.inventory).toBe(12);
  });

  it('optimistic usage: estimate is instant, then reconciled to server truth', async () => {
    const { store, api } = make();
    await store.init();
    api.setUsageGate();
    const started = store.recordUsage(2);

    // Optimistic window (<200 ms perceived latency §13).
    expect(store.status).toBe('syncing');
    expect(store.view?.inventory).toBe(18);
    expect(store.view?.members.find((m) => m.member_id === ME)?.consumed).toBe(6);

    api.openUsageGate();
    await started;
    expect(store.status).toBe('synced');
    expect(store.state?.inventory).toBe(18);
  });

  it('rejected usage reverts the optimistic estimate and surfaces the message (§24)', async () => {
    const { store, api } = make();
    await store.init();
    api.failNextUsage = true;

    await expect(store.recordUsage(99)).rejects.toThrow();
    expect(store.view?.inventory).toBe(20); // reverted
    expect(store.view?.members.find((m) => m.member_id === ME)?.consumed).toBe(4);
    expect(store.lastError).toContain('not enough eggs remaining');
    expect(store.status).toBe('synced'); // server truth restored
  });

  it('PRD §27: two clients in one room — usage by A is seen by B; other rooms never cross', async () => {
    const api = new FakeApi();
    const transportA = new MockTransport();
    const transportB = new MockTransport();
    api.transportB = transportB; // A's committed write is announced to B

    const a = new AndaStore({ api, transport: transportA, roomId: ROOM, currentMemberId: ME });
    const b = new AndaStore({ api, transport: transportB, roomId: ROOM, currentMemberId: OTHER });
    await a.init();
    await b.init();
    expect(a.state?.inventory).toBe(20);
    expect(b.state?.inventory).toBe(20);

    await a.recordUsage(3);
    expect(a.state?.inventory).toBe(17);
    // B saw A's usage via the room-scoped realtime event.
    expect(b.state?.inventory).toBe(17);
    expect(b.status).toBe('synced');

    // A client in a different room never receives these events.
    const c = new AndaStore({ api, transport: new MockTransport(), roomId: ROOM_B, currentMemberId: 'x' });
    await c.init();
    await transportB.emit({ table: 'purchases', eventType: 'INSERT', row: { room_id: ROOM, quantity: 7 } });
    expect(c.state?.inventory).toBe(0); // untouched
  });
});