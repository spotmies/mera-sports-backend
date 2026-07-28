import { PostgrestClient } from "@supabase/postgrest-js";
import dotenv from "dotenv";
import { railwayStorage } from "../utils/railwayStorage.js";

dotenv.config({ quiet: true });

/**
 * ============================================================
 * DATA LAYER — Railway Postgres (via PostgREST) + Railway Bucket
 * ============================================================
 * Supabase is gone: no client, no credentials, no fallback. Railway is the
 * sole system of record for the database, files and user accounts.
 *
 * The filename and the `supabaseAdmin` export name are kept deliberately —
 * ~40 controllers, routes and services import it, and renaming would be a
 * large mechanical diff with no behavioural change. Read it as "the database
 * handle"; nothing here talks to Supabase-the-service.
 *
 * `@supabase/postgrest-js` is NOT Supabase-the-service. It is the PostgREST
 * HTTP query builder (the same one supabase-js wraps internally), pointed at
 * our own PostgREST. That is what keeps every existing `.from()` / `.rpc()`
 * call site working unchanged, and it must stay.
 *
 * POSTGREST_URL:
 *   Railway (private networking): http://postgrest.railway.internal:3000
 *   Local dev:                    http://localhost:3333  (see scripts/dev.mjs)
 */
const postgrestUrl = process.env.POSTGREST_URL;

// Fail fast, like JWT_SECRET in server.js. With the Supabase fallback removed
// there is no degraded mode left: without this URL every query is dead, and a
// server that boots "successfully" then fails every request is the exact trap
// this codebase already fell into once.
if (!postgrestUrl) {
    console.error(
        "❌ FATAL: POSTGREST_URL is not set — the backend has no database to talk to. Refusing to start.\n" +
        "   Railway: http://postgrest.railway.internal:3000\n" +
        "   Local:   http://localhost:3333  (npm run dev starts PostgREST for you)"
    );
    process.exit(1);
}

/**
 * Turn "TypeError: fetch failed" into something a human can act on.
 *
 * postgrest-js surfaces a dead connection as a bare `TypeError: fetch failed`
 * with an ECONNREFUSED buried in the cause — it names neither the port nor the
 * process that is missing. Locally the cause is almost always the same one
 * (PostgREST is not running), so we say so, with the command that fixes it.
 */
const describedFetch = async (input, init) => {
    try {
        return await fetch(input, init);
    } catch (err) {
        const refused = String(err?.cause?.code || err?.code || err?.cause || "").includes("ECONNREFUSED");
        if (!refused) throw err;

        const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(postgrestUrl);
        throw new Error(
            `Cannot reach PostgREST at ${postgrestUrl} (connection refused). ` +
            (isLocal
                ? "The local PostgREST is not running — start the backend with `npm run dev`, " +
                  "which launches it automatically, or run `npm run db:local` in a separate shell."
                : "Check that the PostgREST service is running and that POSTGREST_URL is correct."),
            { cause: err }
        );
    }
};

console.log(`🚄 DB layer: Railway PostgREST → ${postgrestUrl}`);
console.log(`🪣 Storage layer: Railway bucket (${process.env.BUCKET_NAME})`);

// Same query-builder library supabase-js uses internally, pointed at
// our own PostgREST → every controller's .from()/.rpc() works unchanged.
const postgrest = new PostgrestClient(postgrestUrl, { schema: "public", fetch: describedFetch });

/**
 * Stand-in for the old `supabaseAdmin.auth`, which now has no implementation
 * behind it — Google login verifies ID tokens directly (`googleSyncRoutes`) and
 * `public.users` is the only user store. Throwing names the problem instead of
 * failing as "cannot read property 'admin' of undefined".
 */
const unavailableAuth = new Proxy({}, {
    get(_target, prop) {
        throw new Error(
            `supabaseAdmin.auth.${String(prop)} is no longer available — Supabase Auth was removed in the Railway migration. ` +
            "Users live in public.users; Google sign-in is verified in routes/googleSyncRoutes.js."
        );
    },
});

/**
 * 🔐 ADMIN CLIENT — backend only. Bypasses nothing magic: authorization lives
 * in the API middleware (`verifyAdmin` / `rbacMiddleware`), not in the database.
 */
export const supabaseAdmin = {
    from: (table) => postgrest.from(table),
    rpc: (fn, args, options) => postgrest.rpc(fn, args, options),
    storage: railwayStorage,
    get auth() {
        return unavailableAuth;
    },
};
