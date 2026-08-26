// Anda — client store (§12, §13, §26).
//
// Authoritative-first: on every relevant database event the store REFETCHES
// `room_ledger` (and `room_history`) and recomputes derived state. It never
// invents inventory/liability numbers on its own. Optimistic estimates are a
// temporary display layer (§13): applied instantly for perceived latency,
// then overwritten by the authoritative refetch on confirmation, or reverted
// when the server rejects the operation (§24).

import type {
  AndaApi,
  HistoryEntry,
  RealtimeEvent,
  RealtimeTransport,
  RoomSnapshot,
  SyncStatus,
} from './types';

export interface StoreOptions {
  api: AndaApi;
  transport: RealtimeTransport;
  roomId: string;
  currentMemberId: string;
}

interface PendingOp {
  kind: 'usage' | 'purchase';
  quantity: number;
}

export class AndaStore {
  readonly roomId: string;
  readonly currentMemberId: string;

  /** Authoritative derived state (server truth). */
  state: RoomSnapshot | null = null;
  /** Server-backed transaction history, newest first. */
  history: HistoryEntry[] | null = null;
  /** Sync indicator (§14): Synced / Syncing / Offline. */
  status: SyncStatus = 'syncing';
  /** Last friendly error from the server (or transport). */
  lastError: string | null = null;

  private readonly api: AndaApi;
  private readonly transport: RealtimeTransport;
  private unsubscribe: (() => void) | null = null;
  private connected = false;
  private pending: PendingOp[] = [];
  private refetches = 0; // observable for tests
  private closed = false;

  constructor(opts: StoreOptions) {
    this.api = opts.api;
    this.transport = opts.transport;
    this.roomId = opts.roomId;
    this.currentMemberId = opts.currentMemberId;
  }

  /** Connect the room-scoped subscription and load the authoritative snapshot. */
  async init(): Promise<void> {
    this.status = 'syncing';
    this.unsubscribe = this.transport.subscribe(this.roomId, {
      onEvent: (event) => {
        void this.onRealtimeEvent(event);
      },
      onConnection: (connected) => this.onConnection(connected),
    });
    try {
      await this.refresh();
      this.status = this.connected ? 'synced' : 'syncing';
    } catch (err) {
      this.lastError = toFriendly(err);
      this.status = this.connected ? 'synced' : 'offline';
    }
  }

  /** The displayed view: authoritative state + any pending optimistic ops. */
  get view(): RoomSnapshot | null {
    if (!this.state) return null;
    let inventory = this.state.inventory;
    const consumed = new Map<string, number>(
      this.state.members.map((m) => [m.member_id, m.consumed]),
    );
    for (const op of this.pending) {
      if (op.kind === 'usage') {
        inventory -= op.quantity;
        consumed.set(
          this.currentMemberId,
          (consumed.get(this.currentMemberId) ?? 0) + op.quantity,
        );
      } else {
        inventory += op.quantity;
      }
    }
    return {
      ...this.state,
      inventory,
      members: this.state.members.map((m) => ({
        ...m,
        consumed: consumed.get(m.member_id) ?? m.consumed,
      })),
    };
  }

  /** §13: optimistic usage — perceived-latency estimate, server-confirmed. */
  async recordUsage(quantity: number): Promise<void> {
    this.pending.push({ kind: 'usage', quantity });
    this.status = 'syncing';
    try {
      await this.api.recordUsage(this.roomId, quantity);
      this.pending = [];
      await this.syncFromAuthoritative();
    } catch (err) {
      this.pending = [];
      this.lastError = toFriendly(err);
      // No authoritative change occurred on this device; the server truth
      // stands. Revert the optimistic estimate and surface why (§24).
      this.status = this.connected ? 'synced' : 'offline';
      throw err;
    }
  }

  /** §13: optimistic purchase — same perceive/confirm/reconcile lifecycle. */
  async recordPurchase(quantity: number, totalCost: number): Promise<void> {
    this.pending.push({ kind: 'purchase', quantity });
    this.status = 'syncing';
    try {
      await this.api.recordPurchase(this.roomId, quantity, totalCost);
      this.pending = [];
      await this.syncFromAuthoritative();
    } catch (err) {
      this.pending = [];
      this.lastError = toFriendly(err);
      this.status = this.connected ? 'synced' : 'offline';
      throw err;
    }
  }

  async refresh(): Promise<void> {
    const rows = await this.api.fetchLedger(this.roomId);
    const first = rows[0];
    this.state = {
      roomId: this.roomId,
      roomName: first?.room_name ?? '',
      inventory: first?.inventory ?? 0,
      lowStockThreshold: first?.low_stock_threshold ?? 10,
      lowStockNotified: first?.low_stock_notified ?? false,
      members: rows,
      currentMemberId: this.currentMemberId,
    };
    try {
      this.history = await this.api.fetchHistory(this.roomId);
    } catch {
      // History enriches the screen; ledger remains authoritative.
    }
    this.refetches += 1;
  }

  clearError(): void {
    this.lastError = null;
  }

  dispose(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // -- internals ------------------------------------------------------------

  private async onRealtimeEvent(event: RealtimeEvent): Promise<void> {
    if (this.closed) return;
    // Layer-3 guard (§12): even with the channel filter, never apply an event
    // that is not for this room.
    const rowRoom = String(event.row.room_id ?? event.row.id ?? '');
    if (rowRoom !== this.roomId) return;
    await this.syncFromAuthoritative();
  }

  private async syncFromAuthoritative(): Promise<void> {
    this.status = 'syncing';
    try {
      await this.refresh();
      this.status = this.connected ? 'synced' : 'syncing';
    } catch (err) {
      this.lastError = toFriendly(err);
      this.status = this.connected ? 'synced' : 'offline';
    }
  }

  private onConnection(connected: boolean): void {
    this.connected = connected;
    if (!connected) {
      this.status = 'offline';
      return;
    }
    // Reconnected: recompute from authoritative state (never from stale local).
    if (this.status === 'offline') {
      this.status = 'syncing';
      void this.syncFromAuthoritative();
    }
  }
}

export function toFriendly(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}