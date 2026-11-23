-- Admin Control switch "Venue Media" (default OFF).
-- Idempotent: safe to run on a database that already has this change.
-- Moved from scripts/add_venue_media_permission.sql (already applied by hand on some environments).
-- migrate:skip-if: select exists (select 1 from information_schema.columns where table_schema='public' and table_name='admin_permissions' and column_name='venue_media') as ok

ALTER TABLE admin_permissions ADD COLUMN IF NOT EXISTS venue_media boolean NOT NULL DEFAULT false;

-- Make PostgREST pick up the new column straight away.
NOTIFY pgrst, 'reload schema';
