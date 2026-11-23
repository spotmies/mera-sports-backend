-- events.age_by_event_year: count age groups in the event year (default false).
-- Idempotent: safe to run on a database that already has this change.
-- Moved from scripts/age_by_event_year_migration.sql (already applied by hand on some environments).

alter table public.events
    add column if not exists age_by_event_year boolean not null default false;

-- PostgREST caches the schema; make it see the new column straight away.
notify pgrst, 'reload schema';
