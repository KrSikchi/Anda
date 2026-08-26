-- ============================================================================
-- Anda — Low-stock notifications (PRD Phase 8)
-- Migration 0006
--
-- Implements (binding PRD):
--   §16 Low-stock notifications — configurable threshold (default 10);
--        notification only when authoritative inventory crosses from ABOVE the
--        threshold to AT OR BELOW it; further decrements inside the episode do
--        not spam; persistent flag low_stock_notified is reset only after
--        inventory rises above the threshold again (then a later crossing can
--        notify again).
--   §17 Push notification identity — no email accounts; notification
--        subscriptions are associated with the device/member identity
--        (room → member → device/push subscription); delivery targets the
--        room's ACTIVE members' VALID subscriptions; invalid/expired
--        subscriptions are cleaned up. No general notification center — only
--        the low-stock use case.
--   §19 Server-side logic = Supabase Edge Functions; §28 Phase 8.
--
-- Decisions (PRD §32):
--   D26 State machine on rooms.low_stock_notified:
--         inventory > threshold        → re-arm (flag := false)
--         inventory <= threshold       → if not flagged: flag := true + emit
--                                          one low_stock_alerts row (the
--                                          notification trigger); if flagged:
--                                          do nothing (no spam).
--         An episode that STARTS at/below the threshold (first purchase) emits
--         one alert too — "one notification per low-stock episode".
--   D27 Detection is a same-transaction AFTER-INSERT trigger over the ledger:
--        ledger rows are append-only (0001), so INSERT triggers cover every
--        possible stock change; the surrounding RPC already serializes on the
--        room row (D13/D19), so the recompute is atomic and rollback-safe with
--        §11 — a rejected mutation emits no alert, a committed one does.
--   D28 push_subscriptions is keyed to (room, member) with an upsert-on-
--        endpoint; delivery joins members.is_active; the Edge Function deletes
--        invalid/expired endpoints on 404/410 Gone (§17 step 4).
--   D29 low_stock_alerts is an INTERNAL queue: RLS-enabled with no member
--        policies (not a product screen; audit + webhook source). The Supabase
--        Database Webhook (INSERT on low_stock_alerts) invokes the
--        low-stock-notify Edge Function, which runs with the service role
--        (bypasses RLS) to read subscriptions and mark delivery.
--   D30 Delivery uses the Deno-native Web Push library (RFC 8291/8292) in the
--        Edge Function; the pure helpers (VAPID JWT, payload, endpoint-verdict
--        classification, active-subscription filtering) live in
--        supabase/functions/_shared/ and are unit-tested in Node; full
--        end-to-end delivery is verified at Phase 10 against the hosted
--        service.
--
-- Friendly messages (§24):
--   Anda: not a member of this room
--   Anda: invalid push endpoint
--   Anda: invalid push key
--   Anda: invalid push secret
-- ============================================================================

begin;

-- RLS policies in this migration call public.current_member_id(); it was
-- created SECURITY DEFINER but never granted to the API role (0002 grants only
-- the lifecycle RPCs). Granting EXECUTE is safe: it is a stable, read-only,
-- pinned-search_path helper.
grant execute on function public.current_member_id(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- push_subscriptions (§17): room → member → device push endpoint
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
    id          uuid        primary key default gen_random_uuid(),
    room_id     uuid        not null,
    member_id   uuid        not null,
    endpoint    text        not null check (endpoint ~ '^https://'),
    p256dh      text        not null check (p256dh ~ '^[A-Za-z0-9_-]{20,}$'),
    auth_secret text        not null check (auth_secret ~ '^[A-Za-z0-9_-]{10,}$'),
    created_at  timestamptz not null default now(),
    constraint fk_ps_member      foreign key (member_id) references public.members (id) on delete restrict,
    constraint fk_ps_room_member foreign key (room_id, member_id) references public.members (room_id, id) on delete restrict,
    constraint uq_ps_endpoint    unique (endpoint)
);

create index idx_ps_room on public.push_subscriptions (room_id);

-- ---------------------------------------------------------------------------
-- low_stock_alerts (D29): internal episode queue; audit + webhook trigger
-- ---------------------------------------------------------------------------
create table public.low_stock_alerts (
    id           uuid         primary key default gen_random_uuid(),
    room_id      uuid         not null,
    inventory    integer      not null,
    threshold    integer      not null,
    created_at   timestamptz  not null default now(),
    delivered_at timestamptz  null,
    constraint fk_lsa_room foreign key (room_id) references public.rooms (id) on delete restrict
);

