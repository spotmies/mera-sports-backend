// `npm run dev`: start local PostgREST, wait until ready, then run the server with nodemon.
import { spawn } from "node:child_process";
import { startLocalPostgrest } from "./start-local-postgrest.mjs";

const PORT = 3333;
const URL = `http://localhost:${PORT}`;

const pg = startLocalPostgrest({ port: PORT });
let server;

const shutdown = (code = 0) => {
    try { server?.kill(); } catch {}
    try { pg.kill(); } catch {}
    process.exit(code);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
pg.on("exit", (code) => {
    console.error(`❌ PostgREST exited (code ${code}).`);
    shutdown(1);
});

async function waitReady(timeoutMs = 90000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(URL);
            if (res.ok) return true;
        } catch {}
        await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
}

if (!(await waitReady())) {
    console.error("❌ PostgREST never became ready — check LOCAL_POSTGRES_URL and the PostgREST log above.");
    shutdown(1);
}
console.log(`✅ PostgREST ready at ${URL}`);

server = spawn("npx nodemon server.js", { stdio: "inherit", shell: true });
server.on("exit", (code) => shutdown(code ?? 0));
