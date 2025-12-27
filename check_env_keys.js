import "dotenv/config";

const url = process.env.SUPABASE_URL;
const anon = process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log("--- ENV CHECK ---");
console.log(`URL: ${url ? "Found" : "MISSING"}`);
console.log(`ANON KEY: ${anon ? (anon.substring(0, 10) + "...") : "MISSING"}`);
console.log(`SERVICE KEY: ${service ? (service.substring(0, 10) + "...") : "MISSING"}`);

if (service && anon && service === anon) {
    console.error("\n❌ FATAL ERROR: SUPABASE_SERVICE_ROLE_KEY is identical to the ANON KEY.");
    console.error("You must update .env with the 'service_role' secret from Supabase Dashboard.");
} else if (!service) {
    console.error("\n❌ FATAL ERROR: SUPABASE_SERVICE_ROLE_KEY is missing.");
} else {
    console.log("\n✅ Keys look distinct. (Please ensure Service Key is actually the Secret one)");
}
