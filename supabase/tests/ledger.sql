-- ============================================================================
-- Anda — Phase 4 ledger test suite (LOCAL ONLY)
-- ----------------------------------------------------------------------------
-- Run after: local_auth_stub.sql, 0001, 0002, 0003
--   psql -X -d <db> -f supabase/tests/ledger.sql
--
-- Covers the PRD §27 inventory rows at the RPC boundary:
--   purchase increases inventory / usage decreases it / inventory derived /
--   never negative / corrections produce correct effective totals /
--   FIFO liability determinism / member attribution / write-denial for
--   non-members and inactive members / cross-room isolation / history.
--
-- Fixture numbers (see migration 0003 header for the design):
--   purchases: 30 eggs @ ₹8 (total 240), 12 eggs @ ₹5 (total 60)   → 42 eggs
--   usage H4, J12(corrected→2), S6, S25, Y5(corrected→3), Z2(leaves)
--   effective usage totals: H4 J2 S31 Y3 Z2 → 42 → inventory 0
--   FIFO liability (batch1 30 @ 8, batch2 12 @ 5):
--     H 4×8=32   J 2×8=16   Y 3×8=24   Z 2×8=16   S 19×8 + 12×5 = 212
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

-- Devices: L1 host ...a1, Jaya ...a2, Sam ...a3, Yuki ...a4, Zoe ...a5,
--           Wren(host Beta) ...a6, Xavier(foreign) ...a7
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a1', false);

do $$
declare v_room uuid; v_mem uuid;
begin
    select r.room_id, r.member_id into v_room, v_mem
    from public.create_room('Ledger Flat', 'Host L', 10) r;
    insert into public.anda_test_state values ('ledger_room', v_room::text);
    insert into public.anda_test_state values ('host_mem', v_mem::text);

    -- Jaya joins with the room code
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a2', false);
    select r.member_id into v_mem from public.join_room((select share_code from public.rooms where id = v_room), 'Jaya') r;
    insert into public.anda_test_state values ('jaya_mem', v_mem::text);

    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a3', false);
    select r.member_id into v_mem from public.join_room((select share_code from public.rooms where id = v_room), 'Sam') r;
    insert into public.anda_test_state values ('sam_mem', v_mem::text);

    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a4', false);
    select r.member_id into v_mem from public.join_room((select share_code from public.rooms where id = v_room), 'Yuki') r;
    insert into public.anda_test_state values ('yuki_mem', v_mem::text);

    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a5', false);
    select r.member_id into v_mem from public.join_room((select share_code from public.rooms where id = v_room), 'Zoe') r;
    insert into public.anda_test_state values ('zoe_mem', v_mem::text);
end $$;

select public.vtest((select v from public.anda_test_state where k='ledger_room') is not null,
    'T0b: ledger room ready');

-- ---------------------------------------------------------------------------
-- PURCHASES (§8)
-- NOTE (test determinism): each ledger event gets its own psql DO block so
-- `recorded_at` (= now(), transaction start) is strictly increasing. Sharing
-- one block would give events an identical timestamp and FIFO would fall to
-- the uuid tiebreak — a nondeterministic fixture. The production order key
-- stays (recorded_at, id).
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_qty integer; v_cpe numeric; v_inv_after integer;
begin
    select v::uuid into v_room from public.anda_test_state where k='ledger_room';
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a1', false);

    -- P1: 30 @ 240 → ₹8/egg (own transaction → own timestamp)
    select r.quantity, r.cost_per_egg into v_qty, v_cpe
    from public.record_purchase(v_room, 30, 240) r;
    perform public.vtest(v_qty = 30, 'T1a: purchase P1 quantity 30');
    perform public.vtest(v_cpe = 8.0, 'T1b: P1 cost_per_egg derived = 240/30 = 8');

    select inventory into v_inv_after from public.room_ledger(v_room) limit 1;
    perform public.vtest(v_inv_after = 30, 'T1c: inventory 30 after P1 (derived)');
end $$;

