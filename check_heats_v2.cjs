const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    'https://mkeytghrgjbnxnhbxdkw.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rZXl0Z2hyZ2pibnhuaGJ4ZGt3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDA5Nzg1OCwiZXhwIjoyMDg1NjczODU4fQ.PS0I8Bu5FDxiH4pZ6CcAKQ7Ti0FENN7EDt-_m4Yk-r4'
);

async function main() {
    const { data: leagues, error } = await supabase
        .from('leagues')
        .select('*')
        .eq('event_id', 25);

    if (error) {
        console.error('Error fetching leagues:', error);
        return;
    }

    const heatLeagues = leagues.filter(l => l.rules?.format === 'HEAT');
    console.log(`Found ${heatLeagues.length} heat leagues for event 25`);

    heatLeagues.forEach(l => {
        console.log(`\n--- Category: ${l.category_label} (ID: ${l.category_id}) ---`);
        console.log(`Rules format: ${l.rules.format}`);
        if (l.rules.heats && l.rules.heats.length > 0) {
            console.log(`Heats count: ${l.rules.heats.length}`);
            const firstHeat = l.rules.heats[0];
            console.log(`First Heat details:`, JSON.stringify({
                name: firstHeat.name,
                status: firstHeat.status,
                lanesCount: firstHeat.lanes?.length,
                sampleLanes: firstHeat.lanes?.slice(0, 2).map(lane => ({
                    playerId: lane.playerId,
                    time: lane.time,
                    position: lane.position
                }))
            }, null, 2));
        } else {
            console.log("No heats Found in rules.");
        }
    });

    // Also check event_brackets to see if it's published
    const { data: brackets, error: bError } = await supabase
        .from('event_brackets')
        .select('*')
        .eq('event_id', 25);
    
    if (bError) {
        console.error('Error fetching brackets:', bError);
    } else {
        console.log(`\nFound ${brackets.length} rows in event_brackets for event 25`);
        brackets.forEach(b => {
             console.log(`Bracket: category=${b.category}, category_id=${b.category_id}, published=${b.published}`);
        });
    }
}

main();
