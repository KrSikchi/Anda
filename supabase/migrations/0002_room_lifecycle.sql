-- ============================================================================
-- Anda — Room lifecycle (PRD Phase 3)
-- Migration 0002
--
-- Implements (binding PRD):
--   §3 Room lifecycle   create room / short alphanumeric code / join by code /
--                        leave / historical representation after leaving /
--                        host powers limited to: creation, code regeneration,
--                        soft deletion — nothing more.
--   §4 Identity model   no email/password/OAuth; device-bound pseudonymous
--                        member_id; display name is NOT the identity; user
--                        interacts only with display name + room code.
--   §5 Authorization    server-side only; every RPC re-validates membership
--                        and activeness inside SECURITY DEFINER (RLS does not
--                        apply to the definer, so nothing is trusted from the
--                        browser).
--   §6 Data model       rooms (host, code, lifecycle, threshold) and members
--                        (identity, activeness); leaving = is_active=false,
--                        history preserved, no hard deletes.
--   §21 Security        secure random identifiers (gen_random_bytes), no
--                        frontend secrets, soft deletion only.
--
-- Decisions (PRD §32: outcome specified, implementation chosen smallest robust):
--   D8  create_room takes the creator's display name (§4: every member has a
--       display name; the creator is a member; UI: one screen, two fields).
--   D9  Host succession is NOT implemented (would be an extra host power, §3).
--       A host who leaves loses host powers; the room retains its historical
--       host identity; only an ACTIVE host may regenerate/soft-delete.
--   D10 join_room is idempotent for an ACTIVE same-device membership: it
--       returns the existing member_id (soft identity recovery, §9 risk
--       "device loss → re-join"). After leaving, re-joining creates a FRESH
--       active membership (new member_id) — consistent with the device-bound
--       identity model (§4) and Phase-2 test T20b.
--   D11 Device binding: Supabase anonymous auth supplies auth.uid(); the
--       member row stores it (migration 0001, D1). RPCs identify the caller
--       by auth.uid() alone — display names can never authorize anything.
--   D12 share_code: 6 chars from [A-Z0-9], drawn with rejection sampling
--       (unbiased) from gen_random_bytes, retried until unique.
--
-- Client-facing error convention (PRD §24): every user-facing failure raises
--   'Anda: <plain message>'  — the frontend maps these to the friendly copy.
-- Messages used here:
--   Anda: not signed in
--   Anda: room name required
--   Anda: display name required
--   Anda: low-stock threshold must be a positive number
--   Anda: room code required
--   Anda: room not found              (unknown / malformed / inactive room)
--   Anda: not a member of this room
--   Anda: only the room host can change the room code
--   Anda: only the room host can delete the room
--   Anda: already a member of this room   (race fallback; normally idempotent)
-- ============================================================================

begin;

-- gen_random_bytes() (unbiased code generation, §21) is provided by pgcrypto.
-- Available in Supabase's default extension set; created idempotently so the
-- migration is reproducible on any PostgreSQL instance (PRD §25).
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helpers (internal only — no API execution grants)
-- ---------------------------------------------------------------------------

-- One unbiased integer in 0..35 from rejection-sampled random bytes
-- (256 = 36*7 + 4; rejecting 252..255 removes the modulo bias, §21/§12).
create or replace function public.anda_rand_index36()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_b bytea := public.gen_random_bytes(1);
begin
    while get_byte(v_b, 0) >= 252 loop
        v_b := public.gen_random_bytes(1);
    end loop;
    return get_byte(v_b, 0) % 36;
end $$;

-- Unique 6-char room code from [A-Z0-9] (§3, §6, §23). 36^6 ≈ 2.18e9 space.
create or replace function public.generate_share_code()
returns varchar(6)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_code    varchar(6);
    v_alphabet constant varchar(36) := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    v_attempt integer := 0;
