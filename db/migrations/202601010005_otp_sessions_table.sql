-- otp_sessions: shared OTP store so OTPs survive restarts and work across instances.
-- Idempotent: safe to run on a database that already has this change.
-- Moved from scripts/otp_sessions_migration.sql (already applied by hand on some environments).
-- migrate:skip-if: select to_regclass('public.otp_sessions') is not null as ok

create table if not exists public.otp_sessions (
    id           uuid primary key default gen_random_uuid(),  -- core fn (PG13+), no extension needed
    channel      text not null check (channel in ('mobile', 'email')),
    session_key  text not null,   -- sessionId (mobile/WhatsApp) or email address
    otp          text not null,
    expires_at   timestamptz not null,
    created_at   timestamptz not null default now(),
    unique (channel, session_key)
);

create index if not exists idx_otp_sessions_expires_at
    on public.otp_sessions (expires_at);

-- Grant the PostgREST API role the DML it needs. Guarded so the script never
-- aborts if the role is absent/renamed in a given environment (RLS is not used
-- on this table — authorization stays in the API middleware, per the migration).
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'merasports_api') then
        grant select, insert, update, delete on public.otp_sessions to merasports_api;
        raise notice 'Granted DML on public.otp_sessions to merasports_api';
    else
        raise notice 'Role merasports_api not found — GRANT skipped. Grant manually to your PostgREST role.';
    end if;
end $$;

-- Optional housekeeping: purge expired rows (consumed rows are deleted on verify).
delete from public.otp_sessions where expires_at < now();

-- Make PostgREST expose the new table immediately (no restart needed).
notify pgrst, 'reload schema';