do $$
declare v_room uuid; v_qty integer; v_cpe numeric; v_inv_after integer;
begin
    select v::uuid into v_room from public.anda_test_state where k='ledger_room';
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a1', false);

    -- P2: 12 @ 60 → ₹5/egg, price changed since last purchase (own transaction)
    select r.quantity, r.cost_per_egg into v_qty, v_cpe
    from public.record_purchase(v_room, 12, 60) r;
    perform public.vtest(v_qty = 12 and v_cpe = 5.0, 'T1d: P2 keeps its own price (60/12 = 5)');

    select inventory into v_inv_after from public.room_ledger(v_room) limit 1;
    perform public.vtest(v_inv_after = 42, 'T1e: inventory 42 after both purchases');

    -- validation
    begin
        perform public.record_purchase(v_room, 0, 10);
        perform public.vtest(false, 'T1f: purchase quantity 0 rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: quantity must be a positive number%', 'T1f: purchase quantity 0 rejected');
    end;
    begin
        perform public.record_purchase(v_room, 10, -2);
        perform public.vtest(false, 'T1g: negative total cost rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: total cost cannot be negative%', 'T1g: negative total cost rejected');
    end;
end $$;

-- ---------------------------------------------------------------------------
-- USAGE (§9) — inventory decreases; derived at each step.
-- Each consumption event in its own transaction → strictly increasing
-- recorded_at → deterministic FIFO ordering for later assertions.
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_inv integer;
begin
    select v::uuid into v_room from public.anda_test_state where k='ledger_room';
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a1', false);
    perform public.record_usage(v_room, 4);                       -- H 4
    select inventory into v_inv from public.room_ledger(v_room) limit 1;
    perform public.vtest(v_inv = 38, 'T2a: usage 4 → inventory 38');
end $$;

do $$
declare v_room uuid; v_inv integer;
begin
    select v::uuid into v_room from public.anda_test_state where k='ledger_room';
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a2', false);
    perform public.record_usage(v_room, 12);                      -- J 12
    select inventory into v_inv from public.room_ledger(v_room) limit 1;
    perform public.vtest(v_inv = 26, 'T2b: usage 12 → inventory 26');
end $$;

do $$
declare v_room uuid; v_inv integer;
begin
    select v::uuid into v_room from public.anda_test_state where k='ledger_room';
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a3', false);
    perform public.record_usage(v_room, 6);                       -- S 6
    select inventory into v_inv from public.room_ledger(v_room) limit 1;
    perform public.vtest(v_inv = 20, 'T2c: usage 6 → inventory 20');

    -- T3: inventory always = Σpurchases − Σusage (derived, never stored)
    perform public.vtest(
        (select coalesce(sum(quantity),0) from public.purchases where room_id = v_room)
        - (select coalesce(sum(quantity),0) from public.egg_usage where room_id = v_room)
        = 20,
        'T3: inventory = Σpurchases − Σusage = 42 − 22 = 20 (direct sums)');
end $$;

-- ---------------------------------------------------------------------------
-- CORRECTIONS (§10, D14/D15): compensating negative transaction
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_use uuid; v_qty integer; v_corr uuid; v_inv integer; v_cons integer;
begin
    select v::uuid into v_room from public.anda_test_state where k='ledger_room';

    -- J recorded 12, intends 2 → correction −10
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a2', false);
    select id into v_use from public.egg_usage
    where room_id = v_room and member_id = (select v::uuid from public.anda_test_state where k='jaya_mem') and correction_of is null;

    select r.quantity, r.correction_of into v_qty, v_corr
    from public.correct_usage(v_room, v_use, 2) r;
    perform public.vtest(v_qty = -10, 'T4a: compensation is the negative −10 (2 − 12)');
    perform public.vtest(v_corr = v_use, 'T4b: correction links to the original usage');

    select inventory into v_inv from public.room_ledger(v_room) limit 1;
    perform public.vtest(v_inv = 30, 'T4c: correction restores 10 eggs → inventory 30 (42 − 12)');

    select consumed into v_cons from public.room_ledger(v_room)
    where display_name = 'Jaya';
    perform public.vtest(v_cons = 2, 'T4d: Jaya effective consumption is 2 (12 − 10), attributed to the original recorder');

    -- original is untouched (immutability)
    select quantity into v_qty from public.egg_usage where id = v_use;
    perform public.vtest(v_qty = 12, 'T4e: original usage row is NOT edited (immutable)');
