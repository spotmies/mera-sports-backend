import { supabaseAdmin } from "./config/supabaseClient.js";

async function debugCategories() {
    try {
        const { data, error } = await supabaseAdmin
            .from('events')
            .select('id, name, categories')
            .limit(5);

        if (error) throw error;

        console.log("Fetched Events:");
        data.forEach(e => {
            console.log(`\nEvent: ${e.name} (${e.id})`);
            console.log("Categories:", JSON.stringify(e.categories, null, 2));
        });

    } catch (err) {
        console.error("Error:", err);
    }
}

debugCategories();
