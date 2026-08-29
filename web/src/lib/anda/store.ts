// Anda — room-scoped realtime + offline store (PRD §7, §12–§15, §26, §32)
// React notification: every mutation bumps _version and calls _notify.

import type {
  AndaApi,
  HistoryEntry,
  LedgerMemberRow,
  Minor,
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
  /** IndexedDB-backed offline repository (defaults to a no-op). */
  repo?: OfflineRepo;
}

interface OverlayOp {
  id?: number;
  kind: 'usage' | 'purchase';
  quantity: number;
  unitPriceMinor?: Minor;
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
  'price per egg cannot be',
  'total cost cannot be',
  'room not found',
  'not signed in',
  'nothing left to settle',
  'more than you owe',
  'not in this room',
  'choose a flatmate',
  'more than zero',
];

export function isValidationError(message: string): boolean {
  return VALIDATION_MARKERS.some((m) => message.includes(m));
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
  /** Queue items the server rejected on flush — surfaced, never dropped (§15, §24). */
  rejected: RejectedMutation[] = [];
  /** True while a submit is awaiting the server (PRD §40 loading states). */
  busy = false;
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

  /** §19/§32: Eat — optimistic, validated by the server, rolled back on reject. */
  async recordUsage(quantity: number): Promise<void> {
    if (this.isOffline()) {
      await this.enqueue({ kind: 'usage', roomId: this.roomId, quantity, createdAt: Date.now() });
      return;
    }
    const op: OverlayOp = { kind: 'usage', quantity };
    this.begin(op);
    try {
      await this.api.recordUsage(this.roomId, quantity);
      this.settle(op);
      await this.syncFromAuthoritative();
    } catch (err) {
      this.rollback(op);
      const msg = toFriendly(err);
      if (isValidationError(msg)) {
        await this.reconcileAfterRejection(msg);
        throw err;
      }
      await this.enqueue({ kind: 'usage', roomId: this.roomId, quantity, createdAt: Date.now() });
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  /** §21/§32: Buy — quantity + unit price in paise. */
  async recordPurchase(quantity: number, unitPriceMinor: Minor): Promise<void> {
    if (this.isOffline()) {
      await this.enqueue({
        kind: 'purchase',
        roomId: this.roomId,
        quantity,
        unitPriceMinor,
        createdAt: Date.now(),
      });
      return;
    }
    const op: OverlayOp = { kind: 'purchase', quantity, unitPriceMinor };
    this.begin(op);
    try {
      await this.api.recordPurchase(this.roomId, quantity, unitPriceMinor);
      this.settle(op);
      await this.syncFromAuthoritative();
    } catch (err) {
      this.rollback(op);
      const msg = toFriendly(err);
      if (isValidationError(msg)) {
        await this.reconcileAfterRejection(msg);
        throw err;
      }
      await this.enqueue({
        kind: 'purchase',
        roomId: this.roomId,
        quantity,
        unitPriceMinor,
        createdAt: Date.now(),
      });
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  /**
   * §30: record that the current member has covered part of what they owe.
   * Not optimistic — a settlement is a deliberate, confirmed money action and
   * inventing a provisional balance would be a lie the server may contradict.
   */
  async recordSettlement(toMemberId: string, amountMinor: Minor): Promise<void> {
    if (!this.api.recordSettlement) throw new Error('Settlements are unavailable');
    this.busy = true;
    this.status = 'syncing';
    this.notify();
    try {
      await this.api.recordSettlement(this.roomId, toMemberId, amountMinor);
      await this.syncFromAuthoritative();
    } catch (err) {
      this.lastError = toFriendly(err);
      this.status = this.connected ? 'synced' : 'offline';
      this.notify();
      throw err;
    } finally {
      this.busy = false;
      this.notify();
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

  /** Flush the durable pending queue through server validation (§15, §34). */
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
            await this.api.recordPurchase(
              this.roomId,
              item.quantity,
              item.unitPriceMinor ?? 0,
            );
          }
          if (item.id != null) await this.repo.removePending(item.id);
          this.dropFromOverlay(item);
        } catch (err) {
          const msg = toFriendly(err);
          if (isValidationError(msg)) {
            // Authoritative rejection (§34): surface it, never silently drop.
            if (item.id != null) await this.repo.removePending(item.id);
            this.dropFromOverlay(item);
            this.rejected.push({
              kind: item.kind,
              roomId: item.roomId,
              quantity: item.quantity,
              unitPriceMinor: item.unitPriceMinor,
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

  dismissRejected(): void {
    this.rejected = [];
    this.notify();
  }

  dispose(): void {
    this.closed = true;
    this.detachWindowListeners();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // -- internals ------------------------------------------------------------

  /** Push the optimistic overlay and mark the mutation as in-flight (§32). */
  private begin(op: OverlayOp): void {
    this.pending.push(op);
    this.busy = true;
    this.status = 'syncing';
    this.notify();
  }

  /** Server accepted: remove exactly this operation from the overlay. */
  private settle(op: OverlayOp): void {
    this.dropFromOverlay(op);
  }

  /**
   * Roll back exactly this operation.
   *
   * The previous implementation cleared the whole overlay array on any
   * rejection, which also discarded unrelated in-flight operations made
   * moments earlier. Only the failed op is removed now.
   */
  private rollback(op: OverlayOp): void {
    this.dropFromOverlay(op);
  }

  private async enqueue(mutation: PendingMutation): Promise<void> {
    const id = await this.repo.enqueue(mutation);
    this.pending.push({
      id,
      kind: mutation.kind,
      quantity: mutation.quantity,
      unitPriceMinor: mutation.unitPriceMinor,
    });
    this.status = 'offline';
    this.lastError = 'Offline — saved on this device';
    this.notify();
  }

  private isOffline(): boolean {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    return !this.connected;
  }

  /**
   * A validation rejection means the server disagrees with what the screen is
   * showing — usually because someone else moved first. Roll back the overlay,
   * then re-read the authoritative snapshot before surfacing the reason, so
   * the number on screen is never stale after a refusal (PRD §19 step 5, §32).
   */
  private async reconcileAfterRejection(message: string): Promise<void> {
    try {
      await this.syncFromAuthoritative();
    } catch {
      /* offline: keep the validation message below as the user-facing error */
    }
    this.lastError = message;
    this.status = this.connected ? 'synced' : 'offline';
    this.notify();
  }

  /** Remove the FIRST matching overlay entry only — never all of them. */
  private dropFromOverlay(op: OverlayOp): void {
    const index = this.pending.findIndex((p) => {
      if (op.id != null || p.id != null) return p.id === op.id;
      return (
        p.kind === op.kind &&
        p.quantity === op.quantity &&
        p.unitPriceMinor === op.unitPriceMinor
      );
    });
    if (index >= 0) this.pending.splice(index, 1);
  }

  private async hydratePending(): Promise<void> {
    const items = (await this.repo.listPending()).filter((m) => m.roomId === this.roomId);
    this.pending = items.map((m) => ({
      id: m.id,
      kind: m.kind,
      quantity: m.quantity,
      unitPriceMinor: m.unitPriceMinor,
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
    // Room scoping is enforced server-side by RLS and by the channel filter;
    // this is defence in depth so a stray event can never repaint the room.
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
