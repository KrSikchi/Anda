-- ============================================================================
-- Anda — Realtime (PRD Phase 6)
-- Migration 0005
--
-- Purpose: ensure the ledger/lifecycle tables are published to Supabase
-- Realtime so clients receive room-scoped change events and recompute derived
-- state (§12, §26). NO schema change beyond publication membership.
--
-- Layered room-scoping (§12: "Do not transmit unrelated rooms' data"):
--   1. Table publication  — only the four tables that change with room
--                           activity are published (settlements stays inert,
--                           and is intentionally excluded).
--   2. RLS                — Realtime only delivers rows the subscriber can
--                           SELECT; the 0001 active-member policies already
--                           scope every table by room and activeness, so a
--                           subscriber can never receive another room's rows.
--   3. Client channel      — the frontend subscribes with a
--                           `room_id=eq.<room>` filter (see docs/realtime.md
--                           and the client store) for one-room-only deltas.
--
-- Idempotent + local-safe: in a plain PostgreSQL instance there is no
-- `supabase_realtime` publication, so the DO block is a no-op there; on
-- Supabase it adds any missing tables without erroring on re-runs.
-- ============================================================================

begin;

do $$
declare
    v_pub_exists boolean;
    v_rec        record;
    v_table      text;
begin
    select exists(select 1 from pg_publication where pubname = 'supabase_realtime')
      into v_pub_exists;

    if v_pub_exists then
        foreach v_table in array
            array['public.rooms', 'public.members', 'public.purchases', 'public.egg_usage']
        loop
            if not exists (
                select 1 from pg_publication_tables
                where pubname = 'supabase_realtime'
                  and schemaname || '.' || tablename = v_table
            ) then
                execute format('alter publication supabase_realtime add table %s', v_table);
            end if;
        end loop;
    end if;
end $$;

commit;
-- ============================================================================