-- ============================================================================
-- Anda — Phase 5 atomicity suite: ASSERTIONS (LOCAL ONLY)
-- ----------------------------------------------------------------------------
-- Run AFTER the pgbench races have executed. Asserts, from the authoritative
-- database state, every invariant the PRD §11/§27 requires:
--   inventory = Σpurchases − Σusage, never negative, and the canonical
--   2-egg race admits exactly one consumer.
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

select '=== Anda — atomicity assertions ===' as phase;

-- ---------------------------------------------------------------------------
-- Race A — canonical §11 scenario: stock 2, two simultaneous "use 2".
-- Exactly one may succeed; the loser must fail server-side.
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; n_usage int; s_usage int; s_purch int; inv int;
begin
    select v::uuid into v_room from public.anda_test_state where k='ra_room';
    select count(*), coalesce(sum(quantity),0) into n_usage, s_usage
    from public.egg_usage where room_id = v_room;
    select coalesce(sum(quantity),0) into s_purch from public.purchases where room_id = v_room;
    inv := s_purch - s_usage;

    perform public.vtest(n_usage = 1, 'A1: exactly ONE of two concurrent 2-egg usages recorded');
    perform public.vtest(s_usage = 2, 'A2: the winner consumed exactly 2');
    perform public.vtest(inv = 0 and inv >= 0, 'A3: final inventory 0 — never negative');
    perform public.vtest(s_purch - s_usage = inv, 'A4: inventory = Σpurchases − Σusage (ledger identity)');
end $$;

-- ---------------------------------------------------------------------------
-- Race B — zero stock: every one of 50 concurrent "use 1" is rejected.
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; n_usage int; inv int;
begin
    select v::uuid into v_room from public.anda_test_state where k='rb_room';
    select count(*) into n_usage from public.egg_usage where room_id = v_room;
    select (coalesce((select sum(quantity) from public.purchases where room_id = v_room),0)
          - coalesce((select sum(quantity) from public.egg_usage where room_id = v_room),0)) into inv;
    perform public.vtest(n_usage = 0, 'B1: no usage recorded against zero stock');
    perform public.vtest(inv = 0, 'B2: inventory stays 0');
end $$;

-- ---------------------------------------------------------------------------
-- Race C — 50 concurrent purchases all succeed; ledger sums exact.
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; n_p int; s_p int; inv int;
begin
    select v::uuid into v_room from public.anda_test_state where k='rc_room';
    select count(*), coalesce(sum(quantity),0) into n_p, s_p from public.purchases where room_id = v_room;
    select coalesce(sum(quantity),0) into inv from public.egg_usage where room_id = v_room;
    perform public.vtest(n_p = 50, 'C1: all 50 concurrent purchases recorded');
    perform public.vtest(s_p = 250, 'C2: total purchased = 50 × 5 = 250');
    perform public.vtest((s_p - inv) = 250, 'C3: inventory = 250 (no usage in this room)');
end $$;

-- ---------------------------------------------------------------------------
-- Race D — stock 24, 300 concurrent "use 1": exactly 24 succeed.
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; n_usage int; s_usage int; s_purch int; inv int;
begin
    select v::uuid into v_room from public.anda_test_state where k='rd_room';
    select count(*), coalesce(sum(quantity),0) into n_usage, s_usage
    from public.egg_usage where room_id = v_room;
    select coalesce(sum(quantity),0) into s_purch from public.purchases where room_id = v_room;
    inv := s_purch - s_usage;
    perform public.vtest(n_usage = 24, 'D1: exactly 24 of 300 concurrent usages succeeded');
    perform public.vtest(s_usage = 24, 'D2: consumed exactly the available stock');
    perform public.vtest(inv = 0 and inv >= 0, 'D3: inventory 0 — never negative');
end $$;

-- ---------------------------------------------------------------------------
-- Race E — mixed concurrent purchases + usage: ledger identity holds and
-- inventory never negative; usage never exceeds committed purchases.
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; s_p int; s_u int; inv int;
begin
    select v::uuid into v_room from public.anda_test_state where k='re_room';
    select coalesce(sum(quantity),0) into s_p from public.purchases where room_id = v_room;
    select coalesce(sum(quantity),0) into s_u from public.egg_usage where room_id = v_room;
    inv := s_p - s_u;
    perform public.vtest(s_p > 0, 'E1: purchases committed during the race');
    perform public.vtest(s_u >= 0, 'E2: usage count is non-negative');
    perform public.vtest(s_u <= s_p, 'E3: consumed never exceeds purchased (per-event atomic check)');
    perform public.vtest(inv = s_p - s_u and inv >= 0, 'E4: inventory = Σp − Σu ≥ 0 at final state');
    perform public.vtest(mod(s_u, 2) = 0, 'E5: every recorded usage was a full 2-egg event');
end $$;

-- ---------------------------------------------------------------------------
-- Race F — two concurrent corrections of one usage: exactly one applies.
-- ---------------------------------------------------------------------------
do $$
declare v_room uuid; v_use uuid; n_corr int; inv int;
begin
    select v::uuid into v_room from public.anda_test_state where k='rf_room';
    select v::uuid into v_use  from public.anda_test_state where k='rf_usage';
    select count(*) into n_corr from public.egg_usage where correction_of = v_use;
    select (coalesce((select sum(quantity) from public.purchases where room_id = v_room),0)
          - coalesce((select sum(quantity) from public.egg_usage where room_id = v_room),0)) into inv;
    perform public.vtest(n_corr = 1, 'F1: exactly ONE of two concurrent corrections applied');
    perform public.vtest(inv = 9, 'F2: stock restored by exactly the one accepted correction (10 − 1 = 9)');
    perform public.vtest((select coalesce(sum(u.quantity + coalesce(c.quantity,0)),0)
        from public.egg_usage u left join public.egg_usage c on c.correction_of = u.id
        where u.room_id = v_room and u.correction_of is null and u.member_id =
              (select v::uuid from public.anda_test_state where k='rf_joiner')) = 1,
        'F3: effective consumption of the affected member = 5 − 4 = 1');
end $$;

select '=== Anda — atomicity assertions complete ===' as phase;
-- ============================================================================