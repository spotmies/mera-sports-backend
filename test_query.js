import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function testQueries() {
    console.log("--- Starting Query Test ---");

    // 1. Inspect Data Type
    console.log("\n1. Fetching one row to inspect 'members' type...");
    const { data: rows, error: fetchError } = await supabase
        .from('player_teams')
        .select('id, members')
        .limit(1);

    if (fetchError) {
        console.error("Fetch Error:", fetchError);
    } else if (rows.length === 0) {
        console.log("No teams found.");
    } else {
        const team = rows[0];
        console.log("Row ID:", team.id);
        console.log("Members Value:", team.members);
        console.log("Members Type (JS):", typeof team.members);
        console.log("Is Array?", Array.isArray(team.members));
    }

    // 2. Test Contains (The failing query)
    console.log("\n2. Testing .contains()...");
    const { data: containsData, error: containsError } = await supabase
        .from('player_teams')
        .select('id')
        .contains('members', [{ dummy: 'test' }]); // Just testing syntax

    if (containsError) {
        console.error("Contains Error:", containsError);
    } else {
        console.log("Contains Success. Count:", containsData.length);
    }

    // 3. Test ilike (Text fallback)
    console.log("\n3. Testing .ilike() cast...");
    // Note: Supabase JS doesn't support casting in column name usually, 
    // but let's try implicit text search if the column is text.
    // Or we can try to filter by comparing to a string if it's stored as string.

    // We'll skip complex casting for now and just check if we can query it as text
    // if the above type check said it was a string.
}

testQueries();