end $$;

-- ---------------------------------------------------------------------------
-- FIFO LIABILITY (§8, D16) — deterministic costing across batches
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_h numeric; v_j numeric; v_s numeric; v_inv integer; v_total numeric;
begin
    select v::uuid into v_room from public.anda_test_state where k='ledger_room';
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a1', false);

    select liability into v_h from public.room_ledger(v_room) where display_name = 'Host L';
    select liability into v_j from public.room_ledger(v_room) where display_name = 'Jaya';
    select liability into v_s from public.room_ledger(v_room) where display_name = 'Sam';
    perform public.vtest(v_h = 32.00, 'T5a: Host L liability = 4 × ₹8 = 32.00');
    perform public.vtest(v_j = 16.00, 'T5b: Jaya liability = 2 × ₹8 = 16.00');
    perform public.vtest(v_s = 48.00, 'T5c: Sam liability = 6 × ₹8 = 48.00 (batch 1 still covers all)');

    -- cross into batch 2: Sam uses 25 more → effective 31
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a3', false);
    perform public.record_usage(v_room, 25);
    select inventory into v_inv from public.room_ledger(v_room) limit 1;
    perform public.vtest(v_inv = 5, 'T5d: after Sam +25 → inventory 5');

    select liability into v_s from public.room_ledger(v_room) where display_name = 'Sam';
    perform public.vtest(v_s = 227.00, 'T5e: Sam = 24×8 + 7×5 = 192 + 35 = 227.00');
    select liability into v_j from public.room_ledger(v_room) where display_name = 'Jaya';
    select liability into v_h from public.room_ledger(v_room) where display_name = 'Host L';
    select sum(liability) into v_total from public.room_ledger(v_room);
    perform public.vtest(
        v_total = 30*8 + 7*5,
        'T5f: total liability = batch1(30×8) + batch2(7×5) = 275.00 — deterministic FIFO sum');
end $$;

-- ---------------------------------------------------------------------------
-- NEGATIVE INVENTORY (§11): usage rejected when it would cross below 0
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_inv integer;
begin
    select v::uuid into v_room from public.anda_test_state where k='ledger_room';
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a4', false);

    -- 5 remain; 6 must be rejected with a friendly message
    begin
        perform public.record_usage(v_room, 6);
        perform public.vtest(false, 'T6a: over-usage rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: not enough eggs remaining (5)%', 'T6a: over-usage rejected');
    end;

    select inventory into v_inv from public.room_ledger(v_room) limit 1;
    perform public.vtest(v_inv = 5, 'T6b: inventory unchanged at 5 after rejection');

    -- exactly 5 is allowed → 0
    perform public.record_usage(v_room, 5);
    select inventory into v_inv from public.room_ledger(v_room) limit 1;
    perform public.vtest(v_inv = 0, 'T6c: using exactly all 5 → inventory 0');

    -- 1 more must be rejected (0 left)
    begin
        perform public.record_usage(v_room, 1);
        perform public.vtest(false, 'T6d: usage at zero inventory rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: not enough eggs remaining (0)%', 'T6d: usage at zero inventory rejected');
    end;
end $$;

