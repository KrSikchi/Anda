-- Supabase installs pgcrypto in the extensions schema, not public.
create or replace function public.anda_rand_index36()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_b bytea := extensions.gen_random_bytes(1);
begin
    while get_byte(v_b, 0) >= 252 loop
        v_b := extensions.gen_random_bytes(1);
    end loop;
    return get_byte(v_b, 0) % 36;
end $$;
