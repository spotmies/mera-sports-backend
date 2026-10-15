-- Player registration: "Flat / Building / Wing" address line and T-shirt size.
--
-- Run once against the Railway Postgres behind PostgREST, as the table OWNER
-- (postgres) — the merasports_api role is refused. Run on every env BEFORE deploying the backend
-- that writes these columns:   MIGRATION_DATABASE_URL=<owner url> npm run db:migrate
-- Safe to re-run. Existing rows stay NULL; no existing column is touched.
--
-- Supersedes add_building_address.sql (never applied; column was renamed).
ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS flat_building_wing text,
    ADD COLUMN IF NOT EXISTS tshirt_size        text;

-- PostgREST caches the schema; without this the new columns 400 until restart.
NOTIFY pgrst, 'reload schema';

-- The admin toggles are stored in platform_settings.registration_config (JSONB)
-- as showBuilding (flat/building/wing) and showTshirt — no schema change.
-- Until an admin flips them, both default to shown.
