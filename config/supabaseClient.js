import { createClient } from "@supabase/supabase-js";
import { PostgrestClient } from "@supabase/postgrest-js";
import dotenv from "dotenv";
import jwt from "jsonwebtoken"; // Import to inspect key role

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
const postgrestUrl = process.env.POSTGREST_URL;

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
    console.error("❌ CRITICAL: Missing Supabase Env Variables.");
    console.error("URL:", supabaseUrl ? "Set" : "Missing");
    console.error("Service Role Key:", serviceRoleKey ? "Set" : "Missing");
} else {
    // DEBUG: Check Role
    try {
        const decoded = jwt.decode(serviceRoleKey);
        if (decoded && decoded.role) {
            if (decoded.role !== 'service_role') {
                console.error("❌ CRITICAL: You are using the ANON KEY as Service Role Key!");
                console.error("❌ RLS Bypassing will NOT work. Update SUPABASE_SERVICE_ROLE_KEY in .env");
            }
        }
    } catch (e) {
        console.warn("⚠️ Could not decode Service Key JWT");
    }
}

/**
 * 🔐 Legacy Supabase admin client.
 * Still used directly for Storage + Auth while DB traffic moves to
 * PostgREST/Railway. Becomes fully unused after Phases 2-3.
 */
const supabaseLegacy = createClient(
    supabaseUrl,
    serviceRoleKey,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
        global: {
            headers: {
                Authorization: `Bearer ${serviceRoleKey}`,
            },
        },
    }
);

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

    supabaseAdminInstance = {
        from: (table) => postgrest.from(table),
        rpc: (fn, args, options) => postgrest.rpc(fn, args, options),
        // Storage + Auth remain on Supabase until their own migration phases.
        storage: supabaseLegacy.storage,
        auth: supabaseLegacy.auth,
    };
} else {
    supabaseAdminInstance = supabaseLegacy;
}

/**
 * 🔐 ADMIN CLIENT
 * - Used ONLY on backend
 * - Can create users, bypass RLS
 */
export const supabaseAdmin = supabaseAdminInstance;
