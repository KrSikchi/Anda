-- Anda — pgbench correction template (Phase 5). Substituted per race.
-- __KEY__ = room key; __USAGE_KEY__ = key of the usage to correct.
SET request.jwt.claim.sub = 'cccccccc-0000-0000-0000-0000000000c1';
SELECT public.correct_usage((SELECT v::uuid FROM public.anda_test_state WHERE k = '__KEY__'),
                            (SELECT v::uuid FROM public.anda_test_state WHERE k = '__USAGE_KEY__'), 1);