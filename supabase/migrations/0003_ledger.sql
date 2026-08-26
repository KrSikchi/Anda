-- ============================================================================
-- Anda — Transactional ledger (PRD Phase 4)
-- Migration 0003
--
-- Implements (binding PRD):
--   §7  Transactional ledger — purchases and usage are append-only events;
--       inventory is derived (Σ purchases − Σ effective usage), never a counter.
--   §8  Purchases    — quantity, total_cost, derived cost_per_egg (generated in
--       0001), historical pricing preserved; deterministic inventory-costing
--       (FIFO) for liability.
--   §9  Usage        — immutable consumption event bound to the acting member.
--   §10 Corrections  — compensating negative transaction linked to the original;
--       original is never edited; history stays auditable.
--   §11 Inventory integrity — server-side, atomic check-and-write; usage that
--       would drive authoritative inventory negative is rejected.
--   §23 Core screens data (main view: inventory + per-member consumption +
--       liability; history screen).
--   §24 Friendly errors ('Anda: ...'); §5 server-side validation only.
--
-- Decisions (PRD §32; smallest robust implementation of each specified outcome):
--   D13 Atomicity   record_usage serialises stock mutations on the room row
--       (SELECT … FOR UPDATE) inside the same transaction as the check and the
--       insert — the smallest atomic check-and-write satisfying §11. Phase 5
--       verifies this under real concurrency and hones the strategy if needed.
--   D14 Corrections are strictly negative debits (constraint from 0001) used to
--       fix OVER-recorded usage: correct_usage(usage, corrected_quantity) writes
--       quantity = corrected − original (< 0), linked to the original. Exactly
--       one correction per usage (partial unique index). Under-recorded usage is
--       corrected by recording the additional usage through the ordinary path
--       (the PRD defines corrections only as negative compensations, §10).
--   D15 Attribution     A correction reduces the effective consumption of the
--       member who RECORDED the original usage (the ledger groups each original
--       usage with the corrections pointing at it). This keeps liability correct
--       regardless of which member performs the correction.
--   D16 Liability      Deterministic FIFO costing: all consumption draws from the
--       earliest purchase batches first (ordered by recorded_at, id); each
--       consumed egg is priced at its batch's cost_per_egg. Historical prices are
--       never overwritten (§8). Presented per member in room_ledger.
--   D17 Read RPCs     room_ledger (main view) and room_history (history screen)
--       are the only reads needed by the MVP screens (§23).
--   D18 Name discipline  Every function here returns TABLE(...) whose OUT
--       parameters double as PL/pgSQL variables, so ALL column references
--       inside the bodies are alias-qualified and data-modifying inserts use
--       CTE `RETURNING *` — eliminating ambiguous-column resolution errors.
--
-- Error catalog (client-facing, §24):
--   Anda: not a member of this room
--   Anda: quantity must be a positive number
--   Anda: total cost cannot be negative
--   Anda: not enough eggs remaining (N)
--   Anda: usage not found in this room
--   Anda: that entry has already been corrected
--   Anda: corrected amount is the same as the recorded amount
--   Anda: corrected amount must be smaller than the recorded amount
--   Anda: corrected amount cannot be negative
-- ============================================================================

begin;

-- Only one compensating correction may ever point at a given usage (§10, D14).
create unique index uq_egg_usage_single_correction
    on public.egg_usage (correction_of)
    where correction_of is not null;

-- ---------------------------------------------------------------------------
-- record_purchase (§8): append-only purchase event
-- ---------------------------------------------------------------------------
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

    with ins as (
        insert into public.purchases (room_id, member_id, quantity, total_cost)
        values (p_room_id, v_mid, p_quantity, p_total_cost)
        returning *
    )
    select * into v_row from ins;

    return query select v_row.id, v_row.room_id, v_row.member_id, v_row.quantity,
                        v_row.total_cost, v_row.cost_per_egg, v_row.recorded_at;
end $$;

