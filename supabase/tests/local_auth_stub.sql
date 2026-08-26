-- ============================================================================
-- Anda — LOCAL-ONLY test helper (NOT a migration; never applied to Supabase)
-- ----------------------------------------------------------------------------
-- Mirrors the Supabase auth.uid() function and the API roles so that the
-- migration's RLS policies can be validated against a local PostgreSQL
-- instance. In Supabase these objects already exist.
--
-- Usage (as the postgres superuser):
--   psql -X -d <db> -f local_auth_stub.sql
-- ============================================================================

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute 'create role authenticated nologin';
    end if;
    if not exists (select 1 from pg_roles where rolname = 'anon') then
        execute 'create role anon nologin';
    end if;
end $$;

create schema if not exists auth;

create or replace function auth.uid() returns uuid
language sql
stable
as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

-- Supabase runs PostgreSQL >= 15; gen_random_uuid() requires >= 13.
do $$
begin
    if current_setting('server_version_num')::int < 130000 then
        raise exception 'Anda requires PostgreSQL >= 13 (local instance is %). Supabase satisfies this.',
            current_setting('server_version_num');
    end if;
end $$;

-- ============================================================================