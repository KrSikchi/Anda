// Anda — two connected clients in one room (PRD §31, §57).
//
// "User A changes inventory; user B sees the change without refreshing" is the
// claim the whole realtime phase exists for. Here it is exercised for real:
// two AndaStore instances, the real demo transport, and a real backend — not
// a mock that hands the answer to the second client.
//
// Honest limitation: both clients share one member identity (the in-memory
// backend has a single session), so this is "another CLIENT sees it", which is
// the realtime path. Truly "another USER" needs two browsers against Supabase.

import { describe, expect, it, vi } from 'vitest';
import { AndaStore } from '../store';
import { IdbRepo } from '../db';
import { createDemoBackend } from '../../demo/demoBackend';
import type { RealtimeEvent, RealtimeHandlers, RealtimeTransport } from '../types';

/** A transport the test can push events through, as a channel would. */
class PushTransport implements RealtimeTransport {
  private handlers: RealtimeHandlers | null = null;

  subscribe(_roomId: string, handlers: RealtimeHandlers): () => void {
    this.handlers = handlers;
    setTimeout(() => handlers.onConnection(true), 0);
    return () => {
      this.handlers = null;
    };
  }

  emit(event: RealtimeEvent): void {
    this.handlers?.onEvent(event);
  }
}

function makeClient(
  backend: ReturnType<typeof createDemoBackend>,
  roomId: string,
  memberId: string,
): AndaStore {
  return new AndaStore({
    api: backend.api,
    transport: backend.transport,
    repo: new IdbRepo(),
    roomId,
    currentMemberId: memberId,
  });
}

describe('room-scoped realtime between two clients (§31)', () => {
  it('a purchase on one client reaches the other without a refresh', async () => {
    const backend = createDemoBackend();
    const room = await backend.api.createRoom!('Realtime Flat', 'Ada', 10);

    const first = makeClient(backend, room.room_id, room.member_id);
    const second = makeClient(backend, room.room_id, room.member_id);

    await first.init();
    await second.init();

    expect(first.view?.inventory).toBe(0);
    expect(second.view?.inventory).toBe(0);

    // Client one buys a dozen at ₹6.00 per egg.
    await first.recordPurchase(12, 600);

    await vi.waitFor(() => expect(second.view?.inventory).toBe(12));
    expect(first.view?.inventory).toBe(12);

    // …and then eats three.
    await first.recordUsage(3);

    await vi.waitFor(() => expect(second.view?.inventory).toBe(9));
    expect(first.view?.inventory).toBe(9);

    first.dispose();
    second.dispose();
  });

  it('the second client sees the activity entry too, not just the count', async () => {
    const backend = createDemoBackend();
    const room = await backend.api.createRoom!('Ledger Flat', 'Ada', 10);

    const first = makeClient(backend, room.room_id, room.member_id);
    const second = makeClient(backend, room.room_id, room.member_id);

    await first.init();
    await second.init();

    await first.recordPurchase(6, 700);

    await vi.waitFor(() => {
      const entry = second.history?.find((h) => h.kind === 'purchase');
      expect(entry?.quantity).toBe(6);
      expect(entry?.amount_minor).toBe(4200);
    });

    first.dispose();
    second.dispose();
  });

  it('ignores events that are not for this room (§31)', async () => {
    const backend = createDemoBackend();
    const room = await backend.api.createRoom!('Scoped Flat', 'Ada', 10);

    // Count authoritative reads: an event the store should ignore must not
    // cause a refetch, and one for this room must.
    let ledgerReads = 0;
    const api = {
      ...backend.api,
      fetchLedger: async (roomId: string) => {
        ledgerReads += 1;
        return backend.api.fetchLedger(roomId);
      },
    };

    const transport = new PushTransport();
    const store = new AndaStore({
      api,
      transport,
      repo: new IdbRepo(),
      roomId: room.room_id,
      currentMemberId: room.member_id,
    });
    await store.init();

    const before = ledgerReads;

    // Another room's traffic arrives on the shared channel.
    transport.emit({
      table: 'purchases',
      eventType: 'INSERT',
      row: { room_id: 'some-other-room', quantity: 99 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ledgerReads).toBe(before);
    expect(store.view?.inventory).toBe(0);

    // This room's traffic is acted upon.
    transport.emit({
      table: 'purchases',
      eventType: 'INSERT',
      row: { room_id: room.room_id, quantity: 4 },
    });
    await vi.waitFor(() => expect(ledgerReads).toBeGreaterThan(before));

    store.dispose();
  });
});
