-- ============================================================================
-- Anda — Atomicity (PRD Phase 5)
-- Migration 0004
--
-- Phase 5 is the PRD's dedicated atomicity gate (§11, §27 "Concurrency tests"):
--   - verify, under real concurrent connections, that usage can never drive
--     authoritative inventory negative, and that the canonical race
--     (inventory 2; two simultaneous "use 2" requests) admits exactly one.
--   - hardening discovered there is applied here — as one small, documented
--     change (D19 below). The core check-and-write mechanism (D13) is
--     unchanged and was already shipped in 0003.
--
-- Hardening (D19):
--   record_purchase now also takes the room-row FOR UPDATE lock, so EVERY
--   stock-mutating operation for a room (purchase, usage, correction) is
--   totally serialized on rooms.id (= all events for one room are totally
--   ordered). Consequence: a concurrent purchase commits either BEFORE a
--   usage's availability sums (visible → more stock, therefore the check is
--   conservative-correct) or AFTER the usage commits (unneeded). A usage is
--   never falsely rejected by an in-flight purchase, and the availability
--   check always runs against the latest committed pool.
--
-- Verified by tests/atomicity_*.sql driven with pgbench (multi-connection):
--   Race A  stock 2,  2× "use 2"          → exactly 1 succeeds (PRD §11 example)
--   Race B  stock 0, 50× "use 1"          → all 50 rejected
--   Race C  50 concurrent purchases       → all succeed, Σ = discount exact
--   Race D  stock 24, 300× "use 1"        → exactly 24 succeed
--   Race E  concurrent purchases + usages → Σp − Σu = inventory ≥ 0; Σu ≤ Σp
--   Race F  2× concurrent correction      → exactly 1 correction applied
--
-- Error catalog unchanged (0003). No schema changes; only the function body.
-- ============================================================================

begin;

create or replace function public.record_purchase(
    p_room_id    uuid,
    p_quantity   integer,
    p_total_cost numeric
)
returns table (id uuid, room_id uuid, member_id uuid, quantity integer,
               total_cost numeric(10,2), cost_per_egg numeric, recorded_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_mid uuid := public.current_member_id(p_room_id);
    v_row record;
begin
    if v_mid is null then
        raise exception 'Anda: not a member of this room';
    end if;
    if p_quantity is null or p_quantity <= 0 then
        raise exception 'Anda: quantity must be a positive number';
    end if;
    if p_total_cost is null or p_total_cost < 0 then
        raise exception 'Anda: total cost cannot be negative';
    end if;

    -- D19: serialize with usage/correction on the room row (see header).
    perform 1 from public.rooms r where r.id = p_room_id for update;

    with ins as (
        insert into public.purchases (room_id, member_id, quantity, total_cost)
        values (p_room_id, v_mid, p_quantity, p_total_cost)
        returning *
    )
    select * into v_row from ins;

    return query select v_row.id, v_row.room_id, v_row.member_id, v_row.quantity,
                        v_row.total_cost, v_row.cost_per_egg, v_row.recorded_at;
end $$;

commit;
-- ============================================================================