
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

// HARDCODED CREDENTIALS (Proven working)
const supabaseUrl = process.env.SUPABASE_URL || "https://akavbpikcamxgvuckqao.supabase.co";
const serviceRoleKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFrYXZicGlrY2FteGd2dWNrcWFvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTg1ODgyMywiZXhwIjoyMDgxNDM0ODIzfQ.3fEDtN0W_ETl2bT3toTP-T_8wbiE32hVOiyeID6H4Vc";

const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

async function checkPermissions() {
    console.log("--- CHECKING ADMIN PERMISSIONS ---");

    // TEST 1: APPROVE ADMIN (Update 'users' table)
    console.log("\n1. Testing 'Approve Admin' (Update 'users' table)...");
    // Find a pending user or just any user to test update
    const { data: users } = await supabase.from("users").select("id").limit(1);
    if (users && users.length > 0) {
        const targetId = users[0].id;
        const { error: userError } = await supabase
            .from("users")
            .update({ verification: 'verified' }) // Try updating verification
            .eq("id", targetId)
            .select();

        if (userError) {
            console.error("❌ FAILED: Cannot update 'users' table (Approve Admin blocked).");
            console.error("   Error:", userError.message);
        } else {
            console.log("✅ SUCCESS: Can update 'users' table (Approve Admin works).");
        }
    } else {
        console.log("⚠️ SKIPPED: No users found to test.");
    }

    // TEST 2: UPDATE SETTINGS (Update 'platform_settings' table)
    console.log("\n2. Testing 'Update Settings' (Update 'platform_settings' table)...");
    // Check if row 1 exists, if not try to insert or update
    const { data: settings } = await supabase.from("platform_settings").select("id").eq("id", 1).maybeSingle();

    if (!settings) {
        console.log("   Row 1 not found. Attempting INSERT...");
        const { error: insertError } = await supabase
            .from("platform_settings")
            .insert({ id: 1, platform_name: "Test Platform" });

        if (insertError) {
            console.error("❌ FAILED: Cannot INSERT into 'platform_settings'.");
            console.error("   Error:", insertError.message);
        } else {
            console.log("✅ SUCCESS: Can INSERT into 'platform_settings'.");
        }
    } else {
        console.log("   Row 1 exists. Attempting UPDATE...");
        const { error: updateError } = await supabase
            .from("platform_settings")
            .update({ updated_at: new Date() })
            .eq("id", 1);

        if (updateError) {
            console.error("❌ FAILED: Cannot UPDATE 'platform_settings'.");
            console.error("   Error:", updateError.message);
        } else {
            console.log("✅ SUCCESS: Can UPDATE 'platform_settings'.");
        }
    }
}

checkPermissions();
