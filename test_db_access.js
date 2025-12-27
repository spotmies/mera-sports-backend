
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

// HARDCODED CREDENTIALS (As per verification)
const supabaseUrl = process.env.SUPABASE_URL || "https://akavbpikcamxgvuckqao.supabase.co";
const serviceRoleKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFrYXZicGlrY2FteGd2dWNrcWFvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTg1ODgyMywiZXhwIjoyMDgxNDM0ODIzfQ.3fEDtN0W_ETl2bT3toTP-T_8wbiE32hVOiyeID6H4Vc";

const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

async function testAccess() {
    console.log("--- TESTING ADMIN ACCESS ---");

    // 1. READ TEST
    console.log("1. Attempting READ (Select 1 user)...");
    const { data: users, error: readError } = await supabase
        .from("users")
        .select("*")
        .limit(1);

    if (readError) {
        console.error("❌ READ FAILED:", readError);
        return;
    }

    if (!users || users.length === 0) {
        console.log("⚠️ No users found in DB to test update.");
        return;
    }

    const targetUser = users[0];
    console.log(`✅ READ SUCCESS. Target User ID: ${targetUser.id}, Email: ${targetUser.email}`);

    // 2. WRITE TEST (Update Pincode to same value)
    console.log("2. Attempting WRITE (Update Pincode)...");
    const { data: updateData, error: updateError } = await supabase
        .from("users")
        .update({ pincode: targetUser.pincode }) // No-op update
        .eq("id", targetUser.id)
        .select();

    if (updateError) {
        console.error("❌ WRITE FAILED:", updateError);
        console.log("\nCONCLUSION: The Service Key is correctly loaded, but the Database Policies are BLOCKING it.");
    } else {
        console.log("✅ WRITE SUCCESS:", updateData);
        console.log("\nCONCLUSION: The Service Key works completely. The issue is in the Application Code.");
    }
}

testAccess();
