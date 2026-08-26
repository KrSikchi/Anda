-- ============================================================================
-- Anda — Phase 5 atomicity suite: SETUP (LOCAL ONLY)
-- ----------------------------------------------------------------------------
-- Creates six isolated rooms (one per race) with pre-seeded stock, records the
-- usage that Race F will try to correct twice, and stores ids in the state
-- table. pgbench scripts (generated from supabase/tests/pgbench/*.tmpl.sql)
-- then hammer these rooms from many concurrent connections.
--
-- Devices: host H = cccccccc-0000-0000-0000-0000000000c1
--          joiner J = cccccccc-0000-0000-0000-0000000000c2
-- ============================================================================
\set ON_ERROR_STOP on

create table if not exists public.anda_test_state (k text primary key, v text);
truncate public.anda_test_state;

select set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-0000000000c1', false);

do $$
declare v_room uuid; v_mem uuid;
begin
    -- Race A room: stock 2 (the PRD §11 canonical scenario)
    select r.room_id into v_room from public.create_room('Race A', 'Host A', 10) r;
    insert into public.anda_test_state values ('ra_room', v_room::text);
    perform public.record_purchase(v_room, 2, 10.00);

    -- Race B room: zero stock
    select r.room_id into v_room from public.create_room('Race B', 'Host B', 10) r;
    insert into public.anda_test_state values ('rb_room', v_room::text);

    -- Race C room: concurrent purchases only
    select r.room_id into v_room from public.create_room('Race C', 'Host C', 10) r;
    insert into public.anda_test_state values ('rc_room', v_room::text);

    -- Race D room: stock 24, then 300 attempts to use 1
    select r.room_id into v_room from public.create_room('Race D', 'Host D', 10) r;
    insert into public.anda_test_state values ('rd_room', v_room::text);
    perform public.record_purchase(v_room, 24, 120.00);

    -- Race E room: mixed concurrent purchases + usage
    select r.room_id into v_room from public.create_room('Race E', 'Host E', 10) r;
    insert into public.anda_test_state values ('re_room', v_room::text);

    -- Race F room: purchase 10, member J uses 5 (to be corrected twice concurrently)
    select r.room_id into v_room from public.create_room('Race F', 'Host F', 10) r;
    insert into public.anda_test_state values ('rf_room', v_room::text);
    perform public.record_purchase(v_room, 10, 60.00);
end $$;

do $$
declare v_room uuid; v_mem uuid; v_use uuid;
begin
    select v::uuid into v_room from public.anda_test_state where k='rf_room';
    perform set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-0000000000c2', false);
    select r.member_id into v_mem from public.join_room((select share_code from public.rooms where id=v_room), 'Joiner') r;
    insert into public.anda_test_state values ('rf_joiner', v_mem::text);
    select r.id into v_use from public.record_usage(v_room, 5) r;
    insert into public.anda_test_state values ('rf_usage', v_use::text);
end $$;

-- back to host device for the pgbench phases
select set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-0000000000c1', false);
select 'setup complete' as status;
-- ============================================================================