-- ---------------------------------------------------------------------------
-- record_usage (§9, §11): atomic check-and-write consumption event
-- ---------------------------------------------------------------------------
create or replace function public.record_usage(
    p_room_id  uuid,
    p_quantity integer
)
returns table (id uuid, room_id uuid, member_id uuid, quantity integer, recorded_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_mid    uuid := public.current_member_id(p_room_id);
    v_bought integer;
    v_used   integer;
    v_avail  integer;
    v_row    record;
begin
    if v_mid is null then
        raise exception 'Anda: not a member of this room';
    end if;
    if p_quantity is null or p_quantity <= 0 then
        raise exception 'Anda: quantity must be a positive number';
    end if;

    -- D13: serialize stock mutations for this room. All concurrent usage and
    -- purchase events for the room contend on this one row lock inside their
    -- own transactions; the check below therefore always runs against the
    -- latest committed ledger state (atomic check-and-write, §11).
    perform 1 from public.rooms r where r.id = p_room_id for update;

    select coalesce(sum(p.quantity), 0)::integer into v_bought
    from public.purchases p where p.room_id = p_room_id;
    select coalesce(sum(u.quantity), 0)::integer into v_used
    from public.egg_usage u where u.room_id = p_room_id;
    v_avail := v_bought - v_used;

    if v_avail - p_quantity < 0 then
        raise exception 'Anda: not enough eggs remaining (%)', v_avail;
    end if;

    with ins as (
        insert into public.egg_usage (room_id, member_id, quantity)
        values (p_room_id, v_mid, p_quantity)
        returning *
    )
    select * into v_row from ins;

    return query select v_row.id, v_row.room_id, v_row.member_id, v_row.quantity, v_row.recorded_at;
end $$;

-- ---------------------------------------------------------------------------
-- correct_usage (§10, §11): compensating negative transaction
-- ---------------------------------------------------------------------------
create or replace function public.correct_usage(
    p_room_id             uuid,
    p_usage_id            uuid,
    p_corrected_quantity  integer
)
returns table (id uuid, room_id uuid, member_id uuid, quantity integer,
               correction_of uuid, recorded_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_mid      uuid := public.current_member_id(p_room_id);
    v_orig     integer;
    v_corr_of  uuid;
    v_row      record;
begin
    if v_mid is null then
        raise exception 'Anda: not a member of this room';
    end if;
    if p_corrected_quantity is null or p_corrected_quantity < 0 then
        raise exception 'Anda: corrected amount cannot be negative';
    end if;

    select u.quantity, u.correction_of into v_orig, v_corr_of
    from public.egg_usage u
    where u.id = p_usage_id and u.room_id = p_room_id;

    if not found then
        raise exception 'Anda: usage not found in this room';
    end if;
    if v_corr_of is not null then
        raise exception 'Anda: that entry has already been corrected';
    end if;
    if p_corrected_quantity = v_orig then
        raise exception 'Anda: corrected amount is the same as the recorded amount';
    end if;
    if p_corrected_quantity > v_orig then
        raise exception 'Anda: corrected amount must be smaller than the recorded amount';
    end if;

    -- Serialise with concurrent stock mutations (D13): a correction re-adds
    -- stock, so it must not race a usage event.
    perform 1 from public.rooms r where r.id = p_room_id for update;

    begin
        with ins as (
            insert into public.egg_usage (room_id, member_id, quantity, correction_of)
            values (p_room_id, v_mid, p_corrected_quantity - v_orig, p_usage_id)
            returning *
        )
        select * into v_row from ins;
    exception when unique_violation then
        -- concurrent double-correction; friendly message (§24)
        raise exception 'Anda: that entry has already been corrected';
    end;

    return query select v_row.id, v_row.room_id, v_row.member_id, v_row.quantity,
                        v_row.correction_of, v_row.recorded_at;
end $$;

-- ---------------------------------------------------------------------------
-- room_ledger (§7, §8, §23): inventory + per-member effective consumption
-- and FIFO-costed replacement liability for the main room view
-- ---------------------------------------------------------------------------
create or replace function public.room_ledger(p_room_id uuid)
returns table (
    room_id             uuid,
    room_name           text,
    inventory           integer,
    low_stock_threshold integer,
    low_stock_notified  boolean,
    member_id           uuid,
    display_name        text,
    is_active           boolean,
    consumed            integer,
    liability           numeric(10,2)
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_mid  uuid := public.current_member_id(p_room_id);
    v_name text;
    v_thr  integer;
    v_not  boolean;
    v_inv  integer;
    v_used integer;
begin
    if v_mid is null then
        raise exception 'Anda: not a member of this room';
    end if;

    select ro.name, ro.low_stock_threshold, ro.low_stock_notified
      into v_name, v_thr, v_not
      from public.rooms ro where ro.id = p_room_id;

    -- §7: inventory = Σ purchases − Σ usage (usage includes corrections, which
    -- are negative quantities).
    select coalesce(sum(p.quantity), 0)::integer into v_inv
    from public.purchases p where p.room_id = p_room_id;
    select coalesce(sum(u.quantity), 0)::integer into v_used
    from public.egg_usage u where u.room_id = p_room_id;
    v_inv := v_inv - v_used;

    -- FIFO liability (D16): consumption events in chronological order
    -- (recorded_at, id of the original usage) draw eggs from the earliest
    -- purchase batches first. Interval-overlap allocation makes this a single
    -- deterministic SQL pass: each event's consumption interval
    -- [e_start, e_start + eff) overlaps each batch's supply interval
    -- [b_start, b_start + qty); overlap × batch cost_per_egg is the liability.
    -- Effective consumption is attributed to the member who RECORDED each
    -- original usage (D15); corrections reduce that original's effective amount.
    return query
    with batches as (
        select p.quantity as qty,
               p.cost_per_egg as cost,
               coalesce(sum(p.quantity) over (order by p.recorded_at, p.id
                          rows between unbounded preceding and 1 preceding), 0) as b_start
        from public.purchases p
        where p.room_id = p_room_id
    ),
    events as (
        select u.id,
               u.member_id,
               u.quantity + coalesce((select sum(c.quantity) from public.egg_usage c
                                      where c.correction_of = u.id), 0) as eff,
               coalesce(sum(u.quantity + coalesce((select sum(c2.quantity) from public.egg_usage c2
                                                   where c2.correction_of = u.id), 0))
                        over (order by u.recorded_at, u.id
                        rows between unbounded preceding and 1 preceding), 0) as e_start
        from public.egg_usage u
        where u.room_id = p_room_id
          and u.correction_of is null
    ),
    alloc as (
        select ev.member_id,
               sum(greatest(least(ev.e_start + ev.eff, b.b_start + b.qty)
                          - greatest(ev.e_start, b.b_start), 0) * b.cost) as liability
        from events ev
        join batches b on ev.e_start < b.b_start + b.qty
                      and ev.e_start + ev.eff > b.b_start
        group by ev.member_id
    )
    select p_room_id, v_name, v_inv, v_thr, v_not,
           mm.id, mm.display_name, mm.is_active,
           coalesce((select sum(x.eff) from events x where x.member_id = mm.id), 0)::integer as consumed,
           coalesce(round(al.liability, 2), 0) as liability
    from public.members mm
    left join alloc al on al.member_id = mm.id
    where mm.room_id = p_room_id
    order by mm.display_name;
end $$;

-- ---------------------------------------------------------------------------
-- room_history (§10, §23): merged, newest-first ledger view for the History
-- screen — makes mistaken entries and their corrections understandable.
-- ---------------------------------------------------------------------------
create or replace function public.room_history(p_room_id uuid)
returns table (
    entry_id      uuid,
    kind          text,
    recorded_at   timestamptz,
    quantity      integer,
    member_id     uuid,
    member_name   text,
    correction_of uuid,
    detail        text
)
language sql
stable
security definer
set search_path = ''
as $$
    with rows as (
        select p.id as entry_id,
               'purchase'::text as kind,
               p.recorded_at,
               p.quantity,
               p.member_id,
               m.display_name as member_name,
               null::uuid as correction_of,
               format('%s total · %s per egg', p.total_cost, round(p.cost_per_egg, 2)) as detail
        from public.purchases p
        join public.members m on m.id = p.member_id
        where p.room_id = p_room_id

        union all

        select u.id,
               case when u.correction_of is null then 'usage'::text else 'correction'::text end,
               u.recorded_at,
               u.quantity,
               u.member_id,
               m.display_name,
               u.correction_of,
               case when u.correction_of is null then 'eggs used' else 'fixes earlier entry' end
        from public.egg_usage u
        join public.members m on m.id = u.member_id
        where u.room_id = p_room_id
    )
    select h.entry_id, h.kind, h.recorded_at, h.quantity,
           h.member_id, h.member_name, h.correction_of, h.detail
    from rows h
    order by h.recorded_at desc, h.entry_id desc;
$$;

-- ---------------------------------------------------------------------------
-- Grants: the ledger RPCs are the only write path for purchases/usage and the
-- read path for the room view + history (0001 D6: no direct table access).
-- ---------------------------------------------------------------------------
revoke all on function public.record_purchase(uuid, integer, numeric) from public;
revoke all on function public.record_usage(uuid, integer)              from public;
revoke all on function public.correct_usage(uuid, uuid, integer)       from public;
revoke all on function public.room_ledger(uuid)                         from public;
revoke all on function public.room_history(uuid)                        from public;

grant execute on function public.record_purchase(uuid, integer, numeric) to authenticated;
grant execute on function public.record_usage(uuid, integer)            to authenticated;
grant execute on function public.correct_usage(uuid, uuid, integer)     to authenticated;
grant execute on function public.room_ledger(uuid)                       to authenticated;
grant execute on function public.room_history(uuid)                      to authenticated;

commit;
-- ============================================================================