-- ---------------------------------------------------------------------------
-- CORRECTION VALIDATION (§10)
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_yuse uuid; v_corr uuid;
begin
    select v::uuid into v_room from public.anda_test_state where k='ledger_room';
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a4', false);

    -- Yuki's usage (5, drove stock to 0)
    select u.id into v_yuse from public.egg_usage u
    where u.room_id = v_room and u.member_id = (select v::uuid from public.anda_test_state where k='yuki_mem')
      and u.correction_of is null and u.quantity = 5;

    begin
        perform public.correct_usage(v_room, v_yuse, 7);
        perform public.vtest(false, 'T7a: correcting upward rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: corrected amount must be smaller than the recorded amount%', 'T7a: correcting upward rejected');
    end;
    begin
        perform public.correct_usage(v_room, v_yuse, 5);
        perform public.vtest(false, 'T7b: correcting to the same amount rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: corrected amount is the same as the recorded amount%', 'T7b: correcting to the same amount rejected');
    end;
    begin
        perform public.correct_usage(v_room, v_yuse, -1);
        perform public.vtest(false, 'T7c: negative corrected amount rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: corrected amount cannot be negative%', 'T7c: negative corrected amount rejected');
    end;
    begin
        perform public.correct_usage(v_room, gen_random_uuid(), 1);
        perform public.vtest(false, 'T7d: unknown usage rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: usage not found in this room%', 'T7d: unknown usage rejected');
    end;

    -- valid correction: 5 → 3 (adds 2 back)
    select r.id into v_corr from public.correct_usage(v_room, v_yuse, 3) r;
    perform public.vtest(v_corr is not null, 'T7e: valid correction accepted (5 → 3)');

    -- double correction rejected (unique index + friendly message)
    begin
        perform public.correct_usage(v_room, v_yuse, 1);
        perform public.vtest(false, 'T7f: second correction rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: that entry has already been corrected%', 'T7f: second correction rejected');
    end;
end $$;

-- ---------------------------------------------------------------------------
-- FIFO cross-check after Yuki correction (§8/D16: recompute, not overwrite)
-- effective now: consumption events in time: H4 (t1), J12→2 (t2), S6 (t3),
-- S25 (t4), Y5→3 (t5)   batches: B1 30 @ 8, B2 12 @ 5
--   H [0,4)→B1   J [4,6)→B1   S [6,37)→B1[6,30) + B2[30,37)   Y [37,40)→B2
--   → H 32, J 16, S 24×8 + 7×5 = 227, Y 3×5 = 15; total 290 = 30×8 + 10×5
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_y numeric; v_s numeric;
begin
    select v::uuid into v_room from public.anda_test_state where k='ledger_room';
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a1', false);
    select liability into v_y from public.room_ledger(v_room) where display_name = 'Yuki';
    select liability into v_s from public.room_ledger(v_room) where display_name = 'Sam';
    -- Yuki's eggs come from batch 2 AFTER Sam's event drained batch 1
    perform public.vtest(v_y = 15.00, 'T8a: Yuki liability = 3 × ₹5 = 15.00 (batch 2, after Sam)');
    perform public.vtest(v_s = 227.00, 'T8b: Sam liability = 24 × ₹8 + 7 × ₹5 = 227.00');
end $$;

-- ---------------------------------------------------------------------------
-- DEPARTED MEMBER: history preserved, historical representation (§3, §6)
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid;
begin
    select v::uuid into v_room from public.anda_test_state where k='ledger_room';
    -- Zoe uses 2 (stock 2 → 0), then leaves
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a5', false);
    perform public.record_usage(v_room, 2);
    perform public.leave_room(v_room);
end $$;

-- As Host L (active member): verify the departed member's historical representation
do $$
declare v_room uuid; v_cons integer; v_act boolean; v_inv integer; v_z numeric; v_s numeric;
begin
    select v::uuid into v_room from public.anda_test_state where k='ledger_room';
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a1', false);

    select consumed, is_active into v_cons, v_act
    from public.room_ledger(v_room) where display_name = 'Zoe';
    perform public.vtest(v_cons = 2 and v_act = false, 'T9a: departed member remains in ledger (consumed 2, inactive)');

    select inventory into v_inv from public.room_ledger(v_room) limit 1;
    perform public.vtest(v_inv = 0, 'T9b: inventory 0 (42 − 42 all consumed)');

    -- Final FIFO: events H4(t1) J2(t2) S6(t3) S25(t4) Y3(t5) Z2(t6);
    -- B1 (30@8): H4+J2+S6+S18 → S has 24 from B1; B2 (12@5): S7+Y3+Z2
    select liability into v_z from public.room_ledger(v_room) where display_name = 'Zoe';
    select liability into v_s from public.room_ledger(v_room) where display_name = 'Sam';
    -- chronological events: … S25 (t4) drains B1 then takes 7 from B2; Y3 (t5),
    -- Z2 (t6) take the remaining B2 eggs at ₹5 → S stays 227.00, Z = 10.00
    perform public.vtest(v_z = 10.00, 'T9c: Zoe liability = 2 × ₹5 = 10.00 (batch 2, after Sam/Yuki)');
    perform public.vtest(v_s = 227.00, 'T9d: Sam liability = 24 × ₹8 + 7 × ₹5 = 227.00');
