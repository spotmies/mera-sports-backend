import { supabaseAdmin } from "../config/supabaseClient.js";

/**
 * The single source of truth for Player IDs.
 *
 * This used to compute `MAX(player_id) + 1` in JavaScript: fetch every P-prefixed
 * id, parse the numeric tail, take the max, add one. That had two fatal flaws.
 *
 * 1. It never advanced `player_id_seq`, while the institute bulk importer drew
 *    from that very sequence via the `get_next_player_id()` RPC. Two generators,
 *    no shared state — so the sequence sat frozen where it was while individual
 *    registrations pushed the real maximum up, and every bulk import then walked
 *    back up through numbers that were already handed out. That is exactly how
 *    P100133 and P100134 each ended up with two owners in production.
 * 2. Read-then-write is not atomic. Two registrations landing in the same
 *    instant both read the same max and both claim max+1.
 *
 * Everything now goes through the sequence, which is atomic under concurrency and
 * shared by every caller. The RPC skips any number already present in `users`, so
 * a sequence that has drifted behind the data self-heals instead of colliding.
 *
 * Requires (see the accompanying SQL):
 *   - `player_id_seq` resynced above the current maximum
 *   - the collision-skipping `get_next_player_id()` definition
 *   - `users_player_id_key` unique index as the last line of defence
 */
export const getNextPlayerId = async () => {
    const { data, error } = await supabaseAdmin.rpc("get_next_player_id");

    if (error) {
        console.error("get_next_player_id RPC failed:", error);
        throw new Error("Database error while generating Player ID");
    }

    // A null/empty return means the function is missing or was redefined badly.
    // Failing loudly beats inserting a user with no Player ID.
    if (!data || typeof data !== "string") {
        console.error("get_next_player_id returned an unusable value:", data);
        throw new Error("Database error while generating Player ID");
    }

    return data;
};
