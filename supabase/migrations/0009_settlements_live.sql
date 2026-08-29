-- ============================================================================
-- Anda — Settlements become a real recorded transaction
-- Migration 0009
--
-- Why
-- ---
-- PRD §29: "Settlement is visually included in the MVP… ensure it does not
-- become a fake timer/demo." PRD §30 fixes the pipeline:
--
--     current balance -> settlement action -> settlement transaction
--                    -> updated balance -> activity entry
--
-- PRD §46 lets the *mathematics* stay provisional, and PRD §45 requires the
-- calculation to sit behind a boundary the UI consumes. This migration
-- supplies the transaction half of that pipeline — the part the database can
-- state honestly — and nothing more.
--
-- What "settlement" means here (kept deliberately small)
-- ------------------------------------------------------
-- A settlement records that one member has covered an amount of their egg
-- liability. It is a record of something that happened between flatmates.
-- There is no payment processing (§30), no transfer through Anda, no
-- counterparty netting engine, and no multi-member optimisation.
--
-- The counterparty is supplied by the caller and stored as-is (settlements
-- already has from_member_id / to_member_id from 0001 D7). Choosing WHICH
-- flatmate to settle with is a product decision the PRD leaves open, so it is
-- isolated in the client's finance boundary (web/src/lib/anda/finance.ts) and
-- can be changed without another migration. This function only enforces the
-- invariants that are true regardless of that choice:
--   - the caller is an active member of an active room
--   - both sides belong to the same room
--   - the amount is positive and no greater than what the member owes
--
-- Deliberately NOT here
-- ---------------------
--   - settling on behalf of another member
--   - editing or deleting a settlement (they are transactions)
--   - liability recomputation / netting across members
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Integer paise for settlements, matching purchases (0008, PRD §22).
--    `amount` is retained for any historical row and kept in sync going
--    forward; `amount_minor` is authoritative.
-- ---------------------------------------------------------------------------
alter table public.settlements add column if not exists amount_minor bigint;

update public.settlements
   set amount_minor = round(amount * 100)::bigint
 where amount_minor is null and amount is not null;

alter table public.settlements
    add constraint chk_settlements_amount_minor
    check (amount_minor is null or amount_minor > 0);

comment on column public.settlements.amount_minor is
    'Settled amount in integer paise (PRD §22). Authoritative; amount mirrors it.';

-- Settlements are transactions: append-only, exactly like the ledger (0001 D5).
drop trigger if exists trg_settlements_append_only on public.settlements;
create trigger trg_settlements_append_only before update or delete on public.settlements
    for each row execute function public.prevent_ledger_mutation();

