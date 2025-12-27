import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
    console.error("❌ CRITICAL: Missing Supabase Env Variables.");
    console.error("URL:", supabaseUrl ? "Set" : "Missing");
    console.error("Service Role Key:", serviceRoleKey ? "Set" : "Missing");
} else {
    console.log("✅ Supabase Configuration Loaded");
    console.log("URL:", supabaseUrl);
    // basic check if it looks like a JWT
    if (serviceRoleKey.length < 20) console.warn("⚠️ Warning: Service Role Key looks suspiciously short.");
}

/**
 * 🔐 ADMIN CLIENT
 * - Used ONLY on backend
 * - Can create users, bypass RLS
 */
export const supabaseAdmin = createClient(
    supabaseUrl,
    serviceRoleKey,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    }
);
