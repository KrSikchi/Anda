-- ============================================================================
-- Anda — migration 0007/0008/0009 test suite (LOCAL ONLY)
-- ----------------------------------------------------------------------------
-- Run after: local_auth_stub.sql and migrations 0001..0009
--   psql -X -d <db> -f supabase/tests/identity_settlement.sql
--
-- Covers the three migrations added by the UI/UX migration:
--
--   0008 purchase unit price  unit price is the authoritative input and is
--                             stored in integer paise; the total is derived;
--                             liability is returned in paise; is_host exposed
--   0007 identity recovery    my_memberships() returns only the caller's own
--                             active memberships in active rooms
--   0009 settlements          record_settlement enforces membership, same-room
--                             counterparty, positive amount and the
--                             no-more-than-owed cap; settlements are immutable
--                             and appear in room_history
--
-- Fixture:
--   'Settle Flat'  — host H (…a1), Sam (…a2)
--   'Other Flat'   — F (…a3), a device with no relationship to Settle Flat
--   host buys 10 eggs @ 700 paise (₹7.00) → inventory 10
--   Sam eats 4                            → inventory 6, liability 4 × 700
--                                           = 2800 paise (₹28.00)
-- ============================================================================
\set ON_ERROR_STOP off

create or replace function public.vtest(cond boolean, label text) returns void
language plpgsql
as $$
begin
    if cond then
        raise notice 'PASS: %', label;
    else
        raise warning 'FAIL: %', label;
    end if;
end $$;

create table if not exists public.anda_test_state (k text primary key, v text);
truncate public.anda_test_state;

-- ---------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-0000000000a1', false);

do $$
declare v_room uuid; v_mem uuid;
begin
    select r.room_id, r.member_id into v_room, v_mem
      from public.create_room('Settle Flat', 'Host H', 10) r;
    insert into public.anda_test_state values ('s_room', v_room::text);
    insert into public.anda_test_state values ('host_mem', v_mem::text);

    perform set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-0000000000a2', false);
    select r.member_id into v_mem
      from public.join_room((select share_code from public.rooms where id = v_room), 'Sam') r;
    insert into public.anda_test_state values ('sam_mem', v_mem::text);

    -- A separate room whose device has nothing to do with Settle Flat.
    perform set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-0000000000a3', false);
    select r.room_id, r.member_id into v_room, v_mem
      from public.create_room('Other Flat', 'Foreign F', 10) r;
    insert into public.anda_test_state values ('o_room', v_room::text);
    insert into public.anda_test_state values ('foreign_mem', v_mem::text);
end $$;

-- ---------------------------------------------------------------------------
-- 0008 — unit price is the input, paise is the unit (§21, §22)
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_qty integer; v_total numeric; v_cpe numeric; v_inv integer;
begin
    select v::uuid into v_room from public.anda_test_state where k='s_room';
    perform set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-0000000000a1', false);

    select quantity, total_cost, cost_per_egg
      into v_qty, v_total, v_cpe
      from public.record_purchase(v_room, 10, 700);

    perform public.vtest(v_qty = 10, 'U1a: purchase stores the quantity');
    perform public.vtest(v_total = 70.00, 'U1b: total derived from unit price (10 × 700 paise = ₹70.00)');
    perform public.vtest(v_cpe = 7.00, 'U1c: cost_per_egg derived = 700 paise = ₹7.00');

    select inventory into v_inv from public.room_ledger(v_room) limit 1;
    perform public.vtest(v_inv = 10, 'U1d: inventory derived = 10');

    perform public.vtest(
        (select unit_price_minor from public.purchases where room_id = v_room) = 700,
        'U2: unit price persisted as integer paise');

    -- A bad backfill of historical rows would show up here.
    perform public.vtest(
        not exists (
            select 1 from public.purchases
             where total_cost <> (unit_price_minor * quantity)::numeric / 100
        ),
        'U3: every purchase total agrees with its stored unit price');

    begin
        perform public.record_purchase(v_room, 5, -1);
        perform public.vtest(false, 'U4: negative unit price rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: price per egg cannot be negative%',
                             'U4: negative unit price rejected');
    end;
