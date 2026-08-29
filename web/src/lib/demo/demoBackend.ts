// Anda — in-memory backend for local development and preview.
//
// WHY THIS EXISTS
// The real backend is Supabase: every read is a room-scoped RPC and every
// write is a SECURITY DEFINER function that re-validates membership. That
// needs VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY, which do not exist in a
// fresh checkout or a preview sandbox. Without a backend there is no way to
// see or exercise the UI at all.
//
// WHAT IT IS NOT
// This is NOT a source of product data. It starts EMPTY — no rooms, no
// members, no balances, no history. Nothing from the supplied Stitch screens
// is seeded here (PRD §48). Every value in the running app comes from what the
// person using it just did. It is selected only when Supabase env vars are
// absent, and the UI says so while it is active.
//
// It mirrors the server's rules — derived inventory, no negative stock,
// FIFO liability, unit-price purchases, settlement cap — so behaviour seen
// here is the behaviour the real backend will produce.

import type {
  AndaApi,
  HistoryEntry,
  LedgerMemberRow,
  MembershipSummary,
  Minor,
  RealtimeEvent,
  RealtimeHandlers,
  RealtimeTransport,
  RoomMembership,
} from '../anda/types';

interface DemoMember {
  id: string;
  roomId: string;
  displayName: string;
  isActive: boolean;
  createdAt: string;
}

interface DemoRoom {
  id: string;
  name: string;
  shareCode: string;
  hostMemberId: string;
  lowStockThreshold: number;
  lowStockNotified: boolean;
  createdAt: string;
}

interface DemoPurchase {
  id: string;
  roomId: string;
  memberId: string;
  quantity: number;
  unitPriceMinor: Minor;
  recordedAt: string;
}

interface DemoUsage {
  id: string;
  roomId: string;
  memberId: string;
  quantity: number;
  correctionOf: string | null;
  recordedAt: string;
}

interface DemoSettlement {
  id: string;
  roomId: string;
  fromMemberId: string;
  toMemberId: string;
  amountMinor: Minor;
  recordedAt: string;
}

const DEFAULT_THRESHOLD = 10;