end $$;

-- As Zoe (now inactive): writes are rejected (§6)
do $$
declare v_room uuid;
begin
    select v::uuid into v_room from public.anda_test_state where k='ledger_room';
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a5', false);
    begin
        perform public.record_usage(v_room, 1);
        perform public.vtest(false, 'T9e: inactive member cannot record usage');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: not a member of this room%', 'T9e: inactive member cannot record usage');
    end;
end $$;

-- ---------------------------------------------------------------------------
-- WRITE DENIAL: non-member / cross-room (§5)
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_beta uuid; v_dummy uuid;
begin
    select v::uuid into v_room from public.anda_test_state where k='ledger_room';

    -- Device W (not a member here) cannot purchase or use
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a6', false);
    begin
        perform public.record_purchase(v_room, 10, 80);
        perform public.vtest(false, 'T10a: non-member purchase rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: not a member of this room%', 'T10a: non-member purchase rejected');
    end;
    begin
        perform public.record_usage(v_room, 1);
        perform public.vtest(false, 'T10b: non-member usage rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: not a member of this room%', 'T10b: non-member usage rejected');
    end;
    begin
        perform public.correct_usage(v_room, gen_random_uuid(), 1);
        perform public.vtest(false, 'T10c: non-member correction rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: not a member of this room%', 'T10c: non-member correction rejected');
    end;
    begin
        perform public.room_ledger(v_room);
        perform public.vtest(false, 'T10d: non-member ledger read rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: not a member of this room%', 'T10d: non-member ledger read rejected');
    end;

    -- Host L cannot act on a room they don't belong to (Beta, host W)
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a6', false);
    select r.room_id into v_beta from public.create_room('Beta Flat', 'Wren', 10) r;
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a1', false);
    begin
        perform public.record_usage(v_beta, 1);
        perform public.vtest(false, 'T10e: cross-room usage rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: not a member of this room%', 'T10e: cross-room usage rejected');
    end;
end $$;

-- ---------------------------------------------------------------------------
-- HISTORY (§10, §23): merged ledger, newest first, corrections linked
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; n_pur int; n_use int; n_corr int; v_k text; v_n text;
begin
    select v::uuid into v_room from public.anda_test_state where k='ledger_room';
    perform set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-0000000000a1', false);

    select count(*) filter (where kind='purchase') into n_pur from public.room_history(v_room);
    perform public.vtest(n_pur = 2, 'T11a: history has both purchases');
    select count(*) filter (where kind='usage') into n_use from public.room_history(v_room);
    perform public.vtest(n_use = 6, 'T11b: usage entries: H4, J12, S6, S25, Y5, Z2');
    select count(*) filter (where kind='correction') into n_corr from public.room_history(v_room);
    perform public.vtest(n_corr = 2, 'T11c: corrections: J 12→2 (−10), Y 5→3 (−2)');

    -- newest first ordering + purchase detail content
    select kind into v_k from public.room_history(v_room) limit 1;
    perform public.vtest(v_k in ('usage','correction'), 'T11e: newest entry first (the last write was by Zoe)');

    select kind into v_k from public.room_history(v_room)
    where kind = 'correction' limit 1;
    perform public.vtest(v_k = 'correction', 'T11f: corrections appear as their own kind');

    -- purchase detail includes derived per-egg price (historical, per batch)
    select detail into v_n from public.room_history(v_room)
    where kind = 'purchase' and quantity = 30;
    perform public.vtest(v_n like '%8.00 per egg%', 'T11g: P1 history shows 8.00 per egg');

    -- departed member's name still shown
    perform public.vtest(
        (select count(*) from public.room_history(v_room) where member_name = 'Zoe' and quantity = 2) = 1,
        'T11h: departed member''s entries remain visible with their name');
end $$;

select set_config('request.jwt.claim.sub', '', false);
select '=== Anda — ledger validation complete ===' as phase;
-- ============================================================================