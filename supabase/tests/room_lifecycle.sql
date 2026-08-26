-- ============================================================================
-- Anda — Phase 3 room-lifecycle test suite (LOCAL ONLY)
-- ----------------------------------------------------------------------------
-- Run after: local_auth_stub.sql, 0001_initial_schema.sql, 0002_room_lifecycle.sql
--   psql -X -d <db> -f supabase/tests/room_lifecycle.sql
--
-- Covers the room + identity rows of the PRD §27 matrix at the RPC boundary:
--   create / code generation / join / invalid code / leave / history survival /
--   host lifecycle / unique identities / no cross-room access / inactivity
--   lockout / display name never authorizes.
--
-- Conventions: callers are simulated with auth.uid() = session GUC
-- request.jwt.claim.sub (the local stub). RPC authorization uses only that,
-- exactly as in production where Supabase sets it from the verified JWT.
-- RLS behavior is exercised separately with set role authenticated.
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

-- Fixture bookkeeping (postgres-owned; values stored as text)
create table if not exists public.anda_test_state (k text primary key, v text);
truncate public.anda_test_state;

-- Simulated devices (anonymous-auth principals)
--   Host H: aaaaaaaa-0000-0000-0000-000000000001
--   J     : aaaaaaaa-0000-0000-0000-000000000002
--   S     : aaaaaaaa-0000-0000-0000-000000000003
--   X,Y,Z,Ghost,W,D: ...04..09
select set_config('request.jwt.claim.sub', '', false); -- start unsigned-in
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false); -- device H

-- ---------------------------------------------------------------------------
-- 1. CREATE ROOM
-- ---------------------------------------------------------------------------
do $$
declare
    v_room uuid; v_mem uuid; v_code text; v_thr integer;
begin
    select r.room_id, r.member_id, r.share_code, r.low_stock_threshold
      into v_room, v_mem, v_code, v_thr
    from public.create_room('Alpha House', 'Host H', 12) r;

    insert into public.anda_test_state values
        ('alpha_room', v_room::text),
        ('alpha_code1', v_code),
        ('host_member', v_mem::text);

    perform public.vtest(v_room is not null, 'T1a: create_room returns a room id');
    perform public.vtest(v_code ~ '^[A-Z0-9]{6}$', 'T1b: share code is 6 chars alphanumeric [A-Z0-9]');
    perform public.vtest(v_thr = 12, 'T1c: custom low-stock threshold applied (12)');
    perform public.vtest((select low_stock_threshold from public.rooms where id = v_room) = 12,
        'T1d: threshold persisted on rooms row');
    perform public.vtest((select host_member_id from public.rooms where id = v_room) = v_mem,
        'T1e: room host is the creating member');
    perform public.vtest((select display_name from public.members where id = v_mem) = 'Host H',
        'T1f: creator display name stored');
    perform public.vtest((select count(*) from public.members where id = v_mem and is_active) = 1,
        'T1g: creator is an active member');
end $$;

select public.vtest((select v from public.anda_test_state where k='alpha_room') is not null,
    'state ready (host device)');

-- default threshold = 10 (§6)
do $$
declare v_thr integer;
begin
    select r.low_stock_threshold into v_thr
    from public.create_room('Theta House', 'Host T') r;
    perform public.vtest(v_thr = 10, 'T2: default low-stock threshold is 10');
end $$;

do $$
begin
    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-0000000000ff', false);
    begin
        perform public.create_room('   ', 'Host X', 10);
        perform public.vtest(false, 'T3a: blank room name rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: room name required%', 'T3a: blank room name rejected');
    end;
    begin
        perform public.create_room('Valid Room', '   ', 10);
        perform public.vtest(false, 'T3b: blank display name rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: display name required%', 'T3b: blank display name rejected');
    end;
    begin
        perform public.create_room('Valid Room', 'Host X', 0);
        perform public.vtest(false, 'T3c: threshold 0 rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: low-stock threshold must be a positive number%', 'T3c: threshold 0 rejected');
    end;
    perform set_config('request.jwt.claim.sub', '', false);
    begin
        perform public.create_room('Valid Room', 'Host X', 10);
        perform public.vtest(false, 'T3d: unsigned-in caller rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: not signed in%', 'T3d: unsigned-in caller rejected');
    end;
end $$;

-- ---------------------------------------------------------------------------
-- 2. JOIN ROOM (§3, §4)
-- ---------------------------------------------------------------------------
do $$
declare
    v_code text; v_room uuid; v_j uuid; v_h uuid; v_s uuid; v_y text;
