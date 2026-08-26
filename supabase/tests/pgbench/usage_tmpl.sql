-- Anda — pgbench usage template (Phase 5). Substituted per race.
-- __KEY__ = anda_test_state key of the room; __QTY__ = eggs consumed.
SET request.jwt.claim.sub = 'cccccccc-0000-0000-0000-0000000000c1';
SELECT public.record_usage((SELECT v::uuid FROM public.anda_test_state WHERE k = '__KEY__'), __QTY__);