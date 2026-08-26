-- ============================================================================
-- Anda — Phase 2 schema validation (LOCAL ONLY)
-- ----------------------------------------------------------------------------
-- Run after: local_auth_stub.sql  then  0001_initial_schema.sql
--   psql -X -d <db> -f supabase/tests/schema_validation.sql
--
-- Exercises the PRD §27 matrix at the schema level (Phase 2: "Validate the
-- database model before building significant UI"): constraints, ledger
-- derivation, immutability, and the RLS authorization boundary.
-- ============================================================================
\set ON_ERROR_STOP off
\set QUIET off

select '=== Anda — schema validation ===' as phase;

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

-- ----------------------------------------------------------------------------
-- Fixtures. One transaction — exercises the circular room + host creation path
-- (room inserted referencing its not-yet-created host member; DEFERRED FK
-- validated at commit, per D2).
-- ----------------------------------------------------------------------------
do $$
declare
    v_room_a uuid; v_room_b uuid;
    v_host_a uuid; v_host_b uuid;
    v_use    uuid;
begin
    v_host_a := gen_random_uuid();
    insert into public.rooms (id, name, share_code, host_member_id)
    values (gen_random_uuid(), 'Flat A', 'AAAAAA', v_host_a)
    returning id into v_room_a;
    insert into public.members (id, room_id, auth_user_id, display_name)
    values (v_host_a, v_room_a, '00000000-0000-0000-0000-000000000001', 'Host A');

    v_host_b := gen_random_uuid();
    insert into public.rooms (id, name, share_code, host_member_id)
    values (gen_random_uuid(), 'Flat B', 'BBBBBB', v_host_b)
    returning id into v_room_b;
    insert into public.members (id, room_id, auth_user_id, display_name)
    values (v_host_b, v_room_b, '00000000-0000-0000-0000-000000000002', 'Host B');

    -- purchases: two differently priced batches in room A (price changed
    -- between purchases, §8); one batch in room B
    insert into public.purchases (room_id, member_id, quantity, total_cost)
    values (v_room_a, v_host_a, 30, 240.00);
    insert into public.purchases (room_id, member_id, quantity, total_cost)
    values (v_room_a, v_host_a, 12, 60.00);
    insert into public.purchases (room_id, member_id, quantity, total_cost)
    values (v_room_b, v_host_b, 20, 100.00);

    -- usage: 4 correct; then 10 recorded when 2 were intended → compensating -8
    insert into public.egg_usage (room_id, member_id, quantity)
    values (v_room_a, v_host_a, 4);
    insert into public.egg_usage (room_id, member_id, quantity)
    values (v_room_a, v_host_a, 10)
    returning id into v_use;
    insert into public.egg_usage (room_id, member_id, quantity, correction_of)
    values (v_room_a, v_host_a, -8, v_use);
end $$;

-- ----------------------------------------------------------------------------
-- T1 tables exist (§6 entities)
-- ----------------------------------------------------------------------------
do $$
declare n int;
begin
    select count(*) into n from information_schema.tables
    where table_schema = 'public' and table_name in ('rooms','members','purchases','egg_usage','settlements');
    perform public.vtest(n = 5, 'T1: all five core entities exist (rooms, members, purchases, egg_usage, settlements)');
end $$;

-- ----------------------------------------------------------------------------
-- T2 room defaults (§6: threshold = 10, notification state = false)
-- ----------------------------------------------------------------------------
select public.vtest((select low_stock_threshold from public.rooms where name = 'Flat A') = 10,
    'T2a: low_stock_threshold defaults to 10');
select public.vtest((select low_stock_notified from public.rooms where name = 'Flat A') = false,
    'T2b: low_stock_notified defaults to false');

-- ----------------------------------------------------------------------------
-- T3 unique share code (§23/§25)
-- ----------------------------------------------------------------------------
do $$
begin
    begin
        insert into public.rooms (name, share_code, host_member_id)
        select 'Duplicate', 'AAAAAA',
               (select id from public.members where display_name = 'Host A');
        perform public.vtest(false, 'T3: duplicate share_code rejected');
    exception when unique_violation then
        perform public.vtest(true, 'T3: duplicate share_code rejected');
    end;
end $$;

-- ----------------------------------------------------------------------------
-- T4 share code format (short, alphanumeric, uppercase — PRD code format)
-- ----------------------------------------------------------------------------
do $$
declare v_host uuid;
begin
    select id into v_host from public.members where display_name = 'Host A';
    begin
        insert into public.rooms (name, share_code, host_member_id)
        values ('Bad Code', 'ab1x2y', v_host);
        perform public.vtest(false, 'T4: invalid share_code format rejected');
    exception when check_violation then
        perform public.vtest(true, 'T4: invalid share_code format rejected');
    end;
end $$;

-- ----------------------------------------------------------------------------
-- T5 room must have a host (§6)
-- ----------------------------------------------------------------------------
do $$
begin
    begin
        insert into public.rooms (name, share_code, host_member_id)
        values ('No Host', 'DDDDDD', null);
        perform public.vtest(false, 'T5: room without host rejected');
    exception when not_null_violation then
        perform public.vtest(true, 'T5: room without host rejected');
    end;
end $$;

-- ----------------------------------------------------------------------------
-- T6 room name must be non-empty (§23)
-- ----------------------------------------------------------------------------
do $$
declare v_host uuid;
begin
    select id into v_host from public.members where display_name = 'Host A';
    begin
        insert into public.rooms (name, share_code, host_member_id)
        values ('   ', 'EEEEEE', v_host);
        perform public.vtest(false, 'T6: blank room name rejected');
    exception when check_violation then
        perform public.vtest(true, 'T6: blank room name rejected');
    end;
end $$;

-- ----------------------------------------------------------------------------
-- T7 host must belong to the room being created (DEFERRED composite FK, D2)
-- (outside DO: the violation surfaces at COMMIT and cannot be caught in-block)
-- ----------------------------------------------------------------------------
select 'T7: expected ERROR (foreign key violation — host belongs to a different room)';
begin;
insert into public.rooms (name, share_code, host_member_id)
values ('Broken Host', 'CCCCCC', (select id from public.members where display_name = 'Host B'));
commit;

-- ----------------------------------------------------------------------------
-- T8 purchase quantity/cost constraints (§8)
-- ----------------------------------------------------------------------------
do $$
declare v_room uuid; v_mem uuid;
begin
    select id into v_room from public.rooms where name = 'Flat A';
    select id into v_mem  from public.members where display_name = 'Host A';
    begin
        insert into public.purchases (room_id, member_id, quantity, total_cost)
        values (v_room, v_mem, 0, 10);
        perform public.vtest(false, 'T8a: purchase quantity 0 rejected');
    exception when check_violation then
        perform public.vtest(true, 'T8a: purchase quantity 0 rejected');
    end;
    begin
        insert into public.purchases (room_id, member_id, quantity, total_cost)
        values (v_room, v_mem, -1, 10);
        perform public.vtest(false, 'T8b: negative purchase quantity rejected');
    exception when check_violation then
        perform public.vtest(true, 'T8b: negative purchase quantity rejected');
    end;
    begin
        insert into public.purchases (room_id, member_id, quantity, total_cost)
        values (v_room, v_mem, 5, -1);
        perform public.vtest(false, 'T8c: negative total cost rejected');
    exception when check_violation then
        perform public.vtest(true, 'T8c: negative total cost rejected');
    end;
end $$;

-- ----------------------------------------------------------------------------
-- T9 cost_per_egg is derived, historical pricing preserved (§8)
-- (deterministic lookup by fixture quantity; recorded_at ties inside one
-- transaction, so time-ordering alone is not a stable tiebreaker)
-- ----------------------------------------------------------------------------
select public.vtest(
    (select cost_per_egg from public.purchases
     where room_id = (select id from public.rooms where name = 'Flat A')
       and quantity = 30) = 8.0,
    'T9a: cost_per_egg derived (240 / 30 = 8)');
select public.vtest(
    (select cost_per_egg from public.purchases
     where room_id = (select id from public.rooms where name = 'Flat A')
       and quantity = 12) = 5.0,
    'T9b: later batch keeps its own price (60 / 12 = 5; price not overwritten)');

-- ----------------------------------------------------------------------------
-- T10/T11/T12 usage sign semantics (§9, §10): usage > 0, corrections < 0
-- ----------------------------------------------------------------------------
do $$
declare v_room uuid; v_mem uuid; v_use uuid;
begin
    select id into v_room from public.rooms where name = 'Flat A';
    select id into v_mem  from public.members where display_name = 'Host A';
    select id into v_use  from public.egg_usage order by recorded_at desc limit 1;
    begin
        insert into public.egg_usage (room_id, member_id, quantity)
        values (v_room, v_mem, 0);
        perform public.vtest(false, 'T10: zero-quantity usage rejected');
    exception when check_violation then
        perform public.vtest(true, 'T10: zero-quantity usage rejected');
    end;
    begin
        insert into public.egg_usage (room_id, member_id, quantity)
        values (v_room, v_mem, -3);
        perform public.vtest(false, 'T11: negative plain usage rejected');
    exception when check_violation then
        perform public.vtest(true, 'T11: negative plain usage rejected');
    end;
    begin
        insert into public.egg_usage (room_id, member_id, quantity, correction_of)
        values (v_room, v_mem, 3, v_use);
        perform public.vtest(false, 'T12: positive correction rejected');
    exception when check_violation then
        perform public.vtest(true, 'T12: positive correction rejected');
    end;
end $$;

-- ----------------------------------------------------------------------------
-- T13 correction must reference usage in the SAME room (§10)
-- ----------------------------------------------------------------------------
do $$
declare v_use uuid;
begin
    select id into v_use from public.egg_usage order by recorded_at limit 1;
    begin
        insert into public.egg_usage (room_id, member_id, quantity, correction_of)
        select r.id, m.id, -2, v_use
        from public.rooms r, public.members m
        where r.name = 'Flat B' and m.room_id = r.id limit 1;
        perform public.vtest(false, 'T13: cross-room correction rejected');
    exception when foreign_key_violation then
        perform public.vtest(true, 'T13: cross-room correction rejected');
    end;
end $$;

-- ----------------------------------------------------------------------------
-- T14 correction must reference an existing usage (§10)
-- ----------------------------------------------------------------------------
do $$
declare v_room uuid; v_mem uuid;
begin
    select id into v_room from public.rooms where name = 'Flat A';
    select id into v_mem  from public.members where display_name = 'Host A';
    begin
        insert into public.egg_usage (room_id, member_id, quantity, correction_of)
        values (v_room, v_mem, -2, gen_random_uuid());
        perform public.vtest(false, 'T14: dangling correction rejected');
    exception when foreign_key_violation then
        perform public.vtest(true, 'T14: dangling correction rejected');
    end;
end $$;

-- ----------------------------------------------------------------------------
-- T15 effective totals after correction (§10: original + correction = effective)
-- ----------------------------------------------------------------------------
select public.vtest(
    (select sum(quantity) from public.egg_usage
     where room_id = (select id from public.rooms where name = 'Flat A')) = 6,
    'T15a: effective usage = 4 + (10 − 8) = 6');
select public.vtest(
    (select quantity from public.egg_usage where correction_of is not null) = -8,
    'T15b: correction is the compensating negative (−8)');

-- ----------------------------------------------------------------------------
-- T16 ledger immutability (§7, §29: no destructive edits)
-- ----------------------------------------------------------------------------
do $$
declare v_use uuid; v_pur uuid;
begin
    select id into v_use from public.egg_usage order by recorded_at limit 1;
    select id into v_pur from public.purchases order by recorded_at limit 1;
    begin
        update public.egg_usage set quantity = quantity + 1 where id = v_use;
        perform public.vtest(false, 'T16a: usage UPDATE blocked');
    exception when raise_exception then
        perform public.vtest(true, 'T16a: usage UPDATE blocked');
    end;
    begin
        delete from public.egg_usage where id = v_use;
        perform public.vtest(false, 'T16b: usage DELETE blocked');
    exception when raise_exception then
        perform public.vtest(true, 'T16b: usage DELETE blocked');
    end;
    begin
        delete from public.purchases where id = v_pur;
        perform public.vtest(false, 'T16c: purchase DELETE blocked');
    exception when raise_exception then
        perform public.vtest(true, 'T16c: purchase DELETE blocked');
    end;
end $$;

-- ----------------------------------------------------------------------------
-- T17 member display name must be non-empty (§4)
-- ----------------------------------------------------------------------------
do $$
declare v_room uuid;
begin
    select id into v_room from public.rooms where name = 'Flat A';
    begin
        insert into public.members (room_id, auth_user_id, display_name)
        values (v_room, gen_random_uuid(), '   ');
        perform public.vtest(false, 'T17: blank display name rejected');
    exception when check_violation then
        perform public.vtest(true, 'T17: blank display name rejected');
    end;
end $$;

-- ----------------------------------------------------------------------------
-- T18 member with history cannot be hard-deleted (§6: soft-delete only)
-- ----------------------------------------------------------------------------
do $$
begin
    begin
        delete from public.members where display_name = 'Host A';
        perform public.vtest(false, 'T18: hard delete of member with history blocked');
    exception when foreign_key_violation then
        perform public.vtest(true, 'T18: hard delete of member with history blocked');
    end;
end $$;

-- ----------------------------------------------------------------------------
-- T19 inventory is DERIVED from the ledger, never stored (§7)
-- ----------------------------------------------------------------------------
select public.vtest(
    (select coalesce(sum(quantity), 0) from public.purchases
     where room_id = (select id from public.rooms where name = 'Flat A'))
    - (select coalesce(sum(quantity), 0) from public.egg_usage
       where room_id = (select id from public.rooms where name = 'Flat A'))
    = 36,
    'T19: inventory = Σpurchases − Σusage = 42 − 6 = 36 (derived, not stored)');

-- ----------------------------------------------------------------------------
-- RLS boundary (§5, §21) — simulated anonymous-auth principals
-- ----------------------------------------------------------------------------
-- R1: anon has no read grant at all
begin;
set role anon;
select 'R1: expected ERROR (permission denied for table rooms) on next statement';
select * from public.rooms;
rollback;
reset role;

-- R2: authenticated uidA sees only Flat A
begin;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select public.vtest((select count(*) from public.rooms) = 1, 'R2a: uidA sees exactly its own room');
select public.vtest((select count(*) from public.rooms where name = 'Flat B') = 0, 'R2b: uidA cannot see the other room');
select public.vtest((select count(*) from public.purchases p
                     join public.rooms r on r.id = p.room_id where r.name = 'Flat B') = 0,
    'R2c: uidA cannot read other room''s purchases');
select public.vtest((select count(*) from public.egg_usage e
                     join public.rooms r on r.id = e.room_id where r.name = 'Flat B') = 0,
    'R2d: uidA cannot read other room''s usage');
select public.vtest((select count(distinct room_id) from public.members) = 1,
    'R2e: uidA sees members of its own room only');
select public.vtest((select count(*) from public.settlements) = 0,
    'R2f: settlements readable (structural, empty)');
commit;
reset role;

-- R3: authenticated uidB sees only Flat B
begin;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select public.vtest((select count(*) from public.rooms) = 1, 'R3a: uidB sees its own room');
select public.vtest((select count(*) from public.rooms where name = 'Flat A') = 0, 'R3b: uidB cannot see the other room');
select public.vtest((select count(*) from public.purchases p
                     join public.rooms r on r.id = p.room_id where r.name = 'Flat A') = 0,
    'R3c: uidB cannot read other room''s purchases');
commit;
reset role;

-- R4: authenticated member has NO direct write path (D6: writes via RPCs only)
begin;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select 'R4: expected ERROR (permission denied for table purchases) on next statement';
insert into public.purchases (room_id, member_id, quantity, total_cost)
select r.id, m.id, 2, 10 from public.rooms r join public.members m on m.room_id = r.id
where r.name = 'Flat A' limit 1;
rollback;
reset role;

-- R5: inactive member loses all access (§6)
update public.members set is_active = false where display_name = 'Host B';
begin;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select public.vtest((select count(*) from public.rooms) = 0, 'R5a: inactive member reads nothing');
select public.vtest((select count(*) from public.purchases) = 0, 'R5b: inactive member has no purchase access');
select public.vtest((select count(*) from public.members) = 0, 'R5c: inactive member has no member access');
commit;
reset role;
update public.members set is_active = true where display_name = 'Host B';

-- R6: soft-deleted room fully invisible (§4.1: soft-delete room)
update public.rooms set is_active = false where name = 'Flat A';
begin;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select public.vtest((select count(*) from public.rooms) = 0, 'R6a: soft-deleted room is invisible to members');
select public.vtest((select count(*) from public.purchases) = 0, 'R6b: its transactions are also hidden');
select public.vtest((select count(*) from public.egg_usage) = 0, 'R6c: its usage ledger is hidden');
select public.vtest((select count(*) from public.members) = 0, 'R6d: its members list is hidden');
commit;
reset role;
update public.rooms set is_active = true where name = 'Flat A';

-- ----------------------------------------------------------------------------
-- T20 device-bound identity integrity (§4)
-- ----------------------------------------------------------------------------
do $$
begin
    begin
        insert into public.members (room_id, auth_user_id, display_name)
        select id, '00000000-0000-0000-0000-000000000001', 'Alias'
        from public.rooms where name = 'Flat A';
        perform public.vtest(false, 'T20a: duplicate ACTIVE membership for one device in one room rejected');
    exception when unique_violation then
        perform public.vtest(true, 'T20a: duplicate ACTIVE membership for one device in one room rejected');
    end;
end $$;

do $$
declare v_room uuid; v_new uuid := gen_random_uuid();
begin
    select id into v_room from public.rooms where name = 'Flat A';
    insert into public.members (id, room_id, auth_user_id, display_name)
    values (v_new, v_room, '00000000-0000-0000-0000-0000000000aa', 'Rejoin');
    update public.members set is_active = false where id = v_new;
    insert into public.members (room_id, auth_user_id, display_name)
    values (v_room, '00000000-0000-0000-0000-0000000000aa', 'Rejoin 2');
    perform public.vtest(true, 'T20b: leaving then re-joining creates a fresh active membership');
    delete from public.members where auth_user_id = '00000000-0000-0000-0000-0000000000aa'
        and display_name = 'Rejoin 2';
end $$;

select '=== Anda — schema validation complete ===' as phase;
-- ============================================================================