end $$;

-- ---------------------------------------------------------------------------
-- 0008 — liability and outlay in paise, host flag exposed
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_liab bigint; v_purch bigint; v_host boolean; v_inv integer;
begin
    select v::uuid into v_room from public.anda_test_state where k='s_room';

    perform set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-0000000000a2', false);
    perform public.record_usage(v_room, 4);

    select liability_minor into v_liab from public.room_ledger(v_room) where display_name = 'Sam';
    perform public.vtest(v_liab = 2800, 'U5a: Sam liability = 4 × 700 = 2800 paise (₹28.00)');

    select inventory into v_inv from public.room_ledger(v_room) limit 1;
    perform public.vtest(v_inv = 6, 'U5b: inventory 10 − 4 = 6');

    select purchased_minor, is_host into v_purch, v_host
      from public.room_ledger(v_room) where display_name = 'Host H';
    perform public.vtest(v_purch = 7000, 'U6a: host outlay = 10 × 700 = 7000 paise (₹70.00)');
    perform public.vtest(v_host, 'U6b: host row flagged is_host');

    select is_host into v_host from public.room_ledger(v_room) where display_name = 'Sam';
    perform public.vtest(v_host = false, 'U6c: non-host row not flagged');
end $$;

-- ---------------------------------------------------------------------------
-- 0007 — my_memberships() scoping (§17, §44)
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_count integer; v_host_count integer; v_name text; v_members integer;
begin
    select v::uuid into v_room from public.anda_test_state where k='s_room';

    perform set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-0000000000a1', false);
    select count(*) into v_count from public.my_memberships();
    select count(*) into v_host_count from public.my_memberships() where is_host;
    select max(room_name) into v_name from public.my_memberships();
    perform public.vtest(v_count = 1, 'M1a: host sees exactly its own membership');
    perform public.vtest(v_host_count = 1, 'M1b: host membership flagged is_host');
    perform public.vtest(v_name = 'Settle Flat', 'M1c: correct room returned');

    perform set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-0000000000a2', false);
    select count(*) into v_host_count from public.my_memberships() where is_host;
    select max(member_count) into v_members from public.my_memberships();
    perform public.vtest(v_host_count = 0, 'M2a: non-host membership not flagged');
    perform public.vtest(v_members = 2, 'M2b: member_count reflects both active members');

    -- The unrelated device must not see Settle Flat at all.
    perform set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-0000000000a3', false);
    select count(*) into v_count from public.my_memberships() where room_id = v_room;
    perform public.vtest(v_count = 0, 'M3: foreign device cannot see another room');

    select count(*) into v_count from public.my_memberships();
    perform public.vtest(v_count = 1, 'M3b: foreign device sees only its own room');
end $$;

-- ---------------------------------------------------------------------------
-- 0009 — settlement validity (§29, §30)
-- ---------------------------------------------------------------------------
do $$
declare
    v_room uuid; v_host uuid; v_sam uuid; v_foreign uuid;
    v_outstanding bigint; v_settled bigint; v_amount bigint;
