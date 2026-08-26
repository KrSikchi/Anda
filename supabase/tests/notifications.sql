-- ============================================================================
-- Anda — Phase 8 notification test suite (LOCAL ONLY)
-- ----------------------------------------------------------------------------
-- Run after: local_auth_stub.sql, 0001..0006
--   psql -X -d <db> -f supabase/tests/notifications.sql
--
-- Covers the PRD §27 "Notification tests" row at the RPC + DB boundary:
--   - crossing above→at-or-below threshold → exactly one alert
--   - further decrements do not spam
--   - stock rises above threshold → flag re-armed
--   - a later crossing produces another alert
--   - push-subscription identity: device/member bound, upsert-on-endpoint,
--     owner-only RLS, non-member/inactive rejects, malformed values rejected,
--     delivery joins ACTIVE members only
--   - low_stock_alerts is private (members cannot read it)
--
-- Devices: host H = dddddddd-0000-0000-0000-0000000000d1
--          O(ther) = ...d2     F(oreign) = ...d3     I(nactive) = ...d4
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

select set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-0000000000d1', false);

-- ---------------------------------------------------------------------------
-- Fixtures: N1 (episode lifecycle), N2 (start-low), members for subscriptions
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_mem uuid;
begin
    select r.room_id into v_room from public.create_room('Notify A', 'Host H', 10) r;
    insert into public.anda_test_state values ('n1', v_room::text);

    select r.room_id into v_room from public.create_room('Notify B', 'Host H', 10) r;
    insert into public.anda_test_state values ('n2', v_room::text);

    -- O joins N1
    perform set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-0000000000d2', false);
    select v::uuid into v_room from public.anda_test_state where k='n1';
    select r.member_id into v_mem from public.join_room((select share_code from public.rooms where id=v_room), 'Other') r;
    insert into public.anda_test_state values ('o_mem', v_mem::text);

    -- I joins N1 (will leave later)
    perform set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-0000000000d4', false);
    select r.member_id into v_mem from public.join_room((select share_code from public.rooms where id=v_room), 'Inactive') r;
    insert into public.anda_test_state values ('i_mem', v_mem::text);
end $$;

select public.vtest((select v from public.anda_test_state where k='n1') is not null,
    'state ready');

-- ---------------------------------------------------------------------------
-- §16 EPISODE LIFECYCLE on N1 (threshold 10)
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; n int; inv int; flagged boolean;
begin
    perform set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-0000000000d1', false);
    select v::uuid into v_room from public.anda_test_state where k='n1';

    -- above threshold: no alert, not flagged
    perform public.record_purchase(v_room, 11, 88.00);             -- inv 11
    select count(*) into n from public.low_stock_alerts where room_id = v_room;
    select low_stock_notified into flagged from public.rooms where id = v_room;
    perform public.vtest(n = 0 and not flagged, 'N1a: 11 > threshold 10 → no alert, flag false');

    -- crossing 11 → 10: exactly one alert
    perform public.record_usage(v_room, 1);                        -- inv 10
    select count(*) into n from public.low_stock_alerts where room_id = v_room;
    select low_stock_notified into flagged from public.rooms where id = v_room;
    perform public.vtest(n = 1 and flagged, 'N1b: crossing to 10 → EXACTLY ONE alert, flag true');

    -- further decrements: no spam
    perform public.record_usage(v_room, 2);                        -- 8
    perform public.record_usage(v_room, 1);                        -- 7
    select count(*) into n from public.low_stock_alerts where room_id = v_room;
    select low_stock_notified into flagged from public.rooms where id = v_room;
    perform public.vtest(n = 1 and flagged, 'N1c: 8 then 7 → still exactly one alert (no spam)');

    -- restock above threshold: flag re-arms, no new alert
    perform public.record_purchase(v_room, 23, 184.00);            -- inv 30
    select count(*) into n from public.low_stock_alerts where room_id = v_room;
    select low_stock_notified into flagged from public.rooms where id = v_room;
    perform public.vtest(n = 1 and not flagged, 'N1d: back to 30 (>10) → flag reset, still one alert');

    -- later crossing again: a second alert
    perform public.record_usage(v_room, 20);                       -- inv 10
    select count(*) into n from public.low_stock_alerts where room_id = v_room;
    select low_stock_notified into flagged from public.rooms where id = v_room;
    perform public.vtest(n = 2 and flagged, 'N1e: second episode crossing → second alert');

    perform public.record_usage(v_room, 5);                        -- inv 5
    select count(*) into n from public.low_stock_alerts where room_id = v_room;
    perform public.vtest(n = 2, 'N1f: still low → no third alert');
end $$;

