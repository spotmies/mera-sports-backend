-- events.single_category_only: limit players to one category (default false).
-- Idempotent: safe to run on a database that already has this change.
-- Moved from scripts/single_category_only_migration.sql (already applied by hand on some environments).
-- migrate:skip-if: select exists (select 1 from information_schema.columns where table_schema='public' and table_name='events' and column_name='single_category_only') as ok

alter table public.events
    add column if not exists single_category_only boolean not null default false;

-- PostgREST caches the schema; make it see the new column straight away.
notify pgrst, 'reload schema';
