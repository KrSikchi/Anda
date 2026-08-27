-- Keep definer functions out of the caller's search path and make the
-- intended RPC surface explicit. Anonymous browser sessions use the
-- authenticated role after sign-in; the unauthenticated anon role has no RPC
-- execution rights.
alter function public.set_updated_at() set search_path = '';
alter function public.prevent_ledger_mutation() set search_path = '';

revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.prevent_ledger_mutation() from public, anon, authenticated;
revoke all on function public.anda_rand_index36() from public, anon, authenticated;
revoke all on function public.generate_share_code() from public, anon, authenticated;
revoke all on function public.update_low_stock_state(uuid) from public, anon, authenticated;
revoke all on function public.low_stock_after_insert() from public, anon, authenticated;

revoke all on function public.is_active_room_member(uuid) from public, anon;
revoke all on function public.current_member_id(uuid) from public, anon;
grant execute on function public.is_active_room_member(uuid) to authenticated;
grant execute on function public.current_member_id(uuid) to authenticated;

revoke all on function public.create_room(text, text, integer) from public, anon;
revoke all on function public.join_room(text, text) from public, anon;
revoke all on function public.leave_room(uuid) from public, anon;
revoke all on function public.regenerate_room_code(uuid) from public, anon;
revoke all on function public.soft_delete_room(uuid) from public, anon;
revoke all on function public.record_purchase(uuid, integer, numeric) from public, anon;
revoke all on function public.record_usage(uuid, integer) from public, anon;
revoke all on function public.correct_usage(uuid, uuid, integer) from public, anon;
revoke all on function public.room_ledger(uuid) from public, anon;
revoke all on function public.room_history(uuid) from public, anon;
revoke all on function public.add_push_subscription(uuid, text, text, text) from public, anon;
revoke all on function public.remove_push_subscription(uuid, text) from public, anon;

grant execute on function public.create_room(text, text, integer) to authenticated;
grant execute on function public.join_room(text, text) to authenticated;
grant execute on function public.leave_room(uuid) to authenticated;
grant execute on function public.regenerate_room_code(uuid) to authenticated;
grant execute on function public.soft_delete_room(uuid) to authenticated;
grant execute on function public.record_purchase(uuid, integer, numeric) to authenticated;
grant execute on function public.record_usage(uuid, integer) to authenticated;
grant execute on function public.correct_usage(uuid, uuid, integer) to authenticated;
grant execute on function public.room_ledger(uuid) to authenticated;
grant execute on function public.room_history(uuid) to authenticated;
grant execute on function public.add_push_subscription(uuid, text, text, text) to authenticated;
grant execute on function public.remove_push_subscription(uuid, text) to authenticated;
