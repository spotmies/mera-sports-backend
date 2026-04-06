const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    'https://mkeytghrgjbnxnhbxdkw.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rZXl0Z2hyZ2pibnhuaGJ4ZGt3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDA5Nzg1OCwiZXhwIjoyMDg1NjczODU4fQ.PS0I8Bu5FDxiH4pZ6CcAKQ7Ti0FENN7EDt-_m4Yk-r4'
);

async function main() {
    const { data, error } = await supabase
        .from('event_brackets')
        .select('mode')
        .limit(100);

    if (error) {
        console.error('Error:', error);
        return;
    }

    const modes = new Set(data.map(r => r.mode));
    console.log('Unique modes found in event_brackets:', Array.from(modes));
}

main();