function uid(): string {
  return crypto.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}`;
}

function code(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

class AndaError extends Error {
  constructor(message: string) {
    super(`Anda: ${message}`);
  }
}

interface AuthShim {
  state: { kind: 'anonymous' } | { kind: 'permanent'; email: string | null };
  getState(): { kind: 'anonymous' } | { kind: 'permanent'; email: string | null };
  setPermanent(email: string): void;
  reset(): void;
}

export interface DemoBackend {
  api: AndaApi;
  transport: RealtimeTransport;
  auth: AuthShim;
}

export function createDemoBackend(): DemoBackend {
  const rooms = new Map<string, DemoRoom>();
  const members = new Map<string, DemoMember>();
  const purchases: DemoPurchase[] = [];
  const usage: DemoUsage[] = [];
  const settlements: DemoSettlement[] = [];

  let sessionMemberId: string | null = null;
  const subscribers = new Set<{ roomId: string; handlers: RealtimeHandlers }>();

  const auth: AuthShim = {
    state: { kind: 'anonymous' },
    getState() {
      return this.state;
    },
    setPermanent(email: string) {
      this.state = { kind: 'permanent', email };
    },
    reset() {
      this.state = { kind: 'anonymous' };
    },
  };

  function emit(roomId: string, table: RealtimeEvent['table']): void {
    for (const sub of subscribers) {
      if (sub.roomId !== roomId) continue;
      sub.handlers.onEvent({ table, eventType: 'INSERT', row: { room_id: roomId } });
    }
  }

  function roomOf(roomId: string): DemoRoom {
    const room = rooms.get(roomId);
    if (!room) throw new AndaError('room not found');
    return room;
  }

  function requireMember(roomId: string): DemoMember {
    if (!sessionMemberId) throw new AndaError('not signed in');
    const member = members.get(sessionMemberId);
    if (!member || member.roomId !== roomId || !member.isActive) {
      throw new AndaError('not a member of this room');
    }
    return member;
  }

  function inventory(roomId: string): number {
    const bought = purchases
      .filter((p) => p.roomId === roomId)
      .reduce((sum, p) => sum + p.quantity, 0);
    const used = usage
      .filter((u) => u.roomId === roomId)
      .reduce((sum, u) => sum + u.quantity, 0);
    return bought - used;
  }

  /**
   * FIFO liability, mirroring 0003 D15/D16: consumption events in
   * chronological order draw from the earliest batches first, and a correction
   * reduces the effective amount attributed to the member who recorded it.
   * Arithmetic stays in integer paise (PRD §22).
   */
  function liabilityByMember(roomId: string): Map<string, Minor> {
    const batches = purchases
      .filter((p) => p.roomId === roomId)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));

    const events = usage
      .filter((u) => u.roomId === roomId && u.correctionOf === null)
      .map((u) => ({
        memberId: u.memberId,
        effective:
          u.quantity +
          usage
            .filter((c) => c.correctionOf === u.id)
            .reduce((sum, c) => sum + c.quantity, 0),
        recordedAt: u.recordedAt,
        id: u.id,
      }))
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));

    const result = new Map<string, Minor>();
    let batchIndex = 0;
    let batchRemaining = batches.length > 0 ? batches[0].quantity : 0;

    for (const event of events) {
      let remaining = event.effective;
      while (remaining > 0 && batchIndex < batches.length) {
        const batch = batches[batchIndex];
        const take = Math.min(remaining, batchRemaining);
        result.set(
          event.memberId,
          (result.get(event.memberId) ?? 0) + take * batch.unitPriceMinor,
        );
        remaining -= take;
        batchRemaining -= take;
        if (batchRemaining === 0) {
          batchIndex += 1;
          batchRemaining = batchIndex < batches.length ? batches[batchIndex].quantity : 0;
        }
      }
    }
    return result;
  }

  function ledgerRows(roomId: string): LedgerMemberRow[] {
    const room = roomOf(roomId);
    const liability = liabilityByMember(roomId);
    const settled = new Map<string, Minor>();
    const purchased = new Map<string, Minor>();

    for (const s of settlements) {
      if (s.roomId !== roomId) continue;
      settled.set(s.fromMemberId, (settled.get(s.fromMemberId) ?? 0) + s.amountMinor);
    }
    for (const p of purchases) {
      if (p.roomId !== roomId) continue;
      purchased.set(
        p.memberId,
        (purchased.get(p.memberId) ?? 0) + p.unitPriceMinor * p.quantity,
      );
    }

    return [...members.values()]
      .filter((m) => m.roomId === roomId)
      .map((m) => {
        const liabilityMinor = liability.get(m.id) ?? 0;
        const settledMinor = settled.get(m.id) ?? 0;
        return {
          room_id: room.id,
          room_name: room.name,
          inventory: inventory(roomId),
          low_stock_threshold: room.lowStockThreshold,
          low_stock_notified: room.lowStockNotified,
          member_id: m.id,
          display_name: m.displayName,
          is_active: m.isActive,
          is_host: m.id === room.hostMemberId,
          consumed: usage
            .filter(
              (u) =>
                u.roomId === roomId && u.memberId === m.id && u.correctionOf === null,
            )
            .reduce((sum, u) => sum + u.quantity, 0),
          purchased_minor: purchased.get(m.id) ?? 0,
          liability_minor: liabilityMinor,
          settled_minor: settledMinor,
          outstanding_minor: Math.max(liabilityMinor - settledMinor, 0),
        };
      })
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  function historyRows(roomId: string): HistoryEntry[] {
    const nameOf = (memberId: string) => members.get(memberId)?.displayName ?? 'Someone';
    const rows: HistoryEntry[] = [];

    for (const p of purchases.filter((x) => x.roomId === roomId)) {
      rows.push({
        entry_id: p.id,
        kind: 'purchase',
        recorded_at: p.recordedAt,
        quantity: p.quantity,
        member_id: p.memberId,
        member_name: nameOf(p.memberId),
        correction_of: null,
        detail: `${(p.unitPriceMinor / 100).toFixed(2)} per egg`,
        amount_minor: p.unitPriceMinor * p.quantity,
      });
    }
    for (const u of usage.filter((x) => x.roomId === roomId)) {
      rows.push({
        entry_id: u.id,
        kind: u.correctionOf ? 'correction' : 'usage',
        recorded_at: u.recordedAt,
        quantity: u.quantity,
        member_id: u.memberId,
        member_name: nameOf(u.memberId),
        correction_of: u.correctionOf,
        detail: u.correctionOf ? 'fixes earlier entry' : 'eggs used',
        amount_minor: null,
      });
    }
    for (const s of settlements.filter((x) => x.roomId === roomId)) {
      rows.push({
        entry_id: s.id,
        kind: 'settlement',
        recorded_at: s.recordedAt,
        quantity: null,
        member_id: s.fromMemberId,
        member_name: nameOf(s.fromMemberId),
        correction_of: null,
        detail: `settled with ${nameOf(s.toMemberId)}`,
        amount_minor: s.amountMinor,
      });
    }

    return rows.sort(
      (a, b) => b.recorded_at.localeCompare(a.recorded_at) || b.entry_id.localeCompare(a.entry_id),
    );
  }

  function membershipOf(room: DemoRoom, member: DemoMember): RoomMembership {
    return {
      room_id: room.id,
      room_name: room.name,
      share_code: room.shareCode,
      member_id: member.id,
      display_name: member.displayName,
      low_stock_threshold: room.lowStockThreshold,
    };
  }

  const api: AndaApi = {
    async createRoom(roomName, displayName, lowStockThreshold = DEFAULT_THRESHOLD) {
      if (!roomName?.trim()) throw new AndaError('room name required');
      if (!displayName?.trim()) throw new AndaError('display name required');

      const roomId = uid();
      const memberId = uid();
      const room: DemoRoom = {
        id: roomId,
        name: roomName.trim(),
        shareCode: code(),
        hostMemberId: memberId,
        lowStockThreshold,
        lowStockNotified: false,
        createdAt: new Date().toISOString(),
      };
      const member: DemoMember = {
        id: memberId,
        roomId,
        displayName: displayName.trim(),
        isActive: true,
        createdAt: new Date().toISOString(),
      };
      rooms.set(roomId, room);
      members.set(memberId, member);
      sessionMemberId = memberId;
      emit(roomId, 'rooms');
      return membershipOf(room, member);
    },

    async joinRoom(shareCode, displayName) {
      const wanted = (shareCode ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(wanted)) throw new AndaError('room not found');
      if (!displayName?.trim()) throw new AndaError('display name required');

      const room = [...rooms.values()].find((r) => r.shareCode === wanted);
      if (!room) throw new AndaError('room not found');

      const existing = [...members.values()].find(
        (m) => m.roomId === room.id && m.id === sessionMemberId && m.isActive,
      );
      if (existing) {
        sessionMemberId = existing.id;
        return membershipOf(room, existing);
      }

      const member: DemoMember = {
        id: uid(),
        roomId: room.id,
        displayName: displayName.trim(),
        isActive: true,
        createdAt: new Date().toISOString(),
      };
      members.set(member.id, member);
      sessionMemberId = member.id;
      emit(room.id, 'members');
      return membershipOf(room, member);
    },

    async leaveRoom(roomId) {
      const member = requireMember(roomId);
      member.isActive = false;
      sessionMemberId = null;
      emit(roomId, 'members');
    },

    async myMemberships(): Promise<MembershipSummary[]> {
      return [...members.values()]
        .filter((m) => m.isActive && m.id === sessionMemberId)
        .map((m) => {
          const room = rooms.get(m.roomId)!;
          return {
            room_id: room.id,
            room_name: room.name,
            share_code: room.shareCode,
            member_id: m.id,
            display_name: m.displayName,
            is_host: m.id === room.hostMemberId,
            low_stock_threshold: room.lowStockThreshold,
            member_count: [...members.values()].filter(
              (x) => x.roomId === room.id && x.isActive,
            ).length,
            joined_at: m.createdAt,
          };
        });
    },

    async fetchLedger(roomId) {
      requireMember(roomId);
      return ledgerRows(roomId);
    },

    async fetchHistory(roomId) {
      requireMember(roomId);
      return historyRows(roomId);
    },

    async recordUsage(roomId, quantity) {
      const member = requireMember(roomId);
      if (!quantity || quantity <= 0) {
        throw new AndaError('quantity must be a positive number');
      }
      const available = inventory(roomId);
      if (quantity > available) {
        throw new AndaError('not enough eggs remaining');
      }
      usage.push({
        id: uid(),
        roomId,
        memberId: member.id,
        quantity,
        correctionOf: null,
        recordedAt: new Date().toISOString(),
      });
      emit(roomId, 'egg_usage');
    },

    async recordPurchase(roomId, quantity, unitPriceMinor) {
      const member = requireMember(roomId);
      if (!quantity || quantity <= 0) {
        throw new AndaError('quantity must be a positive number');
      }
      if (unitPriceMinor == null || unitPriceMinor < 0) {
        throw new AndaError('price per egg cannot be negative');
      }
      purchases.push({
        id: uid(),
        roomId,
        memberId: member.id,
        quantity,
        unitPriceMinor,
        recordedAt: new Date().toISOString(),
      });
      emit(roomId, 'purchases');
    },

    async recordSettlement(roomId, toMemberId, amountMinor) {
      const member = requireMember(roomId);
      const target = members.get(toMemberId);
      if (!target || target.roomId !== roomId || !target.isActive) {
        throw new AndaError('that member is not in this room');
      }
      if (target.id === member.id) throw new AndaError('choose a flatmate to settle with');
      if (!amountMinor || amountMinor <= 0) {
        throw new AndaError('settlement must be more than zero');
      }
      const rows = ledgerRows(roomId);
      const me = rows.find((r) => r.member_id === member.id);
      const owed = me?.outstanding_minor ?? 0;
      if (owed === 0) throw new AndaError('nothing left to settle');
      if (amountMinor > owed) throw new AndaError('that is more than you owe');

      settlements.push({
        id: uid(),
        roomId,
        fromMemberId: member.id,
        toMemberId,
        amountMinor,
        recordedAt: new Date().toISOString(),
      });
      emit(roomId, 'settlements');
    },

    // Push is a device concern with no local equivalent; recording nothing is
    // honest — the demo backend never pretends to deliver notifications.
    async addPushSubscription() {
      /* no-op in demo mode */
    },

    async removePushSubscription() {
      /* no-op in demo mode */
    },
  };

  const transport: RealtimeTransport = {
    subscribe(roomId, handlers) {
      const sub = { roomId, handlers };
      subscribers.add(sub);
      // Report connected on the next tick, as a real channel does.
      setTimeout(() => handlers.onConnection(true), 0);
      return () => {
        subscribers.delete(sub);
      };
    },
  };

  return { api, transport, auth };
}
