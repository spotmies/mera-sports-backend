// Database migration runner — the same command on local, QA and PROD.
//
//   npm run db:migrate           apply every pending migration in db/migrations
//   npm run db:migrate:status    list applied / pending, change nothing
//   node db/migrate.mjs --dry-run   same as status (kept for habit)
//
// On Railway it runs as the service's PRE-DEPLOY COMMAND, before the new
// version starts. If a migration fails the deploy fails and the running
// version stays up — users never see a half-migrated app.
//
// How it stays safe
//   - Applied files are recorded in ops.schema_migrations, so a file runs once
//     per database. A migration applied locally (local dev points at QA) is
//     skipped when QA deploys, and the other way round.
//   - Every file must be idempotent (IF NOT EXISTS ...), so a database that
//     already had the change applied by hand does not get stuck.
//   - Baseline files (changes older than this runner) also carry a
//     `-- migrate:skip-if: select <boolean> as ok` probe: if the change is
//     already there they are recorded WITHOUT running, so working tables are
//     not touched at all.
//   - Each file runs in ONE transaction: it fully applies or leaves nothing.
//   - A lock stops two deploys migrating the same database at once.
//   - lock_timeout stops a migration waiting forever behind a busy table.
//   - Editing an already-applied file is refused (checksum). Add a new file.
//
// Connection: MIGRATION_DATABASE_URL — the table OWNER (`postgres`), NOT the
// restricted PostgREST role the app uses (that role cannot change tables).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ quiet: true });

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, "migrations");
const LOCK_KEY = 727274101; // any constant; identifies "migrating this database"
const FILE_RE = /^\d{12}_[a-z0-9_]+\.sql$/;

const args = new Set(process.argv.slice(2));
const statusOnly = args.has("--status") || args.has("--dry-run");

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
    console.error(
        "❌ MIGRATION_DATABASE_URL is not set.\n" +
        "   Set it to the database OWNER connection (Railway Postgres → `postgres` user).\n" +
        "   The app's own POSTGREST/LOCAL_POSTGRES_URL role cannot run migrations."
    );
    process.exit(1);
}

let host = "?";
try { host = new URL(url).host; } catch { /* leave as ? */ }
// Public Railway proxy hosts need SSL; internal/local hosts do not.
const sslOverride = process.env.MIGRATION_DB_SSL;
const useSsl = sslOverride ? sslOverride === "true" : !/localhost|127\.0\.0\.1|railway\.internal/.test(url);

const normalize = (text) => text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
const checksumOf = (text) => createHash("sha256").update(text).digest("hex");

const loadFiles = () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql")).sort();
    const bad = names.filter((n) => !FILE_RE.test(n));
    if (bad.length) {
        throw new Error(
            `Migration file names must look like 202611231000_what_it_does.sql — fix: ${bad.join(", ")}`
        );
    }
    return names.map((name) => {
        const sql = normalize(readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
        return { id: name.replace(/\.sql$/, ""), sql, checksum: checksumOf(sql) };
    });
};

const client = new pg.Client({ connectionString: url, ssl: useSsl ? { rejectUnauthorized: false } : false });
client.on("notice", (msg) => console.log(`   ℹ️  ${msg.message}`));

let exitCode = 0;
try {
    const files = loadFiles();
    await client.connect();
    console.log(`Database: ${host}${statusOnly ? "  (status only — nothing will change)" : ""}`);

    // One migrator at a time per database. Released when the connection closes.
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);

    // `ops`, not `public`: PostgREST only exposes public, so this bookkeeping
    // table can never be reached through the API.
    // Status mode creates nothing: a database never migrated just reads as empty.
    let applied = new Map();
    if (!statusOnly) {
        await client.query("create schema if not exists ops");
        await client.query(`
            create table if not exists ops.schema_migrations (
                id          text primary key,
                checksum    text not null,
                applied_at  timestamptz not null default now(),
                duration_ms integer
            )`);
    }
    const tableExists = (await client.query("select to_regclass('ops.schema_migrations') is not null as ok")).rows[0].ok;
    if (tableExists) {
        const { rows } = await client.query("select id, checksum from ops.schema_migrations");
        applied = new Map(rows.map((r) => [r.id, r.checksum]));
    }

    // A file that changed after it was applied means environments could now
    // disagree about what that migration did. Stop rather than guess.
    const edited = files.filter((f) => applied.has(f.id) && applied.get(f.id) !== f.checksum);
    if (edited.length) {
        throw new Error(
            `These migrations were already applied but their file has CHANGED: ${edited.map((f) => f.id).join(", ")}.\n` +
            "   Never edit an applied migration — revert the edit and add a new migration file instead."
        );
    }
    const orphaned = [...applied.keys()].filter((id) => !files.some((f) => f.id === id));
    if (orphaned.length) {
        console.warn(`⚠️  Recorded as applied but no file found (deleted or on another branch?): ${orphaned.join(", ")}`);
    }

    const pending = files.filter((f) => !applied.has(f.id));
    console.log(`${files.length} migration file(s): ${files.length - pending.length} applied, ${pending.length} pending.`);
    for (const f of files) console.log(`   ${applied.has(f.id) ? "✓" : "•"} ${f.id}`);

    if (statusOnly || pending.length === 0) {
        console.log(pending.length === 0 ? "✅ Database is up to date." : "(status only)");
    } else {
        for (const f of pending) {
            const started = Date.now();
            // Baseline files carry a probe: when it says the change is already in
            // this database (applied by hand earlier), the file is only RECORDED,
            // never run, so nothing that is working today is touched.
            const probe = /^--\s*migrate:skip-if:\s*(.+)$/m.exec(f.sql);
            if (probe) {
                const { rows: found } = await client.query(probe[1]);
                if (found[0]?.ok === true) {
                    await client.query(
                        "insert into ops.schema_migrations (id, checksum, duration_ms) values ($1, $2, 0)",
                        [f.id, f.checksum]
                    );
                    console.log(`→ ${f.id} ... already in this database, recorded without running`);
                    continue;
                }
            }
            // Opt out for the rare statement that cannot run in a transaction
            // (CREATE INDEX CONCURRENTLY): put this comment in the file.
            const noTransaction = /^--\s*migrate:no-transaction\s*$/m.test(f.sql);
            process.stdout.write(`→ applying ${f.id} ... `);
            try {
                if (noTransaction) {
                    await client.query("set lock_timeout = '15s'");
                    await client.query(f.sql);
                } else {
                    await client.query("begin");
                    await client.query("set local lock_timeout = '15s'");
                    await client.query("set local statement_timeout = '300s'");
                    await client.query(f.sql);
                }
                await client.query(
                    "insert into ops.schema_migrations (id, checksum, duration_ms) values ($1, $2, $3)",
                    [f.id, f.checksum, Date.now() - started]
                );
                if (!noTransaction) await client.query("commit");
                console.log(`done (${Date.now() - started} ms)`);
            } catch (err) {
                if (!noTransaction) await client.query("rollback").catch(() => {});
                console.log("FAILED");
                throw new Error(`${f.id}: ${err.message}\n   Nothing from this file was kept. Later migrations were not run.`);
            }
        }
        // PostgREST caches the schema; tell it about the new columns/tables.
        await client.query("notify pgrst, 'reload schema'");
        console.log(`✅ Applied ${pending.length} migration(s).`);
    }
} catch (err) {
    console.error(`❌ Migration stopped: ${err.message}`);
    exitCode = 1;
} finally {
    await client.end().catch(() => {});
}
process.exit(exitCode);
