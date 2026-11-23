-- Player profile: flat/building/wing address line and T-shirt size (users).
-- Idempotent: safe to run on a database that already has this change.
-- Moved from scripts/add_flat_building_wing_and_tshirt_size.sql (already applied by hand on some environments).
-- migrate:skip-if: select count(*) = 2 as ok from information_schema.columns where table_schema='public' and table_name='users' and column_name in ('flat_building_wing','tshirt_size')

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS flat_building_wing text,
    ADD COLUMN IF NOT EXISTS tshirt_size        text;

-- PostgREST caches the schema; without this the new columns 400 until restart.
NOTIFY pgrst, 'reload schema';

-- The admin toggles are stored in platform_settings.registration_config (JSONB)
-- as showBuilding (flat/building/wing) and showTshirt — no schema change.
-- Until an admin flips them, both default to shown.