-- ---------------------------------------------------------------------------
-- §16 CORRECTION-driven re-arm on N1
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_use uuid; n int; inv int; flagged boolean;
begin
    perform set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-0000000000d1', false);
    select v::uuid into v_room from public.anda_test_state where k='n1';

    -- Correct the 20-egg usage down to 0 → adds 20 back → 25 > 10 → re-arm
    select u.id into v_use from public.egg_usage u
    where u.room_id = v_room and u.quantity = 20 and u.correction_of is null;
    perform public.correct_usage(v_room, v_use, 0);                -- inv 25

    select count(*) into n from public.low_stock_alerts where room_id = v_room;
    select low_stock_notified into flagged from public.rooms where id = v_room;
    select (coalesce((select sum(quantity) from public.purchases where room_id=v_room),0)
          - coalesce((select sum(quantity) from public.egg_usage where room_id=v_room),0)) into inv;
    perform public.vtest(inv = 25 and n = 2 and not flagged, 'N2a: correction raises to 25 → flag re-armed (no new alert)');

    -- usage to cross again → third alert
    perform public.record_usage(v_room, 15);                       -- inv 10
    select count(*) into n from public.low_stock_alerts where room_id = v_room;
    select low_stock_notified into flagged from public.rooms where id = v_room;
    perform public.vtest(n = 3 and flagged, 'N2b: third episode crossing → third alert');
end $$;

-- ---------------------------------------------------------------------------
-- §16 START-LOW episode on N2 (threshold 10)
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; n int; flagged boolean;
begin
    perform set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-0000000000d1', false);
    select v::uuid into v_room from public.anda_test_state where k='n2';

    perform public.record_purchase(v_room, 5, 40.00);              -- inv 5 ≤ 10
    select count(*) into n from public.low_stock_alerts where room_id = v_room;
    select low_stock_notified into flagged from public.rooms where id = v_room;
    perform public.vtest(n = 1 and flagged, 'N3a: starting at 5 → one alert for the episode');

    perform public.record_purchase(v_room, 6, 48.00);              -- inv 11 > 10
    select count(*) into n from public.low_stock_alerts where room_id = v_room;
    select low_stock_notified into flagged from public.rooms where id = v_room;
    perform public.vtest(n = 1 and not flagged, 'N3b: restock to 11 → re-armed, still one alert');

    perform public.record_usage(v_room, 1);                        -- inv 10
    select count(*) into n from public.low_stock_alerts where room_id = v_room;
    select low_stock_notified into flagged from public.rooms where id = v_room;
    perform public.vtest(n = 2 and flagged, 'N3c: later crossing → second alert');
end $$;

