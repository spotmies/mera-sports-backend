import { cacheDel } from "../config/redisClient.js";

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
