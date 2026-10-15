// Starts a local PostgREST (http://localhost:3333) against the Railway Postgres
// public proxy given in LOCAL_POSTGRES_URL. Used by `npm run db:local` and dev.mjs.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const here = path.dirname(fileURLToPath(import.meta.url));
const exe = process.platform === "win32" ? "postgrest.exe" : "postgrest";

function findBinary() {
    const candidates = [
        path.resolve(here, "../../tools/postgrest", exe),
        path.resolve(here, "../../tools/tools/postgrest", exe),
    ];
    return candidates.find((p) => existsSync(p)) || "postgrest"; // fall back to PATH
}

export function startLocalPostgrest({ port = 3333, inherit = true } = {}) {
    const dbUri = process.env.LOCAL_POSTGRES_URL;
    if (!dbUri) {
        console.error("❌ LOCAL_POSTGRES_URL is not set in .env");
        process.exit(1);
    }
    const bin = findBinary();
    console.log(`🚄 Starting local PostgREST (${bin}) listen → http://localhost:${port}`);
    const child = spawn(bin, [], {
        stdio: inherit ? "inherit" : ["ignore", "inherit", "inherit"],
        env: {
            ...process.env,
            PGRST_DB_URI: dbUri,
            PGRST_DB_SCHEMAS: "public",
            PGRST_DB_ANON_ROLE: "merasports_api",
            PGRST_SERVER_HOST: "127.0.0.1",
            PGRST_SERVER_PORT: String(port),
        },
    });
    child.on("error", (err) => {
        console.error(`❌ Could not find a postgrest binary (${bin}): ${err.message}`);
        process.exit(1);
    });
    return child;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const child = startLocalPostgrest();
    child.on("exit", (code) => process.exit(code ?? 0));
}
