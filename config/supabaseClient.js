import { createClient } from "@supabase/supabase-js";
import { PostgrestClient } from "@supabase/postgrest-js";
import dotenv from "dotenv";
import jwt from "jsonwebtoken"; // Import to inspect key role
import { railwayStorage } from "../utils/railwayStorage.js";

dotenv.config({ quiet: true });

/**
 * ============================================================
 * DB LAYER SWITCH (Supabase ➜ Railway migration)
 * ============================================================
 * USE_RAILWAY_DB=true  → .from()/.rpc() go to self-hosted PostgREST
 *                        (Railway Postgres). Storage/Auth still go
 *                        to Supabase until Phases 2-3 complete.
 * USE_RAILWAY_DB=false → 100% legacy Supabase behavior (rollback).
 *
 * POSTGREST_URL examples:
 *   Railway (private networking): http://postgrest.railway.internal:3000
 *   Local dev:                    http://localhost:3333
 */
const USE_RAILWAY_DB = process.env.USE_RAILWAY_DB === "true";
const USE_RAILWAY_STORAGE = process.env.USE_RAILWAY_STORAGE === "true";
const postgrestUrl = process.env.POSTGREST_URL;

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * 🔐 Legacy Supabase admin client — built on demand, never at import time.
 *
 * This used to be constructed unconditionally, which meant a machine with the
 * Supabase vars commented out (the normal state now that both flags are `true`
 * and Railway is the system of record) could not even *boot* the backend:
 * `createClient(undefined, undefined)` throws "supabaseUrl is required." before
 * a single route is mounted. With both flags on, Supabase is not in the data
 * path at all, so requiring its credentials to start was pure legacy drag.
 */
let legacyClient = null;
const getSupabaseLegacy = () => {
    if (legacyClient) return legacyClient;

    if (!supabaseUrl || !serviceRoleKey) {
        throw new Error(
            "Supabase fallback requested but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. " +
            "Set them, or keep USE_RAILWAY_DB and USE_RAILWAY_STORAGE at 'true' so Railway is used."
        );
    }

    try {
        const decoded = jwt.decode(serviceRoleKey);
        if (decoded?.role && decoded.role !== 'service_role') {
            console.error("❌ CRITICAL: You are using the ANON KEY as Service Role Key!");
            console.error("❌ RLS Bypassing will NOT work. Update SUPABASE_SERVICE_ROLE_KEY in .env");
        }
    } catch {
        console.warn("⚠️ Could not decode Service Key JWT");
    }

    legacyClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${serviceRoleKey}` } },
    });
    return legacyClient;
};

/**
 * Stand-in for `supabaseAdmin.auth`, which now has no implementation behind it —
 * Google login verifies ID tokens directly (`googleSyncRoutes`) and `public.users`
 * is the only user store. The sole remaining caller is `seedController.js`, whose
 * route is not mounted. Throwing names the problem instead of failing as
 * "cannot read property 'admin' of undefined".
 */
const unavailableAuth = new Proxy({}, {
    get(_target, prop) {
        throw new Error(
            `supabaseAdmin.auth.${String(prop)} is no longer available — Supabase Auth was removed in the Railway migration. ` +
            "Users live in public.users; Google sign-in is verified in routes/googleSyncRoutes.js."
        );
    },
});

let supabaseAdminInstance;

if (USE_RAILWAY_DB) {
    if (!postgrestUrl) {
        console.error("❌ CRITICAL: USE_RAILWAY_DB=true but POSTGREST_URL is not set.");
    } else {
        console.log(`🚄 DB layer: Railway PostgREST → ${postgrestUrl}`);
    }

    // Same query-builder library supabase-js uses internally, pointed at
    // our own PostgREST → every controller's .from()/.rpc() works unchanged.
    const postgrest = new PostgrestClient(postgrestUrl, { schema: "public" });

    // USE_RAILWAY_STORAGE=true → uploads/deletes/URLs go to the Railway
    // bucket (private, served via /api/files signed-URL redirects).
    if (USE_RAILWAY_STORAGE) {
        console.log(`🪣 Storage layer: Railway bucket (${process.env.BUCKET_NAME})`);
    }

    supabaseAdminInstance = {
        from: (table) => postgrest.from(table),
        rpc: (fn, args, options) => postgrest.rpc(fn, args, options),
        get storage() {
            return USE_RAILWAY_STORAGE ? railwayStorage : getSupabaseLegacy().storage;
        },
        get auth() {
            return unavailableAuth;
        },
    };
} else {
    console.log("🟠 DB layer: legacy Supabase (USE_RAILWAY_DB is not 'true')");
    supabaseAdminInstance = getSupabaseLegacy();
}

/**
 * 🔐 ADMIN CLIENT
 * - Used ONLY on backend
 * - Can create users, bypass RLS
 */
export const supabaseAdmin = supabaseAdminInstance;