begin
    select v::uuid into v_room    from public.anda_test_state where k='s_room';
    select v::uuid into v_host    from public.anda_test_state where k='host_mem';
    select v::uuid into v_sam     from public.anda_test_state where k='sam_mem';
    select v::uuid into v_foreign from public.anda_test_state where k='foreign_mem';

    perform set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-0000000000a2', false);

    perform public.vtest(
        public.member_outstanding_minor(v_room, v_sam) = 2800,
        'S1: outstanding before settling = 2800 paise');

    -- A partial settlement is accepted and reduces what is owed.
    perform public.record_settlement(v_room, v_host, 1000);

    select outstanding_minor, settled_minor into v_outstanding, v_settled
      from public.room_ledger(v_room) where member_id = v_sam;
    perform public.vtest(v_outstanding = 1800, 'S2a: outstanding reduced to 1800 after settling 1000');
    perform public.vtest(v_settled = 1000, 'S2b: settled amount recorded');

    -- Amount above what is owed is refused.
    begin
        perform public.record_settlement(v_room, v_host, 99999);
        perform public.vtest(false, 'S3: settlement above the balance rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: that is more than you owe%',
                             'S3: settlement above the balance rejected');
    end;

    begin
        perform public.record_settlement(v_room, v_host, 0);
        perform public.vtest(false, 'S4: zero settlement rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: settlement must be more than zero%',
                             'S4: zero settlement rejected');
    end;

    begin
        perform public.record_settlement(v_room, v_sam, 100);
        perform public.vtest(false, 'S5: settling with yourself rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: choose a flatmate to settle with%',
                             'S5: settling with yourself rejected');
    end;

    -- Counterparty must be in the SAME room.
    begin
        perform public.record_settlement(v_room, v_foreign, 100);
        perform public.vtest(false, 'S6: cross-room counterparty rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: that member is not in this room%',
                             'S6: cross-room counterparty rejected');
    end;

    -- A device that is not a member cannot settle here at all.
    perform set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-0000000000a3', false);
    begin
        perform public.record_settlement(v_room, v_host, 100);
        perform public.vtest(false, 'S7: non-member settlement rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: not a member of this room%',
                             'S7: non-member settlement rejected');
    end;

    -- Settle the remainder.
    perform set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-0000000000a2', false);
    perform public.record_settlement(v_room, v_host, 1800);

    perform public.vtest(
        public.member_outstanding_minor(v_room, v_sam) = 0,
        'S8: fully settled → nothing outstanding');

    begin
        perform public.record_settlement(v_room, v_host, 1);
        perform public.vtest(false, 'S9: settling when nothing is owed rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: nothing left to settle%',
                             'S9: settling when nothing is owed rejected');
    end;

    -- Settlements are transactions: append-only.
    begin
        update public.settlements set amount_minor = 1 where room_id = v_room;
        perform public.vtest(false, 'S10: settlement update rejected (immutable)');
    exception when others then
        perform public.vtest(sqlerrm like '%immutable%',
                             'S10: settlement update rejected (immutable)');
    end;

    -- And they show up in the ledger history with their value.
    select amount_minor into v_amount
      from public.room_history(v_room)
     where kind = 'settlement'
     order by recorded_at desc
     limit 1;
    perform public.vtest(v_amount = 1800, 'S11: latest settlement appears in history with its amount');
end $$;

-- ---------------------------------------------------------------------------
-- Leaving and soft-deleting remove rooms from recovery (0007, §11, §44)
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_count integer;
begin
    select v::uuid into v_room from public.anda_test_state where k='s_room';

    perform set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-0000000000a2', false);
    perform public.leave_room(v_room);

    select count(*) into v_count from public.my_memberships();
    perform public.vtest(v_count = 0, 'M4: leaving removes the room from recovery');

    -- An inactive member can no longer settle.
    begin
        perform public.record_settlement(
            v_room,
            (select v::uuid from public.anda_test_state where k='host_mem'),
            100);
        perform public.vtest(false, 'M5: departed member cannot settle');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: not a member of this room%',
                             'M5: departed member cannot settle');
    end;

    -- Soft-deleted rooms are invisible to everyone, including the host.
    perform set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-0000000000a1', false);
    perform public.soft_delete_room(v_room);
    select count(*) into v_count from public.my_memberships();
    perform public.vtest(v_count = 0, 'M6: soft-deleted room disappears from recovery');

    -- The rows themselves are preserved (soft delete, never destroy — §6).
    perform public.vtest(
        (select count(*) from public.settlements where room_id = v_room) = 2,
        'M7: settlement history preserved after soft delete');
end $$;

-- ============================================================================
-- End of suite.
-- ============================================================================
