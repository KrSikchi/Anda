-- ============================================================================
-- Anda — Database Schema
-- Migration 0001 — Initial schema (PRD Phase 2: Data Model)
--
-- Product: Anda (shared egg inventory & settlement tracker)
-- Scope: MVP exactly as defined in the binding PRD. Nothing beyond it.
--
-- Implements:
--   §6  Core data model (rooms, members, purchases, egg_usage, settlements)
--   §7  Transactional ledger (transactions are source of truth;
--       inventory is never stored as a primary value)
--   §8  Purchases (quantity, total_cost, derived cost_per_egg, historical
--       pricing preserved)
--   §9  Usage (immutable consumption records associated with the member)
--   §10 Corrections (compensating transactions linked to the original;
--       no destructive edits)
--   §16 Low-stock state flag (threshold + notification state persist here;
--       crossing logic is a later-phase trigger)
--   §5/§21/§25 RLS authorization boundary + DB-enforced constraints
--
-- Implementation decisions (documented per PRD §32; nothing invented):
--   D1 Identity    members.id is the private member_id (§4). RLS requires the
--                  database to know the caller, so members.auth_user_id binds
--                  the member row to a Supabase anonymous-auth principal
--                  (§19: "Supabase Auth (anonymous / custom JWT) or pure
--                  custom member tokens"). No email/password/OAuth anywhere.
--   D2 Host        rooms.host_member_id records host identity (§6). The FK is
--                  DEFERRABLE INITIALLY DEFERRED because a room and its host
--                  member are created in one transaction; NOT NULL guarantees
--                  every room has a host. Host powers remain exactly the PRD
--                  §3 set: creation, code regeneration, soft deletion — no
--                  extra host powers.
--   D3 Corrections egg_usage.quantity is positive for consumption and negative
--                  for compensating corrections (§10), DB-enforced. correction_of
--                  links to the original with a composite FK that guarantees
--                  the referenced usage belongs to the same room.
--   D4 Cost/egg    cost_per_egg is a GENERATED column (total_cost / quantity):
--                  derived, historical pricing never overwritten (§8).
--   D5 Deletion    Every FK is ON DELETE RESTRICT. Hard deletes are blocked so
--                  history cannot be destroyed; lifecycle changes use the
--                  soft-delete flags only (§3, §6, §10, §29 immutability).
--   D6 Writes      RLS grants SELECT only. All mutations go through SECURITY
--                  DEFINER functions added in Phases 3–5, which re-validate
--                  authorization and integrity server-side (§5, §21). The
--                  browser is never trusted.
--   D7 Settlements Structural-only table satisfying §6's core data model; inert
--                  in the MVP (no API, no UI, no payment processing).
--
-- Deferred to later phases per PRD §28 sequence (not part of this migration):
--   - negative-inventory atomic check trigger   → Phase 5 (Atomicity)
--   - low-stock threshold-crossing trigger      → Phase 8 (Notifications)
--   - SECURITY DEFINER RPCs (create/join/leave,
--     purchases, usage, corrections, host ops)  → Phases 3–5
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- rooms (§6): room identity, name, share code, host, lifecycle, low-stock
-- ---------------------------------------------------------------------------
create table public.rooms (
    id                  uuid        primary key default gen_random_uuid(),
    name                text        not null check (btrim(name) <> ''),
    share_code          varchar(6)  not null check (share_code ~ '^[A-Z0-9]{6}$'),
    host_member_id      uuid        not null,
    low_stock_threshold integer     not null default 10 check (low_stock_threshold > 0),
    low_stock_notified  boolean     not null default false,
    is_active           boolean     not null default true,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint uq_rooms_share_code unique (share_code)
);

-- ---------------------------------------------------------------------------
-- members (§4, §6): device-bound pseudonymous member identity
-- ---------------------------------------------------------------------------
create table public.members (
    id              uuid        primary key default gen_random_uuid(),
    room_id         uuid        not null,
    auth_user_id    uuid,                       -- Supabase anonymous-auth binding (D1)
    display_name    text        not null check (btrim(display_name) <> ''),
    is_active       boolean     not null default true,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    constraint fk_members_room foreign key (room_id) references public.rooms (id) on delete restrict,
    constraint uq_members_room_id unique (room_id, id)
);

-- Host FK added after members exists (circular reference; D2).
alter table public.rooms
    add constraint fk_rooms_host
    foreign key (id, host_member_id) references public.members (room_id, id)
    deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- purchases (§8): immutable ledger entries
-- ---------------------------------------------------------------------------
create table public.purchases (
    id           uuid          primary key default gen_random_uuid(),
    room_id      uuid          not null,
    member_id    uuid          not null,
    quantity     integer       not null check (quantity > 0),
    total_cost   numeric(10,2) not null check (total_cost >= 0),
    cost_per_egg numeric       generated always as (total_cost / nullif(quantity, 0)) stored, -- D4; NULLIF keeps the CHECK(quantity>0) the clean error surface
    recorded_at  timestamptz   not null default now(),
    constraint fk_purchases_room        foreign key (room_id)      references public.rooms (id) on delete restrict,
    constraint fk_purchases_room_member foreign key (room_id, member_id) references public.members (room_id, id) on delete restrict
);

-- ---------------------------------------------------------------------------
-- egg_usage (§9, §10): immutable usage + compensating corrections
-- ---------------------------------------------------------------------------
create table public.egg_usage (
    id            uuid        primary key default gen_random_uuid(),
    room_id       uuid        not null,
    member_id     uuid        not null,
    quantity      integer     not null,
    correction_of uuid,
    recorded_at   timestamptz not null default now(),
    constraint fk_egg_usage_room          foreign key (room_id) references public.rooms (id) on delete restrict,
    constraint fk_egg_usage_member        foreign key (member_id) references public.members (id) on delete restrict,
    constraint fk_egg_usage_room_member   foreign key (room_id, member_id) references public.members (room_id, id) on delete restrict,
    constraint fk_egg_usage_correction    foreign key (room_id, correction_of) references public.egg_usage (room_id, id) on delete restrict,
    constraint uq_egg_usage_room_id       unique (room_id, id),
    constraint chk_egg_usage_sign         check (
        (correction_of is null and quantity > 0)
        or
        (correction_of is not null and quantity < 0)
    )
);

-- ---------------------------------------------------------------------------
-- settlements (§6): STRUCTURALLY PREPARED ONLY — inert in the MVP (D7).
-- No API, no UI, no payment-processing functionality of any kind.
-- ---------------------------------------------------------------------------
create table public.settlements (
    id            uuid          primary key default gen_random_uuid(),
    room_id       uuid          not null,
    from_member_id uuid,
    to_member_id  uuid,
    amount        numeric(10,2) check (amount is null or amount > 0),
    status        text,
    recorded_at   timestamptz   not null default now(),
    constraint fk_settlements_room  foreign key (room_id) references public.rooms (id) on delete restrict,
    constraint fk_settlements_from  foreign key (room_id, from_member_id) references public.members (room_id, id) on delete restrict,
    constraint fk_settlements_to    foreign key (room_id, to_member_id) references public.members (room_id, id) on delete restrict
);

-- ---------------------------------------------------------------------------
-- Indexes (§25): room-scoped, member-scoped, timestamp, active membership
-- ---------------------------------------------------------------------------
create index idx_rooms_host_member         on public.rooms       (host_member_id);
create index idx_members_auth_user         on public.members     (auth_user_id);
create index idx_members_room_active       on public.members     (room_id) where is_active;
create index idx_purchases_room_time       on public.purchases   (room_id, recorded_at desc);
create index idx_purchases_room_member_time on public.purchases  (room_id, member_id, recorded_at desc);
create index idx_egg_usage_room_time       on public.egg_usage   (room_id, recorded_at desc);
create index idx_egg_usage_room_member_time on public.egg_usage  (room_id, member_id, recorded_at desc);
create index idx_settlements_room          on public.settlements (room_id);

-- A device (anonymous-auth principal) may not hold two ACTIVE memberships in
-- one room; leaving (is_active=false) then re-joining is still allowed (§4, §9).
create unique index uq_members_active_device_room
    on public.members (auth_user_id, room_id)
    where is_active and auth_user_id is not null;

-- ---------------------------------------------------------------------------
-- Triggers: heartbeat timestamps + ledger append-only immutability
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end; $$;

create or replace function public.prevent_ledger_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'Anda: ledger transactions are immutable (PRD §7/§10/§29). Correct via a compensating correction transaction, never an edit or delete.';
end; $$;

drop trigger if exists trg_rooms_updated_at on public.rooms;
create trigger trg_rooms_updated_at before update on public.rooms
    for each row execute function public.set_updated_at();
drop trigger if exists trg_members_updated_at on public.members;
create trigger trg_members_updated_at before update on public.members
    for each row execute function public.set_updated_at();

drop trigger if exists trg_purchases_append_only on public.purchases;
create trigger trg_purchases_append_only before update or delete on public.purchases
    for each row execute function public.prevent_ledger_mutation();
drop trigger if exists trg_egg_usage_append_only on public.egg_usage;
create trigger trg_egg_usage_append_only before update or delete on public.egg_usage
    for each row execute function public.prevent_ledger_mutation();

-- ---------------------------------------------------------------------------
-- RLS (§5, §21): SELECT is granted ONLY to authenticated (anonymous-auth)
-- members of the room via auth.uid(). No INSERT/UPDATE/DELETE policies:
-- the API role has no direct write path at all (D6).
-- ---------------------------------------------------------------------------
-- Helper (SECURITY DEFINER to avoid RLS recursion; search_path pinned; D6).
-- Answer: is the caller (auth.uid()) an ACTIVE member of an ACTIVE room?
-- The room-active condition is what makes a soft-deleted room fully invisible,
-- including its ledger rows (validated by test R6b).
create or replace function public.is_active_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.rooms r
        join public.members m on m.room_id = r.id
        where r.id = p_room_id
          and r.is_active
          and m.auth_user_id = auth.uid()
          and m.is_active
    );
$$;

revoke all on function public.is_active_room_member(uuid) from public;
grant  execute on function public.is_active_room_member(uuid) to authenticated;

alter table public.rooms       enable row level security;
alter table public.members     enable row level security;
alter table public.purchases   enable row level security;
alter table public.egg_usage   enable row level security;
alter table public.settlements enable row level security;

create policy rooms_visible_to_active_member on public.rooms
    for select to authenticated
    using (is_active and public.is_active_room_member(id));

create policy members_visible_to_active_member on public.members
    for select to authenticated
    using (public.is_active_room_member(room_id));

create policy purchases_visible_to_active_member on public.purchases
    for select to authenticated
    using (public.is_active_room_member(room_id));

create policy egg_usage_visible_to_active_member on public.egg_usage
    for select to authenticated
    using (public.is_active_room_member(room_id));

create policy settlements_visible_to_active_member on public.settlements
    for select to authenticated
    using (public.is_active_room_member(room_id));

-- Explicit grants: only authenticated (anonymous-auth) members may read.
grant select on public.rooms, public.members, public.purchases, public.egg_usage, public.settlements
    to authenticated;

-- ---------------------------------------------------------------------------
commit;
-- ============================================================================