// Anda — domain types shared by the store, transports, API adapters and UI.
//
// Money: every monetary value crossing this boundary is an INTEGER NUMBER OF
// PAISE (PRD §22). Floats never reach the database and never come back from
// it — they exist only inside scratch variables in the UI.

/** Integer paise. ₹12.00 === 1200. */
export type Minor = number;

/** One row returned by the `room_ledger` SECURITY DEFINER RPC. */
export interface LedgerMemberRow {
  room_id: string;
  room_name: string;
  inventory: number;
  low_stock_threshold: number;
  low_stock_notified: boolean;
  member_id: string;
  display_name: string;
  is_active: boolean;
  is_host: boolean;
  consumed: number;
  /** What this member paid at the shop (paise). Drives settlement direction. */
  purchased_minor: Minor;
  /** FIFO cost of the eggs this member consumed (paise). */
  liability_minor: Minor;
  /** Already settled against that liability (paise). */
  settled_minor: Minor;
  /** liability − settled, floored at zero (paise). */
  outstanding_minor: Minor;
}

export type HistoryKind = 'purchase' | 'usage' | 'correction' | 'settlement';

/** One row returned by the `room_history` RPC (newest first). */
export interface HistoryEntry {
  entry_id: string;
  kind: HistoryKind;
  recorded_at: string;
  /** Null for settlements, which carry a monetary value instead. */
  quantity: number | null;
  member_id: string;
  member_name: string;
  correction_of: string | null;
  detail: string;
  /** Paise. Purchase totals and settlement amounts; null for usage. */
  amount_minor: Minor | null;
}

/** Derived room state, always recomputed from authoritative rows (§26). */
export interface RoomSnapshot {
  roomId: string;
  roomName: string;
  inventory: number;
  lowStockThreshold: number;
  lowStockNotified: boolean;
  members: LedgerMemberRow[];
  currentMemberId: string;
}

/** PRD §14/§24 synchronisation indicator states. */
export type SyncStatus = 'synced' | 'syncing' | 'offline';

export type RealtimeTable =
  | 'rooms'
  | 'members'
  | 'purchases'
  | 'egg_usage'
  | 'settlements';

export type RealtimeEventType = 'INSERT' | 'UPDATE' | 'DELETE';

/** A room-scoped database change delivered by Realtime. */
export interface RealtimeEvent {
  table: RealtimeTable;
  eventType: RealtimeEventType;
  row: Record<string, unknown>;
}

export interface RealtimeHandlers {
  onEvent: (event: RealtimeEvent) => void;
  onConnection: (connected: boolean) => void;
}

/** Transport abstraction — Supabase Realtime in production, mocks in tests. */
export interface RealtimeTransport {
  subscribe(roomId: string, handlers: RealtimeHandlers): () => void;
}

// ---------------------------------------------------------------------------
// Offline persistence (PRD §14, §15, §33)
// ---------------------------------------------------------------------------

/** A durable, server-validated-on-flush mutation made offline (§14). */
export interface PendingMutation {
  id?: number;
  kind: 'usage' | 'purchase';
  roomId: string;
  quantity: number;
  /** Paise per egg; only for `purchase`. */
  unitPriceMinor?: Minor;
  createdAt: number;
}

/** A queued mutation that the server rejected during flush (§15, §24). */
export interface RejectedMutation {
  kind: 'usage' | 'purchase';
  roomId: string;
  quantity: number;
  unitPriceMinor?: Minor;
  error: string;
  recordedAt: number;
}

/** IndexedDB-backed offline repository (identity, cache, pending queue). */
export interface OfflineRepo {
  saveMeta(key: string, value: unknown): Promise<void>;
  loadMeta<T>(key: string): Promise<T | undefined>;
  cacheSet<T>(key: string, value: T): Promise<void>;
  cacheGet<T>(key: string): Promise<T | undefined>;
  enqueue(mutation: PendingMutation): Promise<number>;
  listPending(): Promise<PendingMutation[]>;
  removePending(id: number): Promise<void>;
}

/** What `create_room` / `join_room` return: everything needed to enter a room. */
export interface RoomMembership {
  room_id: string;
  room_name: string;
  share_code: string;
  member_id: string;
  display_name: string;
  low_stock_threshold: number;
}

/** One row returned by `my_memberships()` — identity recovery (PRD §17/§44). */
export interface MembershipSummary {
  room_id: string;
  room_name: string;
  share_code: string;
  member_id: string;
  display_name: string;
  is_host: boolean;
  low_stock_threshold: number;
  member_count: number;
  joined_at: string;
}

/** Typed client over the SECURITY DEFINER RPCs. */
export interface AndaApi {
  createRoom?(
    roomName: string,
    displayName: string,
    lowStockThreshold?: number,
  ): Promise<RoomMembership>;
  joinRoom?(shareCode: string, displayName: string): Promise<RoomMembership>;
  leaveRoom?(roomId: string): Promise<void>;
  /** Rooms the signed-in identity already belongs to (§17 recovery). */
  myMemberships?(): Promise<MembershipSummary[]>;
  fetchLedger(roomId: string): Promise<LedgerMemberRow[]>;
  fetchHistory(roomId: string): Promise<HistoryEntry[]>;
  recordUsage(roomId: string, quantity: number): Promise<void>;
  /** Unit price in paise per egg (PRD §21 — never a total). */
  recordPurchase(
    roomId: string,
    quantity: number,
    unitPriceMinor: Minor,
  ): Promise<void>;
  recordSettlement?(
    roomId: string,
    toMemberId: string,
    amountMinor: Minor,
  ): Promise<void>;
}
