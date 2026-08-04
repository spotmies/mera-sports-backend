import { cacheDel } from "../config/redisClient.js";
import { supabaseAdmin } from "../config/supabaseClient.js";

/**
 * ============================================================
 * Player dashboard cache (GET /api/player/dashboard)
 * ============================================================
 * The dashboard is the app's most expensive authenticated read — a users row,
 * five parallel lookups, a registrations query, a batched team fetch, then an
 * in-memory merge. It is also required globally: the profile menu needs the
 * name/avatar/player id on every page.
 *
 * The frontend already collapses it to one request per session (a single shared
 * query key in usePlayerDashboard). This caches the server side of it, so a
 * browser refresh — which necessarily re-requests — is answered from Redis
 * instead of replaying the whole query fan-out.
 *
 * Fail-soft like every other cache here: a missing or down Redis just means the
 * handler does its normal work.
 */

/** Dashboard cache lifetime, seconds. Override with DASHBOARD_CACHE_TTL_SECONDS. */
export const DASHBOARD_CACHE_TTL = Number(process.env.DASHBOARD_CACHE_TTL_SECONDS || 900); // 15 min

/** Key: dashboard:{userId} — one entry per user, nothing shared between accounts. */
export const dashboardCacheKey = (userId) => `dashboard:${userId}`;

/**
 * Drop a user's cached dashboard. Call after anything that changes what it
 * returns: profile edits, avatar/school-detail updates, team membership
 * changes, registration changes, logout.
 */
export const invalidateDashboardCache = async (userId) => {
    const id = userId === null || userId === undefined ? "" : String(userId).trim();
    if (!id) return;
    await cacheDel(dashboardCacheKey(id));
};

/**
 * Drop every dashboard a registration change affects.
 *
 * This exists because nothing used to call it. `event_registrations` is written
 * in five places — two payment paths and three admin status updates — and none
 * of them invalidated anything, so for up to DASHBOARD_CACHE_TTL (15 minutes) a
 * player who had just paid kept being served the dashboard from *before* they
 * registered: "Events: 0", "No events found", while the admin screen (which
 * reads the database directly) showed the registration as verified. The same
 * staleness hid an admin verifying or rejecting a registration.
 *
 * `teamId` matters because a team registration appears on the dashboard of every
 * member, not just whoever paid — getPlayerDashboard resolves the player's teams
 * and matches registrations by `team_id`. Invalidating only the payer would fix
 * the captain's screen and leave the rest of the squad stale.
 *
 * Members are matched on `members[].id` (the user uuid). Rows that identify a
 * member only by mobile or player_id are left alone deliberately: resolving them
 * means a lookup per member on the payment hot path, and those members still
 * refresh when their own TTL lapses. Fail-soft throughout — a cache problem must
 * never fail a registration that has already been paid for.
 */
export const invalidateDashboardForRegistration = async ({ userId, teamId } = {}) => {
    try {
        const ids = new Set();
        if (userId) ids.add(String(userId).trim());

        if (teamId) {
            const { data: team } = await supabaseAdmin
                .from("player_teams")
                .select("captain_id, members")
                .eq("id", teamId)
                .maybeSingle();

            if (team?.captain_id) ids.add(String(team.captain_id).trim());
            if (Array.isArray(team?.members)) {
                for (const member of team.members) {
                    if (member?.id) ids.add(String(member.id).trim());
                }
            }
        }

        await Promise.allSettled(
            [...ids].filter(Boolean).map((id) => cacheDel(dashboardCacheKey(id)))
        );
    } catch (err) {
        console.warn("Dashboard cache invalidation skipped:", err.message);
    }
};
