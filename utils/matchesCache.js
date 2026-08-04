import { cacheDel, cacheGet } from "../config/redisClient.js";
import { resolveEventIdByIdentifier } from "./eventResolver.js";

/**
 * ============================================================
 * Public matches cache (GET /events/:id/matches)
 * ============================================================
 * Why this exists: the Tournament Draws page renders the bracket
 * structure from one request and then fills in scores/winners from
 * this endpoint. Profiling (Railway Postgres over the public proxy)
 * showed the endpoint spent effectively all of its time on network
 * round trips, not on query execution — the heaviest statement plans
 * in 0.56ms but costs ~330ms wall clock. So the win is fewer round
 * trips, and then none at all on a cache hit.
 *
 * Redis is fail-soft here exactly as it is everywhere else in this
 * codebase: every helper degrades to "no cache" rather than throwing,
 * and the endpoint always has its DB path to fall back on.
 */

/** TTL for cached match payloads, in seconds. Override with MATCHES_CACHE_TTL_SECONDS. */
export const MATCHES_CACHE_TTL = Number(process.env.MATCHES_CACHE_TTL_SECONDS || 300);

/**
 * Payload key: matches:{eventId}:{scope}
 *
 * `eventId` is always the resolved INTERNAL id, never the public identifier —
 * otherwise the same event cached under two identifiers could not be purged by
 * one pattern, and a score update would leave a stale copy behind.
 */
export const matchesCacheKey = (eventId, scope) => `matches:${eventId}:${scope}`;

/**
 * Identifier -> internal event id. An event's internal id never changes, so this
 * mapping cannot go stale; it exists so a cache hit doesn't still pay for the
 * one-to-two `events` lookups that resolving a public identifier costs.
 * Distinct prefix so `matches:{eventId}:*` can never sweep it up by accident.
 */
export const matchesResolveKey = (identifier) => `matches:resolve:${identifier}`;

/**
 * Drop every cached match payload for an event. Call after ANY write that can
 * change a match row: score, winner, create, update, delete, bracket
 * regeneration, tournament reset.
 *
 * Accepts either an internal id or a public identifier. Read keys always use the
 * internal id, so a caller holding a public one would otherwise purge nothing and
 * leave a stale scoreboard up for the rest of the TTL — hence the resolve step.
 *
 * With no usable identifier it purges every match payload. An over-eager purge
 * costs one repeated query; a missed one serves a score that has already changed.
 */
export const invalidateMatchesCache = async (eventIdentifier) => {
    const raw =
        eventIdentifier === null || eventIdentifier === undefined
            ? ""
            : String(eventIdentifier).trim();

    if (!raw) {
        await cacheDel("matches:*");
        return;
    }

    await cacheDel(`matches:${raw}:*`);

    let resolved = await cacheGet(matchesResolveKey(raw));
    if (!resolved) {
        try {
            resolved = await resolveEventIdByIdentifier(raw);
        } catch {
            resolved = null; // never let a cache concern fail the write it follows
        }
    }
    if (resolved && String(resolved) !== raw) {
        await cacheDel(`matches:${resolved}:*`);
    }
};