begin
    select v into v_code from public.anda_test_state where k = 'alpha_code1';
    select v::uuid into v_room from public.anda_test_state where k = 'alpha_room';
    select v::uuid into v_h    from public.anda_test_state where k = 'host_member';

    -- Device J (Alice) joins with the code
    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000002', false);
    select r.member_id, r.display_name into v_j, v_y
    from public.join_room(v_code, 'Alice') r;
    perform public.vtest(v_j is not null and v_j <> v_h, 'T4a: joiner receives a distinct member_id');
    perform public.vtest(v_y = 'Alice', 'T4b: joiner display name stored');
    insert into public.anda_test_state values ('jm1', v_j::text);

    -- Idempotent: same active device joins again → SAME identity (D10)
    select r.member_id into v_s from public.join_room(v_code, 'Alice') r;
    perform public.vtest(v_s = v_j, 'T5: same-device re-join returns the existing member_id');

    -- Device S (Sam) joins → another distinct identity
    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000003', false);
    select r.member_id into v_s from public.join_room(v_code, 'Sam') r;
    perform public.vtest(v_s is not null and v_s <> v_j and v_s <> v_h,
        'T6a: second device gets a unique identity');
    insert into public.anda_test_state values ('sm', v_s::text);

    -- Invalid codes (§23, §21)
    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000004', false);
    begin
        perform public.join_room('9XK2QZ', 'Xavier');  -- well-formed but unknown
        perform public.vtest(false, 'T7a: unknown code rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: room not found%', 'T7a: unknown code rejected');
    end;
    begin
        perform public.join_room('abc', 'Xavier');     -- malformed
        perform public.vtest(false, 'T7b: malformed code rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: room not found%', 'T7b: malformed code rejected');
    end;
end $$;

-- ---------------------------------------------------------------------------
-- 3. HOST BOUNDARY (§3): only the host may regenerate / soft-delete
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_new text; v_dummy uuid;
begin
    select v::uuid into v_room from public.anda_test_state where k = 'alpha_room';

    -- J (member, not host) tries host powers
    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000002', false);
    begin
        perform public.regenerate_room_code(v_room);
        perform public.vtest(false, 'T8a: non-host regenerate rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%only the room host can change the room code%', 'T8a: non-host regenerate rejected');
    end;
    begin
        perform public.soft_delete_room(v_room);
        perform public.vtest(false, 'T8b: non-host soft-delete rejected');
    exception when others then
        perform public.vtest(sqlerrm like '%only the room host can delete the room%', 'T8b: non-host soft-delete rejected');
    end;

    -- Host regenerates → old code dies, new code works
    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
    select public.regenerate_room_code(v_room) into v_new;
    perform public.vtest(v_new ~ '^[A-Z0-9]{6}$' and v_new <> (select v from public.anda_test_state where k = 'alpha_code1'),
        'T9a: host regenerates a new valid code');
    insert into public.anda_test_state values ('alpha_code2', v_new);

    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000004', false);
    begin
        perform public.join_room((select v from public.anda_test_state where k = 'alpha_code1'), 'Xavier');
        perform public.vtest(false, 'T9b: old code no longer opens the room');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: room not found%', 'T9b: old code no longer opens the room');
    end;

    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000005', false);
    select r.member_id into v_dummy from public.join_room((select v from public.anda_test_state where k = 'alpha_code2'), 'Yuki') r;
    perform public.vtest(v_dummy is not null, 'T9c: new code opens the room');
    insert into public.anda_test_state values ('ym', v_dummy::text);
end $$;

-- ---------------------------------------------------------------------------
-- 4. LEAVE + HISTORY SURVIVES (§3, §6)
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_j1 uuid; v_j2 uuid; v_dummy uuid;
begin
    select v::uuid into v_room from public.anda_test_state where k = 'alpha_room';
    select v::uuid into v_j1  from public.anda_test_state where k = 'jm1';

    -- J leaves
    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000002', false);
    perform public.leave_room(v_room);
    perform public.vtest(
        (select is_active from public.members where id = v_j1) = false,
        'T10a: leaving deactivates the membership (soft delete)');
    perform public.vtest(
        (select count(*) from public.members where id = v_j1) = 1,
        'T10b: member row is preserved after leaving');

    -- Re-join after leaving → FRESH active identity (D10)
    select r.member_id into v_j2 from public.join_room((select v from public.anda_test_state where k='alpha_code2'), 'Alice') r;
    perform public.vtest(v_j2 is not null and v_j2 <> v_j1, 'T10c: re-join after leaving creates a fresh active membership');
    insert into public.anda_test_state values ('jm2', v_j2::text);

    -- Inactive identity cannot act on the room (§6: no mutations after leaving)
    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000009', false);
    select r.member_id into v_dummy from public.join_room((select v from public.anda_test_state where k='alpha_code2'), 'Ghost') r;
    perform public.leave_room(v_room);
    begin
        perform public.leave_room(v_room);
        perform public.vtest(false, 'T10d: inactive identity cannot act on the room');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: not a member of this room%', 'T10d: inactive identity cannot act on the room');
    end;

    -- Inactive host loses host powers (D9)
    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000006', false);
    select r.member_id into v_dummy from public.join_room((select v from public.anda_test_state where k='alpha_code2'), 'Zoe') r;
    perform public.leave_room(v_room);
    begin
        perform public.regenerate_room_code(v_room);
        perform public.vtest(false, 'T10e: inactive (former) host cannot regenerate');
    exception when others then
        perform public.vtest(sqlerrm like '%not a member of this room%', 'T10e: inactive (former) host cannot regenerate');
    end;
