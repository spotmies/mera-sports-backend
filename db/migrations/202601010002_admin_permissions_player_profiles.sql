-- Admin Control switch "Age & Gender" (default OFF).
-- Idempotent: safe to run on a database that already has this change.
-- Moved from scripts/add_player_profiles_permission.sql (already applied by hand on some environments).
-- migrate:skip-if: select exists (select 1 from information_schema.columns where table_schema='public' and table_name='admin_permissions' and column_name='player_profiles') as ok

ALTER TABLE admin_permissions ADD COLUMN IF NOT EXISTS player_profiles boolean NOT NULL DEFAULT false;

-- Make PostgREST pick up the new column straight away.
NOTIFY pgrst, 'reload schema';
