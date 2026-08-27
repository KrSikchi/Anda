// Anda — Supabase-backed API adapter over the SECURITY DEFINER RPCs.
// The browser is untrusted: these call server functions that re-validate
// membership and ledger integrity (PRD §5). No table access from the client.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AndaApi, HistoryEntry, LedgerMemberRow, RoomMembership } from './types';

export function createSupabaseApi(client: SupabaseClient): AndaApi {
  return {
    async createRoom(roomName: string, displayName: string): Promise<RoomMembership> {
      const { data, error } = await client.rpc('create_room', {
        p_room_name: roomName,
        p_display_name: displayName,
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

    async fetchLedger(roomId: string): Promise<LedgerMemberRow[]> {
      const { data, error } = await client.rpc('room_ledger', { p_room_id: roomId });
      if (error) throw new Error(error.message);
      return (data ?? []) as LedgerMemberRow[];
    },

    async fetchHistory(roomId: string): Promise<HistoryEntry[]> {
      const { data, error } = await client.rpc('room_history', { p_room_id: roomId });
      if (error) throw new Error(error.message);
      return (data ?? []) as HistoryEntry[];
    },

    async recordUsage(roomId: string, quantity: number): Promise<void> {
      const { error } = await client.rpc('record_usage', {
        p_room_id: roomId,
        p_quantity: quantity,
      });
      if (error) throw new Error(stripPrefix(error.message));
    },

    async recordPurchase(roomId: string, quantity: number, totalCost: number): Promise<void> {
      const { error } = await client.rpc('record_purchase', {
        p_room_id: roomId,
        p_quantity: quantity,
        p_total_cost: totalCost,
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
