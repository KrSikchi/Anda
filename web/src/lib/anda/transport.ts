// Anda — Supabase Realtime transport (§12).
// Room-scoped: each subscription attaches a `postgres_changes` listener per
// published table, filtered to the room. Layered on RLS (migration 0001) so a
// subscriber can never receive another room's rows even if the filter failed.

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type {
  RealtimeEvent,
  RealtimeHandlers,
  RealtimeTable,
  RealtimeTransport,
} from './types';

// Tables published in migration 0005. `rooms` is filtered by its primary key
// (`id`); every other table carries `room_id` (members, purchases, egg_usage).
const TABLES: Array<{ table: RealtimeTable; filter: (roomId: string) => string }> = [
  { table: 'rooms', filter: (id) => `id=eq.${id}` },
  { table: 'members', filter: (id) => `room_id=eq.${id}` },
  { table: 'purchases', filter: (id) => `room_id=eq.${id}` },
  { table: 'egg_usage', filter: (id) => `room_id=eq.${id}` },
];

export function createSupabaseTransport(client: SupabaseClient): RealtimeTransport {
  return {
    subscribe(roomId: string, handlers: RealtimeHandlers): () => void {
      const channel: RealtimeChannel = client.channel(`room:${roomId}`);

      for (const { table, filter } of TABLES) {
        channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table, filter: filter(roomId) },
          (payload) => {
            handlers.onEvent({
              table,
              eventType: (payload.eventType ?? 'INSERT') as RealtimeEvent['eventType'],
              row: (payload.new ?? {}) as Record<string, unknown>,
            });
          },
        );
      }

      channel.subscribe((status) => {
        handlers.onConnection(status === 'SUBSCRIBED');
      });

      return () => {
        void channel.unsubscribe();
      };
    },
  };
}