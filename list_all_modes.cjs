const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    'https://mkeytghrgjbnxnhbxdkw.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rZXl0Z2hyZ2pibnhuaGJ4ZGt3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDA5Nzg1OCwiZXhwIjoyMDg1NjczODU4fQ.PS0I8Bu5FDxiH4pZ6CcAKQ7Ti0FENN7EDt-_m4Yk-r4'
);

async function main() {
    const { data: modes, error } = await supabase
        .from('event_brackets')
        .select('mode');

    if (error) {
        console.error('Error fetching modes:', error);
        return;
    }

    const uniqueModes = Array.from(new Set(modes.map(m => m.mode)));
    console.log('Unique modes in event_brackets:', uniqueModes);
}

main();
