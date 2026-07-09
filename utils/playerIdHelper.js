import { supabaseAdmin } from "../config/supabaseClient.js";

/**
 * Generates the next sequential player ID by parsing the 'P' prefix
 * and finding the maximum numeric value.
 */
export const getNextPlayerId = async () => {
    try {
        // Query users with a Player ID starting with 'P'
        const { data: users, error } = await supabaseAdmin
            .from("users")
            .select("player_id")
            .like("player_id", "P%")
            .not("player_id", "is", null);

        if (error) {
            console.error("Failed to fetch player IDs for sequencing:", error);
            throw new Error("Database error while generating Player ID");
        }

        if (users && users.length > 0) {
            // Extract the numeric portion and find the maximum
            const numericIds = users
                .map(u => parseInt(u.player_id.substring(1)))
                .filter(n => !isNaN(n));

            if (numericIds.length > 0) {
                const maxId = Math.max(...numericIds);
                return `P${maxId + 1}`;
            }
        }

        // Default starting ID if table is empty or has no valid P-IDs
        return "P1001";
    } catch (err) {
        console.error("getNextPlayerId Error:", err);
        throw err;
    }
};
