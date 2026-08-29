-- ============================================================================
-- Anda — Purchase unit price & integer minor-unit money
-- Migration 0008
--
-- What changes and why
-- --------------------
-- PRD §21 is explicit: the Buy flow collects `quantity` and `price per egg`,
-- NOT `quantity` and `total price`, and must not derive a unit price by
-- dividing a user-entered total. PRD §22 adds that the authoritative money
-- representation must not be floating point and prefers integer minor units.
--
-- The shipped schema inverted that: purchases stored `total_cost numeric(10,2)`
-- and derived `cost_per_egg` from it (0001 D4). The client reinforced it by
-- asking for a total and calling record_purchase(room, qty, totalCost).
--
-- This migration makes the UNIT PRICE the stored, authoritative input and
-- keeps money in integer paise end to end:
--
--   purchases.unit_price_minor  bigint   paise per egg  (new, authoritative)
--   purchases.total_cost        numeric  derived        (kept, still exact)
--   purchases.cost_per_egg      numeric  generated      (redefined from the
--                                                        new column)
--
-- Safety (PRD §43)
-- ----------------
--   - Additive first: the column is added, backfilled, and only then made
--     NOT NULL. No row is dropped, no table is rewritten destructively.
--   - Historical pricing is preserved: every existing purchase keeps its own
--     per-egg cost, reconstructed from the total it was recorded with.
--   - `cost_per_egg` is dropped and re-added ONLY because it is a GENERATED
--     (derived) column — a drop there destroys no data, it merely recomputes
--     from a different source. This is called out because it is the one
--     `drop column` in the migration set.
--   - The old record_purchase(uuid, integer, numeric) is dropped rather than
--     overloaded: keeping both would make `record_purchase(room, 12, 600)`
--     ambiguous between integer->numeric and integer->bigint, and the old
--     signature encodes the total-first model the PRD rejects.
--
-- Rounding note
-- -------------
-- Backfill computes round(total_cost * 100 / quantity) paise per egg. When a
-- historical total did not divide evenly (e.g. ₹10 for 3 eggs), the stored
-- per-egg cost is rounded to the nearest paisa, so total_cost is preserved to
-- within a few paise and never exceeds the original by more than
-- quantity/2 paise. Deliberate: the alternative (storing a fractional paise)
-- would reintroduce a non-integer authoritative unit.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Add the authoritative unit price (paise per egg).
-- ---------------------------------------------------------------------------
alter table public.purchases add column if not exists unit_price_minor bigint;

update public.purchases
   set unit_price_minor = round(total_cost * 100 / quantity)::bigint
 where unit_price_minor is null;

alter table public.purchases alter column unit_price_minor set not null;

alter table public.purchases
    add constraint chk_purchases_unit_price check (unit_price_minor >= 0);

comment on column public.purchases.unit_price_minor is
    'Authoritative price per egg in integer paise (PRD §21/§22). total_cost is derived from it.';

-- ---------------------------------------------------------------------------
-- 2. Redefine the derived per-egg cost. GENERATED column only — no data loss.
-- ---------------------------------------------------------------------------
alter table public.purchases drop column if exists cost_per_egg;

alter table public.purchases
    add column cost_per_egg numeric
    generated always as (unit_price_minor::numeric / 100) stored;

-- ---------------------------------------------------------------------------
-- 3. record_purchase takes the unit price (paise) and derives the total.
--    Same atomicity contract as 0004 (D19): the room row is locked FOR UPDATE
--    so every stock-mutating operation for a room is totally ordered.
-- ---------------------------------------------------------------------------
drop function if exists public.record_purchase(uuid, integer, numeric);

create or replace function public.record_purchase(
    p_room_id          uuid,
    p_quantity         integer,
    p_unit_price_minor bigint
)
returns table (id uuid, room_id uuid, member_id uuid, quantity integer,
               total_cost numeric(10,2), cost_per_egg numeric, recorded_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_mid  uuid := public.current_member_id(p_room_id);
    v_row  record;
begin
    if v_mid is null then
        raise exception 'Anda: not a member of this room';
    end if;
    if p_quantity is null or p_quantity <= 0 then
        raise exception 'Anda: quantity must be a positive number';
    end if;
    if p_unit_price_minor is null or p_unit_price_minor < 0 then
        raise exception 'Anda: price per egg cannot be negative';
    end if;

    -- D19: serialize with usage/correction on the room row (see 0004).
    perform 1 from public.rooms r where r.id = p_room_id for update;

    with ins as (
        insert into public.purchases (room_id, member_id, quantity, unit_price_minor, total_cost)
        values (p_room_id, v_mid, p_quantity, p_unit_price_minor,
                (p_unit_price_minor * p_quantity)::numeric / 100)
        returning *
    )
    select * into v_row from ins;

    return query select v_row.id, v_row.room_id, v_row.member_id, v_row.quantity,
                        v_row.total_cost, v_row.cost_per_egg, v_row.recorded_at;
end $$;

-- ---------------------------------------------------------------------------
-- 4. room_ledger: FIFO liability in paise, plus host flag for Account (§27).
--    Liability semantics are UNCHANGED (0003 D15/D16): consumption draws from
--    the earliest batches first, attributed to the member who recorded the
--    original usage, with corrections reducing it. Only the arithmetic unit
--    changes — the interval-overlap allocation now multiplies by integer
--    paise instead of a derived numeric.
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
    is_host             boolean,
    consumed            integer,
    liability_minor     bigint
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

    -- §7: inventory = Σ purchases − Σ usage (corrections are negative usage).
    select coalesce(sum(p.quantity), 0)::integer into v_inv
    from public.purchases p where p.room_id = p_room_id;
    select coalesce(sum(u.quantity), 0)::integer into v_used
    from public.egg_usage u where u.room_id = p_room_id;
    v_inv := v_inv - v_used;

    return query
    with batches as (
        select p.quantity as qty,
               p.unit_price_minor as cost,
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
                          - greatest(ev.e_start, b.b_start), 0) * b.cost)::bigint as liability
        from events ev
        join batches b on ev.e_start < b.b_start + b.qty
                      and ev.e_start + ev.eff > b.b_start
        group by ev.member_id
    )
    select p_room_id, v_name, v_inv, v_thr, v_not,
           mm.id, mm.display_name, mm.is_active,
           (mm.id = (select ro.host_member_id from public.rooms ro where ro.id = p_room_id)) as is_host,
           coalesce((select sum(x.eff) from events x where x.member_id = mm.id), 0)::integer as consumed,
           coalesce(al.liability, 0)::bigint as liability_minor
    from public.members mm
    left join alloc al on al.member_id = mm.id
    where mm.room_id = p_room_id
    order by mm.display_name;
end $$;

-- ---------------------------------------------------------------------------
-- 5. room_history: report the unit price the purchase was actually made at.
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
               format('%s per egg · %s total',
                      p.cost_per_egg,
                      (p.unit_price_minor * p.quantity)::numeric / 100) as detail
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
-- 6. Grants — same explicit deny-then-grant discipline as the other RPCs.
-- ---------------------------------------------------------------------------
revoke all on function public.record_purchase(uuid, integer, bigint) from public;
revoke all on function public.record_purchase(uuid, integer, bigint) from anon;
grant execute on function public.record_purchase(uuid, integer, bigint) to authenticated;

revoke all on function public.room_ledger(uuid)  from public;
revoke all on function public.room_ledger(uuid)  from anon;
grant execute on function public.room_ledger(uuid) to authenticated;

revoke all on function public.room_history(uuid) from public;
revoke all on function public.room_history(uuid) from anon;
grant execute on function public.room_history(uuid) to authenticated;

commit;