create index idx_lsa_room_time on public.low_stock_alerts (room_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.push_subscriptions enable row level security;
alter table public.low_stock_alerts   enable row level security;

-- A member may read only their OWN subscriptions (endpoints are device-bound).
create policy ps_owner_select on public.push_subscriptions
    for select to authenticated
    using (member_id = public.current_member_id(room_id));

-- low_stock_alerts: NO member policies and NO grants — internal (D29).
-- Writes to both tables happen via SECURITY DEFINER RPCs / service role only.

grant select on public.push_subscriptions to authenticated;
-- no grants on low_stock_alerts for anon/authenticated

-- ---------------------------------------------------------------------------
-- Low-stock state machine (§16, D26)
-- ---------------------------------------------------------------------------
create or replace function public.update_low_stock_state(p_room_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_inv      integer;
    v_thr      integer;
    v_notified boolean;
begin
    select
        (select coalesce(sum(p.quantity), 0) from public.purchases p where p.room_id = p_room_id)
      - (select coalesce(sum(u.quantity), 0) from public.egg_usage u where u.room_id = p_room_id)
      into v_inv;
    select ro.low_stock_threshold, ro.low_stock_notified into v_thr, v_notified
    from public.rooms ro where ro.id = p_room_id;

    if v_inv > v_thr then
        -- Back above the threshold: re-arm for the next episode (§16).
        update public.rooms ro set low_stock_notified = false where ro.id = p_room_id;
    elsif not v_notified then
        -- Entered at-or-below threshold (or started there): exactly one alert.
        update public.rooms ro set low_stock_notified = true where ro.id = p_room_id;
        insert into public.low_stock_alerts (room_id, inventory, threshold)
        values (p_room_id, v_inv, v_thr);
    end if;
    -- else: already flagged → stay silent (no spam on further decrements).
end $$;

-- D27: fire in the same transaction as every ledger mutation.
create or replace function public.low_stock_after_insert()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
    perform public.update_low_stock_state(new.room_id);
    return new;
end $$;

drop trigger if exists trg_purchases_low_stock on public.purchases;
create trigger trg_purchases_low_stock after insert on public.purchases
    for each row execute function public.low_stock_after_insert();

drop trigger if exists trg_egg_usage_low_stock on public.egg_usage;
create trigger trg_egg_usage_low_stock after insert on public.egg_usage
    for each row execute function public.low_stock_after_insert();

revoke all on function public.update_low_stock_state(uuid) from public;
revoke all on function public.low_stock_after_insert() from public;

-- ---------------------------------------------------------------------------
-- Subscription RPCs (§17): writes via SECURITY DEFINER only (D6)
-- ---------------------------------------------------------------------------
create or replace function public.add_push_subscription(
    p_room_id  uuid,
    p_endpoint text,
    p_p256dh   text,
    p_auth     text
)
returns table (id uuid, sub_endpoint text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_mid uuid := public.current_member_id(p_room_id);
    v_row record;
begin
    if v_mid is null then
        raise exception 'Anda: not a member of this room';
    end if;
    if p_endpoint is null or p_endpoint !~ '^https://' then
        raise exception 'Anda: invalid push endpoint';
    end if;
    if p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{20,}$' then
        raise exception 'Anda: invalid push key';
    end if;
    if p_auth is null or p_auth !~ '^[A-Za-z0-9_-]{10,}$' then
        raise exception 'Anda: invalid push secret';
    end if;

    with ins as (
        insert into public.push_subscriptions (room_id, member_id, endpoint, p256dh, auth_secret)
        values (p_room_id, v_mid, p_endpoint, p_p256dh, p_auth)
        on conflict (endpoint) do update
        set room_id    = excluded.room_id,
            member_id  = excluded.member_id,
            p256dh     = excluded.p256dh,
            auth_secret = excluded.auth_secret,
            created_at = now()
        returning *
    )
    select * into v_row from ins;

    return query select v_row.id, v_row.endpoint;
end $$;

create or replace function public.remove_push_subscription(
    p_room_id  uuid,
    p_endpoint text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_mid uuid := public.current_member_id(p_room_id);
begin
    if v_mid is null then
        raise exception 'Anda: not a member of this room';
    end if;
    -- Owner-scoped: only this member's own endpoint is removed.
    delete from public.push_subscriptions
     where room_id = p_room_id
       and member_id = v_mid
       and endpoint = p_endpoint;
end $$;

revoke all on function public.add_push_subscription(uuid, text, text, text) from public;
revoke all on function public.remove_push_subscription(uuid, text)      from public;
grant execute on function public.add_push_subscription(uuid, text, text, text) to authenticated;
grant execute on function public.remove_push_subscription(uuid, text)      to authenticated;

commit;
-- ============================================================================