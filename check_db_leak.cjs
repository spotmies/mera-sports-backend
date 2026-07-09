const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    'https://mkeytghrgjbnxnhbxdkw.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rZXl0Z2hyZ2pibnhuaGJ4ZGt3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDA5Nzg1OCwiZXhwIjoyMDg1NjczODU4fQ.PS0I8Bu5FDxiH4pZ6CcAKQ7Ti0FENN7EDt-_m4Yk-r4'
);

async function main() {
    // Just fetch everything from event_brackets for event 25
    console.log("Checking event_brackets...");
    const { data: brackets, error } = await supabase
        .from('event_brackets')
        .select('*')
        .eq('event_id', '25');
    
    if (error) {
        console.error("Error brackets:", error);
    } else {
        console.log(`Brackets found: ${brackets.length}`);
        brackets.forEach(b => {
            console.log(`- Category: ${b.category}, Published: ${b.published}, Mode: ${b.mode}`);
        });
    }

    console.log("\nChecking leagues...");
    const { data: leagues, error: lError } = await supabase
        .from('leagues')
        .select('category_label, rules')
        .eq('event_id', '25');
    
    if (lError) {
        console.error("Error leagues:", lError);
    } else {
        console.log(`Leagues found: ${leagues.length}`);
        leagues.forEach(l => {
            console.log(`- Category: ${l.category_label}, Format: ${l.rules?.format}`);
            if (l.rules?.heats) {
                console.log(`  Heats: ${l.rules.heats.length}`);
                const firstLane = l.rules.heats[0]?.lanes?.[0];
                if (firstLane) {
                    console.log(`  First lane sample: playerId=${firstLane.playerId}, time=${firstLane.time}`);
                }
            }
        });
    }
}

main();
