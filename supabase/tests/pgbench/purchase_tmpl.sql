-- Anda — pgbench purchase template (Phase 5). Substituted per race.
-- __KEY__ = anda_test_state key of the room; __QTY__; __COST__.
SET request.jwt.claim.sub = 'cccccccc-0000-0000-0000-0000000000c1';
SELECT public.record_purchase((SELECT v::uuid FROM public.anda_test_state WHERE k = '__KEY__'), __QTY__, __COST__);