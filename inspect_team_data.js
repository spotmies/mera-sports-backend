import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function inspectTeams() {
    let output = "Fetching all player_teams...\n";
    console.log("Fetching all player_teams...");

    // Fetch top 5 teams
    const { data: teams, error } = await supabase
        .from('player_teams')
        .select('*')
        .limit(5);

    if (error) {
        output += `Error fetching teams: ${JSON.stringify(error)}\n`;
        fs.writeFileSync('inspection_output.txt', output);
        return;
    }

    output += `Found ${teams.length} teams.\n`;
    teams.forEach((team, idx) => {
        output += `\n--- Team ${idx + 1}: ${team.team_name} (ID: ${team.id}) ---\n`;
        output += `Members Type: ${typeof team.members}\n`;
        output += `Members Content: ${JSON.stringify(team.members, null, 2)}\n`;
    });

    fs.writeFileSync('inspection_output.txt', output);
    console.log("Done writing to inspection_output.txt");
}

inspectTeams();