-- ---------------------------------------------------------------------------
-- §17 PUSH SUBSCRIPTIONS (device/member identity)
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_mem uuid; v_n int; v_id uuid; v_dummy uuid;
begin
    select v::uuid into v_room from public.anda_test_state where k='n1';

    -- O (d2) registers a subscription for N1
    perform set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-0000000000d2', false);
    select r.id into v_id from public.add_push_subscription(v_room,
        'https://fcm.example/send/device-other', 'ZXhhbXBsZS1wdWJsaWMta2V5LWZvci1wMjU2ZGg', 'c2VjcmV0LWF1dGgtc2VjcmV0') r;
    insert into public.anda_test_state values ('o_sub', v_id::text);

    -- I (d4, now in N1) registers before leaving
    perform set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-0000000000d4', false);
    select r.id into v_id from public.add_push_subscription(v_room,
        'https://fcm.example/send/device-inactive', 'ZXhhbXBsZS1wdWJsaWMta2V5LWZvci1wMjU2ZGg', 'c2VjcmV0LWF1dGgtc2VjcmV0') r;
    insert into public.anda_test_state values ('i_sub', v_id::text);
    perform public.leave_room(v_room);                              -- I leaves

    -- H (d1) registers, then registers the SAME endpoint again → upsert
    perform set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-0000000000d1', false);
    select r.id into v_id from public.add_push_subscription(v_room,
        'https://fcm.example/send/device-host', 'ZXhhbXBsZS1wdWJsaWMta2V5LWZvci1wMjU2ZGg', 'c2VjcmV0LWF1dGgtc2VjcmV0') r;
    insert into public.anda_test_state values ('h_sub', v_id::text);
    select r.id into v_id from public.add_push_subscription(v_room,
        'https://fcm.example/send/device-host', 'ZXhhbXBsZS1wdWJsaWMta2V5LWZvci1wMjU2ZGg', 'c2VjcmV0LWF1dGgtc2VjcmV0') r;

    select count(*) into v_n from public.push_subscriptions where room_id = v_room;
    perform public.vtest(v_n = 3, 'S1: three subscriptions (O, I, H) — H upsert did not duplicate');

    -- Delivery selection: ACTIVE members only (§17 step 1)
    select count(*) into v_n
    from public.push_subscriptions s
    join public.members m on m.id = s.member_id
    where s.room_id = v_room and m.is_active;
    perform public.vtest(v_n = 2, 'S2: delivery targets active members only (H, O; inactive I excluded)');

    -- Non-member cannot register
    perform set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-0000000000d3', false);
    begin
        perform public.add_push_subscription(v_room,
            'https://fcm.example/send/device-foreign', 'ZXhhbXBsZS1wdWJsaWMta2V5LWZvci1wMjU2ZGg', 'c2VjcmV0LWF1dGgtc2VjcmV0');
        perform public.vtest(false, 'S3: non-member registration rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: not a member of this room%', 'S3: non-member registration rejected');
    end;

    -- Inactive member cannot register
    perform set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-0000000000d4', false);
    begin
        perform public.add_push_subscription(v_room,
            'https://fcm.example/send/device-inactive2', 'ZXhhbXBsZS1wdWJsaWMta2V5LWZvci1wMjU2ZGg', 'c2VjcmV0LWF1dGgtc2VjcmV0');
        perform public.vtest(false, 'S4: inactive member registration rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: not a member of this room%', 'S4: inactive member registration rejected');
    end;

    -- Malformed values rejected (§24 friendly)
    perform set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-0000000000d1', false);
    begin
        perform public.add_push_subscription(v_room, 'ftp://bad', 'ZXhhbXBsZS1wdWJsaWMta2V5LWZvci1wMjU2ZGg', 'c2VjcmV0LWF1dGgtc2VjcmV0');
        perform public.vtest(false, 'S5a: non-https endpoint rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: invalid push endpoint%', 'S5a: non-https endpoint rejected');
    end;
    begin
        perform public.add_push_subscription(v_room, 'https://fcm.example/x', 'ab', 'c2VjcmV0LWF1dGgtc2VjcmV0');
        perform public.vtest(false, 'S5b: malformed p256dh rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: invalid push key%', 'S5b: malformed p256dh rejected');
    end;
    begin
        perform public.add_push_subscription(v_room, 'https://fcm.example/x', 'ZXhhbXBsZS1wdWJsaWMta2V5LWZvci1wMjU2ZGg', 'too_short');
        perform public.vtest(false, 'S5c: malformed auth secret rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: invalid push secret%', 'S5c: malformed auth secret rejected');
    end;

    -- Remove own; cannot remove another member's
    perform set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-0000000000d2', false);
    perform public.remove_push_subscription(v_room, 'https://fcm.example/send/device-other');
    select count(*) into v_n from public.push_subscriptions
    where room_id = v_room and member_id = (select v::uuid from public.anda_test_state where k='o_mem');
    perform public.vtest(v_n = 0, 'S6a: member removes OWN subscription');
    perform public.remove_push_subscription(v_room, 'https://fcm.example/send/device-host');
    select count(*) into v_n from public.push_subscriptions
    where room_id = v_room and endpoint = 'https://fcm.example/send/device-host';
    perform public.vtest(v_n = 1, 'S6b: cannot remove another member''s subscription');
end $$;

-- ---------------------------------------------------------------------------
-- RLS: owner-only visibility of subscriptions; alerts are private
-- ---------------------------------------------------------------------------
select v as n1_room from public.anda_test_state where k='n1' \gset

begin;
set role authenticated;
select set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-0000000000d1', true);
select public.vtest(
    (select count(*) from public.push_subscriptions where room_id = :'n1_room'::uuid) = 1,
    'R1a: host sees only own subscription');
commit;
reset role;

-- R1b: low_stock_alerts has NO member read grant → members get permission denied
begin;
set role authenticated;
select set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-0000000000d1', true);
do $$
begin
    begin
        perform (select count(*) from public.low_stock_alerts);
        perform public.vtest(false, 'R1b: low_stock_alerts invisible to members');
    exception when insufficient_privilege then
        perform public.vtest(true, 'R1b: low_stock_alerts invisible to members');
    end;
end $$;
commit;
reset role;

begin;
set role authenticated;
select set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-0000000000d3', true);
select public.vtest(
    (select count(*) from public.push_subscriptions where room_id = :'n1_room'::uuid) = 0,
    'R2: non-member sees no subscription rows');
commit;
reset role;

select set_config('request.jwt.claim.sub', '', false);
select '=== Anda — notification validation complete ===' as phase;
-- ============================================================================