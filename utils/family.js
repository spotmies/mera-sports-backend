import { supabaseAdmin } from "../config/supabaseClient.js";
import { resolveAge } from "./age.js";

/**
 * Families: one shared mobile number, any number of people, no roles.
 *
 * Everyone in a family is equal. They can all switch to each other's
 * profiles, add members, and edit members' details. There are no
 * Parent/Child tags.
 *
 * Storage still uses `family_relations` rows of (head_player_id,
 * of_player_id): every member points at one ANCHOR account. The anchor is
 * only how the rows hang together. It grants nothing and is never shown.
 * Two things keep it valid:
 *   - The unique index on of_player_id: one family per member.
 *   - re-anchoring before the anchor leaves. Deleting a user cascades
 *     their family_relations rows, so deleting the anchor first would
 *     silently dissolve the whole family.
 *
 * The `relation` column is NOT NULL, so new rows store "Other". Nothing
 * reads it.
 */

export const STORED_RELATION = "Other";

/** Anchor id and member ids of the family `userId` belongs to (a family of one when unlinked). */
export const getFamily = async (userId) => {
    const { data: link, error: linkError } = await supabaseAdmin
        .from("family_relations")
        .select("head_player_id")
        .eq("of_player_id", userId)
        .maybeSingle();
    if (linkError) throw linkError;

    const anchorId = link?.head_player_id || userId;
    const { data: rows, error } = await supabaseAdmin
        .from("family_relations")
        .select("of_player_id")
        .eq("head_player_id", anchorId);
    if (error) throw error;

    const memberIds = (rows || []).map(r => r.of_player_id).filter(id => id && id !== anchorId);
    return { anchorId, memberIds, ids: [anchorId, ...memberIds] };
};

/**
 * Full user rows for everyone in `userId`'s family, `userId` included, oldest
 * first. Only player accounts: an admin account is never switchable.
 */
export const getFamilyUsers = async (userId) => {
    const { ids } = await getFamily(userId);
    const { data, error } = await supabaseAdmin.from("users").select("*").in("id", ids);
    if (error) throw error;
    return (data || [])
        .filter(u => u.role === "player")
        .sort((a, b) => (resolveAge(b) ?? -1) - (resolveAge(a) ?? -1));
};

/** Whether two accounts are in the same family. */
export const inSameFamily = async (userId, otherId) => {
    if (!userId || !otherId) return false;
    const { ids } = await getFamily(userId);
    return ids.includes(otherId);
};

/**
 * Take `leavingId` out of its family without breaking it. Call this before
 * unlinking or deleting anyone.
 *
 * A member's own row is removed. If the anchor is leaving, the oldest
 * remaining member becomes the anchor and everyone else's rows move to them.
 * Returns the ids whose family view changed, for cache invalidation.
 */
export const leaveFamily = async (leavingId) => {
    const { anchorId, memberIds } = await getFamily(leavingId);
    const touched = new Set([anchorId, ...memberIds]);

    if (leavingId !== anchorId) {
        const { error } = await supabaseAdmin.from("family_relations").delete().eq("of_player_id", leavingId);
        if (error) throw error;
        return [...touched];
    }

    if (memberIds.length === 0) return [...touched];

    const { data: members, error: membersError } = await supabaseAdmin
        .from("users").select("id, age, dob, created_at").in("id", memberIds);
    if (membersError) throw membersError;
    const nextAnchor = (members || []).sort(
        (a, b) => (resolveAge(b) ?? -1) - (resolveAge(a) ?? -1)
            || new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime()
    )[0];
    if (!nextAnchor) return [...touched];

    // The new anchor's own row goes first, or moving the rest under them
    // would briefly make them their own member.
    const { error: dropError } = await supabaseAdmin
        .from("family_relations").delete().eq("of_player_id", nextAnchor.id);
    if (dropError) throw dropError;
    const { error: moveError } = await supabaseAdmin
        .from("family_relations")
        .update({ head_player_id: nextAnchor.id })
        .eq("head_player_id", anchorId);
    if (moveError) throw moveError;
    return [...touched];
};
