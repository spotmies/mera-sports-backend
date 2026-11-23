# Database migrations

Every database change is a file in `db/migrations/`. The runner (`db/migrate.mjs`)
applies the files a database has not seen yet, in order, once. It runs by itself
on every Railway deploy (QA and PROD) as the **pre-deploy command**.

## Add a migration
1. Create `db/migrations/YYYYMMDDHHMM_what_it_does.sql` (use the current date/time).
2. Write it so it is **safe to run twice**: `ADD COLUMN IF NOT EXISTS`,
   `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. This is what stops a
   database that already has the change from getting stuck.
3. **Only add things** (columns, tables, indexes). Never drop or rename in the same
   release as the code that stops using them: the old version keeps running while
   the new one starts.
4. New tables: grant the API role (see `202601010004_venue_media_table.sql`) and end
   with `notify pgrst, 'reload schema';`.
5. Never edit a migration after it has been merged. Add a new file instead (the
   runner refuses edited files).
6. One-off DATA fixes (backfills, de-duplication) do not belong here. They run once,
   by hand, after you have looked at the data.

## Commands
- `npm run db:migrate:status` — list applied / pending, changes nothing.
- `npm run db:migrate` — apply pending (what Railway runs).

## Settings
- `MIGRATION_DATABASE_URL` — the database OWNER (`postgres`) connection.
  The app's PostgREST role cannot change tables.
- Railway (each environment): backend service → Variables →
  `MIGRATION_DATABASE_URL = ${{Postgres.DATABASE_URL}}`
  and Settings → Deploy → Pre-deploy command: `npm run db:migrate:deploy`.
- Local: put the same variable in `.env` (use the Postgres PUBLIC url).

Applied files are recorded in `ops.schema_migrations`. A change applied locally
(local dev uses the QA database) is skipped when QA deploys, and vice versa.
