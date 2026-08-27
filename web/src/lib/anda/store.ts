// Anda — room-scoped realtime + offline store (PRD §7, §12–§15, §26)
// React notification: every mutation bumps _version and calls _notify.

import type {
  AndaApi,
  HistoryEntry,
  LedgerMemberRow,
  OfflineRepo,
  PendingMutation,
  RealtimeEvent,
  RealtimeTransport,
  RejectedMutation,
  RoomSnapshot,
  SyncStatus,
} from './types';

export interface StoreOptions {
  api: AndaApi;
  transport: RealtimeTransport;
  roomId: string;
  currentMemberId: string;
  /** IndexedDB-backed offline repository (defaults to the shared instance). */
  repo?: OfflineRepo;
}

interface OverlayOp {
  id?: number;
  kind: 'usage' | 'purchase';
  quantity: number;
  totalCost?: number;
}

// Server validation failures (raised as 'Anda: …', §24). These are NEVER
// queued — they are authoritative rejections and are surfaced immediately.
const VALIDATION_MARKERS = [
  'not enough eggs remaining',
  'not a member of this room',
  'usage not found',
  'already been corrected',
  'corrected amount',
  'quantity must be',
  'total cost cannot be',
  'room not found',
  'not signed in',
];

export function isValidationError(message: string): boolean {
  return VALIDATION_MARKERS.some((m) => message.includes(m));
}

