-- One more switch in Admin Control: Venue Media. Defaults to OFF, since admins had
-- no access to it before, so applying this changes nothing until a super admin
-- turns it on for an admin.
--
--   node scripts/migrate.mjs scripts/add_venue_media_permission.sql
ALTER TABLE admin_permissions ADD COLUMN IF NOT EXISTS venue_media boolean NOT NULL DEFAULT false;

-- Make PostgREST pick up the new column straight away.
NOTIFY pgrst, 'reload schema';