begin
    loop
        v_code := substr(v_alphabet, public.anda_rand_index36() + 1, 1)
               || substr(v_alphabet, public.anda_rand_index36() + 1, 1)
               || substr(v_alphabet, public.anda_rand_index36() + 1, 1)
               || substr(v_alphabet, public.anda_rand_index36() + 1, 1)
               || substr(v_alphabet, public.anda_rand_index36() + 1, 1)
               || substr(v_alphabet, public.anda_rand_index36() + 1, 1);
        v_attempt := v_attempt + 1;
        if v_attempt > 25 then
            raise exception 'Anda: could not allocate a unique room code; please retry';
        end if;
        exit when not exists (select 1 from public.rooms where share_code = v_code);
    end loop;
    return v_code;
end $$;

-- Stable member id of the caller within an ACTIVE room (null if none).
-- Used for every server-side authorization check inside SECURITY DEFINER RPCs.
create or replace function public.current_member_id(p_room_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
    select m.id
    from public.members m
    join public.rooms r on r.id = m.room_id
    where r.id = p_room_id
      and r.is_active
      and m.auth_user_id = auth.uid()
      and m.is_active;
$$;

revoke all on function public.anda_rand_index36(), public.generate_share_code(), public.current_member_id(uuid) from public;

-- ---------------------------------------------------------------------------
-- create_room (§3, §6, §23): create room + host membership in one atom
-- ---------------------------------------------------------------------------
create or replace function public.create_room(
    p_room_name            text,
    p_display_name         text,
    p_low_stock_threshold  integer default 10
)
returns table (room_id uuid, room_name text, share_code varchar(6),
               member_id uuid, display_name text, low_stock_threshold integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_auth   uuid := auth.uid();
    v_room   uuid := gen_random_uuid();
    v_member uuid := gen_random_uuid();
    v_code   varchar(6);
begin
    if v_auth is null then
        raise exception 'Anda: not signed in';
    end if;
    if p_room_name is null or btrim(p_room_name) = '' then
        raise exception 'Anda: room name required';
    end if;
    if p_display_name is null or btrim(p_display_name) = '' then
        raise exception 'Anda: display name required';
    end if;
    if p_low_stock_threshold is null or p_low_stock_threshold <= 0 then
        raise exception 'Anda: low-stock threshold must be a positive number';
    end if;

    v_code := public.generate_share_code();

    -- Room inserted before its host member exists: fk_rooms_host is
    -- DEFERRABLE INITIALLY DEFERRED (0001, D2) — validated at commit,
    -- i.e. once the member below exists. One RPC call = one transaction,
    -- so a failure aborts the whole creation.
    insert into public.rooms (id, name, share_code, host_member_id, low_stock_threshold)
    values (v_room, btrim(p_room_name), v_code, v_member, p_low_stock_threshold);

    insert into public.members (id, room_id, auth_user_id, display_name)
    values (v_member, v_room, v_auth, btrim(p_display_name));

    return query
    select r.id, r.name, r.share_code, m.id, m.display_name, r.low_stock_threshold
    from public.rooms r
    join public.members m on m.id = v_member
    where r.id = v_room;
end $$;

-- ---------------------------------------------------------------------------
-- join_room (§3, §4): enter by code + display name, issue device-bound member
-- ---------------------------------------------------------------------------
create or replace function public.join_room(
    p_share_code   text,
    p_display_name text
)
returns table (room_id uuid, room_name text, share_code varchar(6),
               member_id uuid, display_name text, low_stock_threshold integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_auth   uuid := auth.uid();
    v_code   varchar(6);
    v_room   uuid;
    v_member uuid;
    v_found  uuid;
begin
    if v_auth is null then
        raise exception 'Anda: not signed in';
    end if;
    if p_display_name is null or btrim(p_display_name) = '' then
        raise exception 'Anda: display name required';
    end if;
    if p_share_code is null then
        raise exception 'Anda: room code required';
    end if;

    v_code := upper(btrim(p_share_code));
    -- Malformed and unknown codes get the same answer (§21: no probing).
    if v_code !~ '^[A-Z0-9]{6}$' then
        raise exception 'Anda: room not found';
    end if;

    select r.id into v_room
    from public.rooms r
    where r.share_code = v_code
      and r.is_active;

    if v_room is null then
        raise exception 'Anda: room not found';
    end if;

    -- Idempotent for an ACTIVE same-device membership (D10): restore identity.
    select m.id into v_found
    from public.members m
    where m.room_id = v_room
      and m.auth_user_id = v_auth
      and m.is_active;

    if v_found is not null then
        return query
        select r.id, r.name, r.share_code, m.id, m.display_name, r.low_stock_threshold
        from public.rooms r
        join public.members m on m.id = v_found
        where r.id = v_room;
        return;
    end if;

    v_member := gen_random_uuid();
    begin
        insert into public.members (id, room_id, auth_user_id, display_name)
        values (v_member, v_room, v_auth, btrim(p_display_name));
    exception when unique_violation then
        -- Race: two simultaneous joins by the same device. Serve the winner.
        select m.id into v_found
        from public.members m
        where m.room_id = v_room
          and m.auth_user_id = v_auth
          and m.is_active;
        if v_found is not null then
            return query
            select r.id, r.name, r.share_code, m.id, m.display_name, r.low_stock_threshold
            from public.rooms r
            join public.members m on m.id = v_found
            where r.id = v_room;
            return;
        end if;
        raise exception 'Anda: already a member of this room';
    end;

    return query
    select r.id, r.name, r.share_code, m.id, m.display_name, r.low_stock_threshold
    from public.rooms r
    join public.members m on m.id = v_member
    where r.id = v_room;
end $$;

-- ---------------------------------------------------------------------------
-- leave_room (§3, §6): soft-deactivate; history preserved; writes blocked
-- ---------------------------------------------------------------------------
create or replace function public.leave_room(p_room_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_member_id uuid := public.current_member_id(p_room_id);
begin
    if v_member_id is null then
        raise exception 'Anda: not a member of this room';
    end if;
    update public.members
       set is_active = false
     where id = v_member_id;
end $$;

-- ---------------------------------------------------------------------------
-- Host powers (§3 — exactly: code regeneration, room soft-deletion)
-- ---------------------------------------------------------------------------
create or replace function public.regenerate_room_code(p_room_id uuid)
returns varchar(6)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_member_id uuid := public.current_member_id(p_room_id);
    v_code      varchar(6);
begin
    if v_member_id is null then
        raise exception 'Anda: not a member of this room';
    end if;
    if not exists (
        select 1 from public.rooms
        where id = p_room_id and host_member_id = v_member_id
    ) then
        raise exception 'Anda: only the room host can change the room code';
    end if;
    v_code := public.generate_share_code();
    update public.rooms
       set share_code = v_code
     where id = p_room_id;
    return v_code;
end $$;

create or replace function public.soft_delete_room(p_room_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_member_id uuid := public.current_member_id(p_room_id);
begin
    if v_member_id is null then
        raise exception 'Anda: not a member of this room';
    end if;
    if not exists (
        select 1 from public.rooms
        where id = p_room_id and host_member_id = v_member_id
    ) then
        raise exception 'Anda: only the room host can delete the room';
    end if;
    update public.rooms
       set is_active = false
     where id = p_room_id;
end $$;

-- ---------------------------------------------------------------------------
-- Grants: the five public RPCs are the ONLY write path for the API
-- (migration 0001, D6). Helpers stay internal.
-- ---------------------------------------------------------------------------
revoke all on function public.create_room(text, text, integer)                   from public;
revoke all on function public.join_room(text, text)                             from public;
revoke all on function public.leave_room(uuid)                                  from public;
revoke all on function public.regenerate_room_code(uuid)                        from public;
revoke all on function public.soft_delete_room(uuid)                            from public;

grant execute on function public.create_room(text, text, integer)              to authenticated;
grant execute on function public.join_room(text, text)                          to authenticated;
grant execute on function public.leave_room(uuid)                              to authenticated;
grant execute on function public.regenerate_room_code(uuid)                    to authenticated;
grant execute on function public.soft_delete_room(uuid)                        to authenticated;

commit;
-- ============================================================================