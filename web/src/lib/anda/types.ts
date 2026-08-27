// Anda — room-scoped realtime store (PRD §7, §12, §13, §26)
//
// Domain types shared by the store, transports and API adapters.

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
  consumed: number;
  liability: number;
}

export type HistoryKind = 'purchase' | 'usage' | 'correction';

/** One row returned by the `room_history` RPC (newest first). */
export interface HistoryEntry {
  entry_id: string;
  kind: HistoryKind;
  recorded_at: string;
  quantity: number;
  member_id: string;
  member_name: string;
  correction_of: string | null;
  detail: string;
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

export type RealtimeTable = 'rooms' | 'members' | 'purchases' | 'egg_usage';
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
// Offline persistence (PRD §14, §15)
// ---------------------------------------------------------------------------

/** A durable, server-validated-on-flush mutation made offline (§14). */
export interface PendingMutation {
  id?: number;
  kind: 'usage' | 'purchase';
  roomId: string;
  quantity: number;
  totalCost?: number;
  createdAt: number;
}

/** A queued mutation that the server rejected during flush (§15, §24). */
export interface RejectedMutation {
  kind: 'usage' | 'purchase';
  roomId: string;
  quantity: number;
  totalCost?: number;
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

export interface RoomMembership {
  room_id: string;
  room_name: string;
  share_code: string;
  member_id: string;
  display_name: string;
  low_stock_threshold: number;
}

/** Typed client over the SECURITY DEFINER RPCs. */
export interface AndaApi {
  createRoom?(roomName: string, displayName: string): Promise<RoomMembership>;
  joinRoom?(shareCode: string, displayName: string): Promise<RoomMembership>;
  leaveRoom?(roomId: string): Promise<void>;
  fetchLedger(roomId: string): Promise<LedgerMemberRow[]>;
  fetchHistory(roomId: string): Promise<HistoryEntry[]>;
  recordUsage(roomId: string, quantity: number): Promise<void>;
  recordPurchase(roomId: string, quantity: number, totalCost: number): Promise<void>;
}
