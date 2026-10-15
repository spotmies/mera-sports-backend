// Applies one SQL migration file to the database in LOCAL_POSTGRES_URL.
//   npm run db:migrate                         -> latest player-profile migration
//   node scripts/migrate.mjs scripts/<file>.sql
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ quiet: true });

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(
    process.argv[2] || path.join(here, "add_flat_building_wing_and_tshirt_size.sql")
);
// ALTER TABLE needs the table OWNER (postgres on Railway). LOCAL_POSTGRES_URL is
// the restricted PostgREST role and is refused with "must be owner of table".
// Put the owner's connection string in MIGRATION_DATABASE_URL (env or .env).
const url = process.env.MIGRATION_DATABASE_URL || process.env.LOCAL_POSTGRES_URL;
if (!url) {
    console.error("Set MIGRATION_DATABASE_URL (owner role) in .env");
    process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
try {
    await client.connect();
    console.log(`Applying ${path.basename(file)} to ${new URL(url).host} ...`);
    await client.query(readFileSync(file, "utf8"));
    console.log("Migration applied.");
} catch (err) {
    console.error("Migration failed:", err.message);
    process.exitCode = 1;
} finally {
    await client.end();
}
