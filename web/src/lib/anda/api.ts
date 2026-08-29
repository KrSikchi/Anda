// Anda — Supabase-backed API adapter over the SECURITY DEFINER RPCs.
// The browser is untrusted: these call server functions that re-validate
// membership and ledger integrity (PRD §5). No table access from the client.
//
// Money crosses this boundary as integer paise (PRD §22).

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AndaApi,
  HistoryEntry,
  LedgerMemberRow,
  MembershipSummary,
  Minor,
  RoomMembership,
} from './types';

/** Default low-stock threshold (PRD §35) — also the DB column default. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 10;

export function createSupabaseApi(client: SupabaseClient): AndaApi {
  return {
    async createRoom(
      roomName: string,
      displayName: string,
      lowStockThreshold: number = DEFAULT_LOW_STOCK_THRESHOLD,
    ): Promise<RoomMembership> {
      const { data, error } = await client.rpc('create_room', {
        p_room_name: roomName,
        p_display_name: displayName,
        p_low_stock_threshold: lowStockThreshold,
      });
      if (error) throw new Error(stripPrefix(error.message));
      return firstRow<RoomMembership>(data);
    },

    async joinRoom(shareCode: string, displayName: string): Promise<RoomMembership> {
      const { data, error } = await client.rpc('join_room', {
        p_share_code: shareCode,
        p_display_name: displayName,
      });
      if (error) throw new Error(stripPrefix(error.message));
      return firstRow<RoomMembership>(data);
    },

    async leaveRoom(roomId: string): Promise<void> {
      const { error } = await client.rpc('leave_room', { p_room_id: roomId });
      if (error) throw new Error(stripPrefix(error.message));
    },

    async myMemberships(): Promise<MembershipSummary[]> {
      const { data, error } = await client.rpc('my_memberships');
      if (error) throw new Error(stripPrefix(error.message));
      return (data ?? []) as MembershipSummary[];
    },

    async fetchLedger(roomId: string): Promise<LedgerMemberRow[]> {
      const { data, error } = await client.rpc('room_ledger', { p_room_id: roomId });
      if (error) throw new Error(stripPrefix(error.message));
      return (data ?? []) as LedgerMemberRow[];
    },

    async fetchHistory(roomId: string): Promise<HistoryEntry[]> {
      const { data, error } = await client.rpc('room_history', { p_room_id: roomId });
      if (error) throw new Error(stripPrefix(error.message));
      return (data ?? []) as HistoryEntry[];
    },

    async recordUsage(roomId: string, quantity: number): Promise<void> {
      const { error } = await client.rpc('record_usage', {
        p_room_id: roomId,
        p_quantity: quantity,
      });
      if (error) throw new Error(stripPrefix(error.message));
    },

    // PRD §21: the unit price is the input, the total is derived. Never the
    // other way round, and never divided back out of a total.
    async recordPurchase(
      roomId: string,
      quantity: number,
      unitPriceMinor: Minor,
    ): Promise<void> {
      const { error } = await client.rpc('record_purchase', {
        p_room_id: roomId,
        p_quantity: quantity,
        p_unit_price_minor: unitPriceMinor,
      });
      if (error) throw new Error(stripPrefix(error.message));
    },

    async recordSettlement(
      roomId: string,
      toMemberId: string,
      amountMinor: Minor,
    ): Promise<void> {
      const { error } = await client.rpc('record_settlement', {
        p_room_id: roomId,
        p_to_member_id: toMemberId,
        p_amount_minor: amountMinor,
      });
      if (error) throw new Error(stripPrefix(error.message));
    },
  };
}

// Server errors are raised as 'Anda: <plain message>' (PRD §24); the UI maps
// those to friendly copy. Keep the raw message available for debugging.
function stripPrefix(message: string): string {
  return message.replace(/^Anda:\s*/, '');
}

function firstRow<T>(data: unknown): T {
  if (Array.isArray(data) && data[0]) return data[0] as T;
  throw new Error('No room returned');
}