export async function defaultOfflineRepo(): Promise<OfflineRepo> {
  const { IdbRepo } = await import('./db');
  return new IdbRepo();
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
  /** Last friendly error (or "Offline — saved on this device"). */
  lastError: string | null = null;
  /** Queued-but-unconfirmed mutations surfaced to the UI (never finished truth). */
  pending: OverlayOp[] = [];
  /** Queue items the server rejected on flush — surfaced, never silently dropped (§15, §24). */
  rejected: RejectedMutation[] = [];
  /** Version counter for React useSyncExternalStore. */
  _version = 0;
  /** Called by the store after every state mutation to notify React. */
  _notify: (() => void) | undefined;

  private readonly api: AndaApi;
  private readonly transport: RealtimeTransport;
  private readonly repo: OfflineRepo;
  private unsubscribe: (() => void) | null = null;
  private connected = false;
  private flushing = false;
  private closed = false;

  constructor(opts: StoreOptions) {
    this.api = opts.api;
    this.transport = opts.transport;
    this.roomId = opts.roomId;
    this.currentMemberId = opts.currentMemberId;
    this.repo = opts.repo ?? new NoopRepo();
  }

  /** Connect room-scoped subscription and load authoritative state (or cache). */
  async init(): Promise<void> {
    this.status = 'syncing'; this.notify();
    this.attachWindowListeners();
    this.unsubscribe = this.transport.subscribe(this.roomId, {
      onEvent: (event) => this.onRealtimeEvent(event),
      onConnection: (connected) => this.onConnection(connected),
    });
    await this.repo.saveMeta('identity', {
      memberId: this.currentMemberId,
      roomId: this.roomId,
    });
    try {
      await this.refresh();
      await this.hydratePending();
      if (this.connected) await this.flushPending();
      this.status = this.connected ? 'synced' : 'syncing'; this.notify();
    } catch (_err) {
      await this.hydrateFromCache();
      await this.hydratePending();
      this.lastError = 'Offline — saved on this device';
      this.status = 'offline'; this.notify();
    }
  }

  /** The displayed view: authoritative state + pending estimates (§13/§15). */
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

  /** §13/§14: usage — optimistic when online, queued when offline. */
  async recordUsage(quantity: number): Promise<void> {
    if (this.isOffline()) {
      await this.enqueue({ kind: 'usage', roomId: this.roomId, quantity, createdAt: Date.now() });
      return;
    }
    this.pending.push({ kind: 'usage', quantity });
    this.status = 'syncing'; this.notify();
    try {
      await this.api.recordUsage(this.roomId, quantity);
      this.dropFromOverlay({ kind: 'usage', quantity });
      await this.syncFromAuthoritative();
    } catch (err) {
      const msg = toFriendly(err);
      this.pending = [];
      if (isValidationError(msg)) {
        this.lastError = msg;
        this.status = this.connected ? 'synced' : 'offline'; this.notify();
        throw err;
      }
      await this.enqueue({ kind: 'usage', roomId: this.roomId, quantity, createdAt: Date.now() });
    }
  }

  /** §13/§14: purchase — optimistic when online, queued when offline. */
  async recordPurchase(quantity: number, totalCost: number): Promise<void> {
    if (this.isOffline()) {
      await this.enqueue({
        kind: 'purchase',
        roomId: this.roomId,
        quantity,
        totalCost,
        createdAt: Date.now(),
      });
      return;
    }
    this.pending.push({ kind: 'purchase', quantity, totalCost });
    this.status = 'syncing'; this.notify();
    try {
      await this.api.recordPurchase(this.roomId, quantity, totalCost);
      this.dropFromOverlay({ kind: 'purchase', quantity, totalCost });
      await this.syncFromAuthoritative();
    } catch (err) {
      const msg = toFriendly(err);
      this.pending = [];
      if (isValidationError(msg)) {
        this.lastError = msg;
        this.status = this.connected ? 'synced' : 'offline'; this.notify();
        throw err;
      }
      await this.enqueue({
        kind: 'purchase',
        roomId: this.roomId,
        quantity,
        totalCost,
        createdAt: Date.now(),
      });
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
    await this.repo.cacheSet(`ledger:${this.roomId}`, rows);
    try {
      this.history = await this.api.fetchHistory(this.roomId);
      await this.repo.cacheSet(`history:${this.roomId}`, this.history);
    } catch {
      // history is an enrichment; ledger remains authoritative
    }
    this.notify();
  }

  /** Flush the durable pending queue through server validation (§15). */
  async flushPending(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    this.status = 'syncing'; this.notify();
    try {
      const items = (await this.repo.listPending()).filter((m) => m.roomId === this.roomId);
      for (const item of items) {
        try {
          if (item.kind === 'usage') {
            await this.api.recordUsage(this.roomId, item.quantity);
          } else {
            await this.api.recordPurchase(this.roomId, item.quantity, item.totalCost ?? 0);
          }
          if (item.id != null) await this.repo.removePending(item.id);
          this.dropFromOverlay(item);
        } catch (err) {
          const msg = toFriendly(err);
          if (isValidationError(msg)) {
            if (item.id != null) await this.repo.removePending(item.id);
            this.dropFromOverlay(item);
            this.rejected.push({
              kind: item.kind,
              roomId: item.roomId,
              quantity: item.quantity,
              totalCost: item.totalCost,
              error: msg,
              recordedAt: Date.now(),
            });
            this.lastError = msg;
            this.notify();
            continue;
          }
          this.status = 'offline'; this.notify();
          return;
        }
      }
      await this.syncFromAuthoritative();
    } finally {
      this.flushing = false;
    }
  }

  clearError(): void {
    this.lastError = null;
    this._version += 1;
    this._notify?.();
  }

  dispose(): void {
    this.closed = true;
    this.detachWindowListeners();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // -- internals ------------------------------------------------------------

  private async enqueue(mutation: PendingMutation): Promise<void> {
    const id = await this.repo.enqueue(mutation);
    this.pending.push({ id, kind: mutation.kind, quantity: mutation.quantity, totalCost: mutation.totalCost });
    this.status = 'offline';
    this.lastError = 'Offline — saved on this device';
    this.notify();
  }

  private isOffline(): boolean {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    return !this.connected;
  }

  private dropFromOverlay(op: OverlayOp): void {
    this.pending = this.pending.filter((p) => {
      if (op.id != null && p.id === op.id) return false;
      return p.kind !== op.kind || p.quantity !== op.quantity;
    });
  }

  private async hydratePending(): Promise<void> {
    const items = (await this.repo.listPending()).filter((m) => m.roomId === this.roomId);
    this.pending = items.map((m) => ({
      id: m.id,
      kind: m.kind,
      quantity: m.quantity,
      totalCost: m.totalCost,
    }));
    this.notify();
  }

  private async hydrateFromCache(): Promise<void> {
    const rows = await this.repo.cacheGet<LedgerMemberRow[]>(`ledger:${this.roomId}`);
    if (rows && rows.length) {
      const first = rows[0];
      this.state = {
        roomId: this.roomId,
        roomName: first.room_name,
        inventory: first.inventory,
        lowStockThreshold: first.low_stock_threshold,
        lowStockNotified: first.low_stock_notified,
        members: rows,
        currentMemberId: this.currentMemberId,
      };
      this.history = (await this.repo.cacheGet<HistoryEntry[]>(`history:${this.roomId}`)) ?? null;
    } else {
      this.state = null;
      this.history = null;
    }
    this.notify();
  }

  private async onRealtimeEvent(event: RealtimeEvent): Promise<void> {
    if (this.closed) return;
    const rowRoom = String(event.row.room_id ?? event.row.id ?? '');
    if (rowRoom !== this.roomId) return;
    await this.syncFromAuthoritative();
  }

  private async syncFromAuthoritative(): Promise<void> {
    this.status = 'syncing'; this.notify();
    try {
      await this.refresh();
      this.status = this.connected ? 'synced' : 'syncing'; this.notify();
    } catch (err) {
      this.lastError = toFriendly(err);
      this.status = this.connected ? 'synced' : 'offline'; this.notify();
    }
  }

  private onConnection(connected: boolean): void {
    this.connected = connected;
    if (!connected) {
      if (this.status !== 'offline') { this.status = 'offline'; this.notify(); }
      return;
    }
    if (this.status === 'offline') {
      this.status = 'syncing';
      this.notify();
      void this.flushPending();
    }
  }

  private onWindowOnline = (): void => {
    if (this.connected && this.status === 'offline') {
      this.status = 'syncing'; this.notify();
      void this.flushPending();
    }
  };

  private onWindowOffline = (): void => {
    if (this.status !== 'offline') { this.status = 'offline'; this.notify(); }
  };

  private notify(): void {
    this._version += 1;
    this._notify?.();
  }

  private attachWindowListeners(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', this.onWindowOnline);
    window.addEventListener('offline', this.onWindowOffline);
  }

  private detachWindowListeners(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('online', this.onWindowOnline);
    window.removeEventListener('offline', this.onWindowOffline);
  }
}

/** Fallback when no repo is provided (e.g. legacy tests): no-op. */
class NoopRepo implements OfflineRepo {
  async saveMeta(): Promise<void> {}
  async loadMeta(): Promise<undefined> { return undefined; }
  async cacheSet(): Promise<void> {}
  async cacheGet(): Promise<undefined> { return undefined; }
  async enqueue(): Promise<number> { return 0; }
  async listPending(): Promise<PendingMutation[]> { return []; }
  async removePending(): Promise<void> {}
}

export function toFriendly(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}
