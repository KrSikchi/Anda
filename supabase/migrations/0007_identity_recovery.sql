-- ============================================================================
-- Anda — Identity recovery (PRD §15, §16, §17, §44)
-- Migration 0007
--
-- Why this exists
-- ---------------
-- Members are bound to a Supabase auth principal through
-- members.auth_user_id = auth.uid() (migration 0001, D1). With anonymous
-- sessions that is enough: the device holds the JWT and the room binding is
-- cached locally, so re-opening Anda works.
--
-- The moment a user takes up OPTIONAL email/password persistence, a second
-- scenario appears that the schema cannot currently answer: the user signs in
-- on a device that has no local state (new phone, cleared browser storage,
-- reinstalled PWA). The permanent uid comes back from the password, but
-- nothing tells the client WHICH rooms that identity belongs to. PRD §51
-- requires that case to work ("Authenticated user can recover after clearing
-- local browser state"), and PRD §44 requires the outcome to be "same member,
-- same history" — never a duplicate person.
--
-- This migration adds exactly one read-only RPC that answers it. It does not
-- change the identity model, does not touch memberships, and creates no
-- members: recovery is a lookup over rows that already exist.
--
-- Deliberately NOT included here
-- ------------------------------
--   - any merge/duplicate-person logic  (would let a caller claim someone
--     else's history; PRD §44 forbids creating a duplicate, and the safe way
--     to keep one history is the in-place anonymous -> permanent upgrade,
--     which preserves auth.uid() and therefore needs no merge at all)
--   - any client-supplied identity     (the caller is identified by the
--     verified JWT alone; auth.uid() is never accepted from the browser)
--   - settlement / purchase changes    (separate migrations, §43)
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- my_memberships(): every active room the calling identity already belongs to.
--
-- Read-only, STABLE, and scoped by auth.uid() inside the function — RLS would
-- also restrict the underlying reads, but the function never relies on that
-- alone (0001 D6: the server re-validates; the browser is never trusted).
-- Soft-deleted rooms and inactive memberships are invisible, consistent with
-- is_active_room_member().
-- ---------------------------------------------------------------------------
create or replace function public.my_memberships()
returns table (
    room_id             uuid,
    room_name           text,
    share_code          varchar(6),
    member_id           uuid,
    display_name        text,
    is_host             boolean,
    low_stock_threshold integer,
    member_count        integer,
    joined_at           timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
    select r.id,
           r.name,
           r.share_code,
           m.id,
           m.display_name,
           (r.host_member_id = m.id)        as is_host,
           r.low_stock_threshold,
           (select count(*)::integer
              from public.members x
             where x.room_id = r.id
               and x.is_active)             as member_count,
           m.created_at                     as joined_at
      from public.members m
      join public.rooms r on r.id = m.room_id
     where m.auth_user_id = auth.uid()
       and m.is_active
       and r.is_active
     order by m.created_at desc;
$$;

-- Same discipline as the other RPCs (see 20260827050058_harden_rpc_functions):
-- deny everything, then grant only to the authenticated role.
revoke all on function public.my_memberships() from public;
revoke all on function public.my_memberships() from anon;
grant execute on function public.my_memberships() to authenticated;

commit;