-- ---------------------------------------------------------------------------
-- 2. Outstanding liability helper, so the cap and the UI agree on one number.
--    One member's share of FIFO-costed consumption (0003 D15/D16) minus
--    whatever they have already settled. Never negative.
-- ---------------------------------------------------------------------------
create or replace function public.member_outstanding_minor(
    p_room_id   uuid,
    p_member_id uuid
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
    with ledger as (
        select l.liability_minor
          from public.room_ledger(p_room_id) l
         where l.member_id = p_member_id
    )
    select greatest(
        coalesce((select liability_minor from ledger), 0)
      - coalesce((select sum(s.amount_minor)
                    from public.settlements s
                   where s.room_id = p_room_id
                     and s.from_member_id = p_member_id), 0),
        0)::bigint;
$$;

revoke all on function public.member_outstanding_minor(uuid, uuid) from public;
revoke all on function public.member_outstanding_minor(uuid, uuid) from anon;
grant execute on function public.member_outstanding_minor(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. record_settlement: the settlement transaction (PRD §30).
-- ---------------------------------------------------------------------------
create or replace function public.record_settlement(
    p_room_id       uuid,
    p_to_member_id  uuid,
    p_amount_minor  bigint
)
returns table (id uuid, room_id uuid, from_member_id uuid, to_member_id uuid,
               amount_minor bigint, status text, recorded_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_from     uuid := public.current_member_id(p_room_id);
    v_owed     bigint;
    v_row      record;
begin
    if v_from is null then
        raise exception 'Anda: not a member of this room';
    end if;

    -- Both sides must be active members of THIS room. Server-side, never
    -- trusting the browser with room or membership identity (0001 D6, §42).
    if not exists (
        select 1 from public.members m
         where m.room_id = p_room_id
           and m.id = p_to_member_id
           and m.is_active
    ) then
        raise exception 'Anda: that member is not in this room';
    end if;

    if p_to_member_id = v_from then
        raise exception 'Anda: choose a flatmate to settle with';
    end if;

    if p_amount_minor is null or p_amount_minor <= 0 then
        raise exception 'Anda: settlement must be more than zero';
    end if;

    v_owed := public.member_outstanding_minor(p_room_id, v_from);

    if v_owed = 0 then
        raise exception 'Anda: nothing left to settle';
    end if;

    if p_amount_minor > v_owed then
        raise exception 'Anda: that is more than you owe';
    end if;

    -- Serialize with the rest of the room's activity, as purchases/usage do
    -- (0004 D19): settlements and stock mutations share the room row lock.
    perform 1 from public.rooms r where r.id = p_room_id for update;

    with ins as (
        insert into public.settlements
            (room_id, from_member_id, to_member_id, amount_minor, amount, status)
        values (p_room_id, v_from, p_to_member_id, p_amount_minor,
                p_amount_minor::numeric / 100, 'recorded')
        returning *
    )
    select * into v_row from ins;

    return query select v_row.id, v_row.room_id, v_row.from_member_id,
                        v_row.to_member_id, v_row.amount_minor, v_row.status,
                        v_row.recorded_at;
end $$;

revoke all on function public.record_settlement(uuid, uuid, bigint) from public;
revoke all on function public.record_settlement(uuid, uuid, bigint) from anon;
grant execute on function public.record_settlement(uuid, uuid, bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. room_ledger: expose what each member has already settled, so the Account
--    screen reads balances from one room-scoped call (PRD §45, §52).
-- ---------------------------------------------------------------------------
-- Return shape changed vs 0008 (purchased/settled/outstanding_minor added).
-- CREATE OR REPLACE cannot change a return type, so drop first.
drop function if exists public.room_ledger(uuid);

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
    purchased_minor     bigint,
    liability_minor     bigint,
    settled_minor       bigint,
    outstanding_minor   bigint
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
    ),
    settled as (
        select s.from_member_id as member_id,
               sum(s.amount_minor)::bigint as total
          from public.settlements s
         where s.room_id = p_room_id
         group by s.from_member_id
    ),
    -- Outlay: what each member actually paid at the shop. Used only to decide
    -- WHICH flatmate a settlement is recorded against (the person who fronted
    -- the egg money). This is a presentation-level choice, not part of the
    -- liability maths, and lives behind the client's finance boundary (§45).
    purch as (
        select p.member_id,
               sum(p.unit_price_minor * p.quantity)::bigint as total
          from public.purchases p
         where p.room_id = p_room_id
         group by p.member_id
    )
    select p_room_id, v_name, v_inv, v_thr, v_not,
           mm.id, mm.display_name, mm.is_active,
           (mm.id = (select ro.host_member_id from public.rooms ro where ro.id = p_room_id)) as is_host,
           coalesce((select sum(x.eff) from events x where x.member_id = mm.id), 0)::integer as consumed,
           coalesce(pu.total, 0)::bigint as purchased_minor,
           coalesce(al.liability, 0)::bigint as liability_minor,
           coalesce(st.total, 0)::bigint as settled_minor,
           greatest(coalesce(al.liability, 0) - coalesce(st.total, 0), 0)::bigint as outstanding_minor
    from public.members mm
    left join alloc al on al.member_id = mm.id
    left join settled st on st.member_id = mm.id
    left join purch  pu on pu.member_id = mm.id
    where mm.room_id = p_room_id
    order by mm.display_name;
end $$;

revoke all on function public.room_ledger(uuid) from public;
revoke all on function public.room_ledger(uuid) from anon;
grant execute on function public.room_ledger(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. room_history: settlements appear in Activity (PRD §26, §30).
-- ---------------------------------------------------------------------------
-- Return shape changed vs 0008 (amount_minor added). CREATE OR REPLACE
-- cannot change a return type, so drop first.
drop function if exists public.room_history(uuid);

create or replace function public.room_history(p_room_id uuid)
returns table (
    entry_id      uuid,
    kind          text,
    recorded_at   timestamptz,
    quantity      integer,
    member_id     uuid,
    member_name   text,
    correction_of uuid,
    detail        text,
    amount_minor  bigint
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
                      round(p.cost_per_egg, 2),
                      round((p.unit_price_minor * p.quantity)::numeric / 100, 2)) as detail,
               (p.unit_price_minor * p.quantity)::bigint as amount_minor
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
               case when u.correction_of is null then 'eggs used' else 'fixes earlier entry' end,
               null::bigint as amount_minor
        from public.egg_usage u
        join public.members m on m.id = u.member_id
        where u.room_id = p_room_id

        union all

        -- Settlement: recorded against the member who covered it (from_member).
        -- The counterparty is named in the detail line (PRD §25: actor,
        -- action, value, time — no invented commentary).
        select s.id,
               'settlement'::text,
               s.recorded_at,
               null::integer as quantity,
               s.from_member_id,
               fm.display_name,
               null::uuid,
               format('settled with %s', tm.display_name) as detail,
               s.amount_minor
        from public.settlements s
        join public.members fm on fm.id = s.from_member_id
        join public.members tm on tm.id = s.to_member_id
        where s.room_id = p_room_id
    )
    select h.entry_id, h.kind, h.recorded_at, h.quantity,
           h.member_id, h.member_name, h.correction_of, h.detail, h.amount_minor
    from rows h
    order by h.recorded_at desc, h.entry_id desc;
$$;

revoke all on function public.room_history(uuid) from public;
revoke all on function public.room_history(uuid) from anon;
grant execute on function public.room_history(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Realtime: settlements now change what Account shows, so connected clients
--    must hear about them (PRD §31). Room scoping is unchanged — publication,
--    RLS and the client's room_id filter (0005).
-- ---------------------------------------------------------------------------
do $$
declare
    v_pub_exists boolean;
begin
    select exists(select 1 from pg_publication where pubname = 'supabase_realtime')
      into v_pub_exists;

    if v_pub_exists then
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime'
              and schemaname || '.' || tablename = 'public.settlements'
        ) then
            alter publication supabase_realtime add table public.settlements;
        end if;
    end if;
end $$;

commit;
