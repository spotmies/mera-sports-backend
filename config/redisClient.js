import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

/**
 * ============================================================
 * Redis client (optional, fail-soft)
 * ============================================================
 * On Railway the backend service reads REDIS_URL from the Redis
 * plugin (private networking: redis.railway.internal). For local
 * dev against the QA Redis, set REDIS_PUBLIC_URL (the sakura.proxy
 * public TCP proxy).
 *
 * DESIGN RULE: Redis is a *cache/accelerator*, never a hard
 * dependency. Every helper below no-ops (and never throws) when
 * Redis is missing or down, so the app keeps working — just without
 * the cache. Callers must always have a DB fallback.
 */
const redisUrl = process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL;

let redis = null;

// if (redisUrl) {
//     redis = new Redis(redisUrl, {
//         // Fail fast instead of hanging requests when Redis is unreachable.
//         maxRetriesPerRequest: 2,
//         enableOfflineQueue: false,
//         connectTimeout: 5000,
//         retryStrategy: (times) => Math.min(times * 200, 3000),
//     });

//     redis.on("connect", () => console.log("🧠 Redis: connecting…"));
//     redis.on("ready", () => console.log("🧠 Redis: ready"));
//     // Swallow errors to a single line — a down cache must not spam or crash.
//     redis.on("error", (err) => console.warn("🧠 Redis error:", err.code || err.message));
//     redis.on("end", () => console.warn("🧠 Redis: connection closed"));
// } else {
//     console.log("🧠 Redis: disabled (no REDIS_URL / REDIS_PUBLIC_URL set)");
// }

/** True only when a command can actually be served right now. */
export const isRedisReady = () => !!redis && redis.status === "ready";

/**
 * Cache-aside GET: returns the parsed value or null on any miss/error.
 */
export async function cacheGet(key) {
    if (!isRedisReady()) return null;
    try {
        const raw = await redis.get(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

/**
 * Cache-aside SET with TTL (seconds). No-ops when Redis is down.
 */
export async function cacheSet(key, value, ttlSeconds) {
    if (!isRedisReady()) return;
    try {
        await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch {
        /* ignore — cache write failures are non-fatal */
    }
}

/**
 * Delete a key, or all keys matching a `prefix*` pattern (for invalidation).
 */
export async function cacheDel(keyOrPattern) {
    if (!isRedisReady()) return;
    try {
        if (keyOrPattern.includes("*")) {
            const keys = await redis.keys(keyOrPattern);
            if (keys.length) await redis.del(keys);
        } else {
            await redis.del(keyOrPattern);
        }
    } catch {
        /* ignore */
    }
}

export { redis };