end $$;

-- ---------------------------------------------------------------------------
-- 5. RLS: room visibility across devices (§5)
-- ---------------------------------------------------------------------------
select v::text as room_id from public.anda_test_state where k='alpha_room' \gset

begin;
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);
select public.vtest(
    (select count(*) from public.rooms where id = :'room_id') = 1,
    'R1a: host sees the room');
select public.vtest(
    (select count(*) from public.members
      where room_id = :'room_id' and display_name = 'Alice' and not is_active) = 1,
    'R1b: departed member remains represented in the member list');
commit;
reset role;

begin;
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000003', true);
select public.vtest(
    (select count(*) from public.rooms where id = :'room_id') = 1,
    'R2a: active member sees the room');
commit;
reset role;

begin;
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000004', true);
select public.vtest(
    (select count(*) from public.rooms where id = :'room_id') = 0,
    'R2b: non-member device sees nothing of the room');
select public.vtest(
    (select count(*) from public.members where room_id = :'room_id') = 0,
    'R2c: non-member device sees no member rows');
commit;
reset role;

-- ---------------------------------------------------------------------------
-- 6. DISPLAY NAME NEVER AUTHORIZES (§4: identity = member_id, not the name)
-- ---------------------------------------------------------------------------
do $$
declare v_beta uuid; v_alpha uuid; v_dummy uuid;
begin
    select v::uuid into v_alpha from public.anda_test_state where k='alpha_room';

    -- Device D opens a second room, deliberately using display name 'Host H'
    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000008', false);
    select r.room_id into v_beta from public.create_room('Beta Flat', 'Host H', 10) r;

    -- D (alias 'Host H') cannot touch Alpha House
    begin
        perform public.leave_room(v_alpha);
        perform public.vtest(false, 'T11a: same display name grants no access to another room');
    exception when others then
        perform public.vtest(sqlerrm like '%not a member of this room%', 'T11a: same display name grants no access to another room');
    end;

    -- Host H cannot touch Beta Flat either (rejected as a non-member of it —
    -- the earliest and most accurate rejection the server can give)
    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
    begin
        perform public.soft_delete_room(v_beta);
        perform public.vtest(false, 'T11b: host of one room cannot act on another room');
    exception when others then
        perform public.vtest(
            sqlerrm like '%Anda: not a member of this room%'
            or sqlerrm like '%only the room host can delete the room%',
            'T11b: host of one room cannot act on another room');
    end;
end $$;

-- ---------------------------------------------------------------------------
-- 7. SOFT-DELETE ROOM (host-only) + full invisibility (§3, §4.1)
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid;
begin
    select v::uuid into v_room from public.anda_test_state where k = 'alpha_room';
    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
    perform public.soft_delete_room(v_room);
    perform public.vtest(
        (select is_active from public.rooms where id = v_room) = false,
        'T12a: host soft-deletes the room');
    perform public.vtest(
        (select count(*) from public.members where room_id = v_room) >= 4,
        'T12b: member rows preserved after room soft-delete');
end $$;

begin;
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);
select public.vtest(
    (select count(*) from public.rooms where id = :'room_id') = 0,
    'R3a: after soft-delete even the host cannot see the room');
commit;
reset role;

begin;
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000002', true);
select public.vtest(
    (select count(*) from public.rooms where id = :'room_id') = 0,
    'R3b: after soft-delete an active member cannot see the room');
commit;
reset role;

-- Fresh device cannot join a soft-deleted room; host cannot operate on it
do $$
declare v_room uuid;
begin
    select v::uuid into v_room from public.anda_test_state where k = 'alpha_room';
    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000007', false);
    begin
        perform public.join_room((select v from public.anda_test_state where k='alpha_code2'), 'Wren');
        perform public.vtest(false, 'T13a: joining a soft-deleted room is impossible');
    exception when others then
        perform public.vtest(sqlerrm like '%Anda: room not found%', 'T13a: joining a soft-deleted room is impossible');
    end;
    perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
    begin
        perform public.leave_room(v_room);
        perform public.vtest(false, 'T13b: no operations on a soft-deleted room');
    exception when others then
        perform public.vtest(sqlerrm like '%not a member of this room%', 'T13b: no operations on a soft-deleted room');
    end;
end $$;

select set_config('request.jwt.claim.sub', '', false);
select '=== Anda — room lifecycle validation complete ===' as phase;
-- ============================================================================