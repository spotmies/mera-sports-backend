import { cacheDel, cacheGet, cacheSet } from "../config/redisClient.js";

/**
 * ============================================================
 * Public GET response cache
 * ============================================================
 * Most public reads were paying 3-6 database round trips every time. This
 * caches the finished JSON per URL in Redis (fail-soft like the rest of the
 * cache layer: no Redis means no caching, never an error).
 *
 * Only wrap routes whose response depends on the URL alone. Anything that
 * reads req.user / the Authorization header must NOT use this.
 *
 * Freshness: `invalidateReadCacheOnWrite` (mounted once in server.js) clears
 * the whole namespace after any successful write to a route that can change
 * what these endpoints return, so edits show up immediately. The TTL is only
 * the safety net for writes that arrive through a path we do not watch.
 */
const NS = "rc:";

export const cacheRoute = (name, ttlSeconds) => async (req, res, next) => {
    const key = `${NS}${name}:${req.originalUrl}`;

    const hit = await cacheGet(key);
    if (hit) {
        res.set("X-Cache", "HIT");
        if (typeof hit.__html === "string") {
            res.set("Content-Type", "text/html; charset=utf-8");
            return res.send(hit.__html);
        }
        return res.json(hit);
    }

    const json = res.json.bind(res);
    res.json = (body) => {
        if (res.statusCode === 200 && body && body.success !== false) {
            void cacheSet(key, body, ttlSeconds); // fire-and-forget: must not delay the response
        }
        res.set("X-Cache", "MISS");
        return json(body);
    };

    // HTML endpoints (share preview) go through res.send. res.json calls send
    // internally, so skip once the JSON path has already handled the body.
    const send = res.send.bind(res);
    res.send = (body) => {
        if (res.statusCode === 200 && typeof body === "string" && /text\/html/i.test(String(res.get("Content-Type") || ""))) {
            void cacheSet(key, { __html: body }, ttlSeconds);
            res.set("X-Cache", "MISS");
        }
        return send(body);
    };
    next();
};

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const invalidateReadCacheOnWrite = (req, res, next) => {
    if (WRITE_METHODS.has(req.method)) {
        res.on("finish", () => {
            if (res.statusCode < 400) void cacheDel(`${NS}*`);
        });
    }
    next();
};
