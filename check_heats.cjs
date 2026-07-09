const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    'https://mkeytghrgjbnxnhbxdkw.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rZXl0Z2hyZ2pibnhuaGJ4ZGt3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDA5Nzg1OCwiZXhwIjoyMDg1NjczODU4fQ.PS0I8Bu5FDxiH4pZ6CcAKQ7Ti0FENN7EDt-_m4Yk-r4'
);

async function main() {
    const { data, error } = await supabase
        .from('leagues')
        .select('*');

    if (error) {
        console.error('Error:', error);
        return;
    }

    const heatLeagues = data.filter(d => d.rules?.format === 'HEAT');
    console.log(`Found ${heatLeagues.length} heat leagues`);
    
    // Just print the first one with heats
    const withHeats = heatLeagues.find(l => Array.isArray(l.rules?.heats) && l.rules.heats.length > 0);
    if (withHeats) {
        console.log(`\nSample Heat League (Category ${withHeats.category_id}):`);
        console.log(JSON.stringify(withHeats.rules.heats[0], null, 2));
    }
}

main();
