/** /health/* and /api/health/* — infrastructure liveness & readiness probes. */

const HEALTH_TAG = ["Health"];

const obj = (properties, required = []) => ({ type: "object", required, properties });

export const healthPaths = {
    /* ── liveness ─────────────────────────────────────────────────────────── */

    "/health/": {
        get: {
            tags: HEALTH_TAG,
            summary: "Liveness probe (bare URL)",
            description:
                "Returns `200 OK` with basic server uptime. Intended for load-balancers and " +
                "deployment platforms (Railway, etc.) that hit `/health/` to confirm the " +
                "process is alive. No auth required.",
            security: [],
            responses: {
                200: {
                    description: "Server is alive.",
                    content: {
                        "application/json": {
                            schema: obj(
                                {
                                    ok:        { type: "boolean", example: true },
                                    status:    { type: "string",  example: "healthy" },
                                    uptime_s:  { type: "integer", example: 3741 },
                                    timestamp: { type: "string",  format: "date-time" },
                                },
                                ["ok", "status", "uptime_s", "timestamp"]
                            ),
                        },
                    },
                },
            },
        },
    },

    "/api/health/": {
        get: {
            tags: HEALTH_TAG,
            summary: "Liveness probe (API prefix)",
            description:
                "Same liveness probe as `/health/` — provided under the `/api/` prefix for " +
                "clients that prefer the consistent base path. No auth required.",
            security: [],
            responses: {
                200: {
                    description: "Server is alive.",
                    content: {
                        "application/json": {
                            schema: obj(
                                {
                                    ok:        { type: "boolean", example: true },
                                    status:    { type: "string",  example: "healthy" },
                                    uptime_s:  { type: "integer", example: 3741 },
                                    timestamp: { type: "string",  format: "date-time" },
                                },
                                ["ok", "status", "uptime_s", "timestamp"]
                            ),
                        },
                    },
                },
            },
        },
    },

    /* ── Redis readiness ───────────────────────────────────────────────────── */

    "/api/health/redis": {
        get: {
            tags: HEALTH_TAG,
            summary: "Redis readiness probe",
            description:
                "Proves the Redis wiring end-to-end: PING + a write→read round-trip with a " +
                "30-second TTL key. Returns latency so you can confirm the cache is reachable " +
                "and fast. Returns `200` when Redis is healthy, `503` on error. " +
                "Returns `200` with `enabled: false` when Redis is not configured. No auth required.",
            security: [],
            responses: {
                200: {
                    description: "Redis healthy (or not configured).",
                    content: {
                        "application/json": {
                            schema: {
                                oneOf: [
                                    {
                                        title: "Redis OK",
                                        type: "object",
                                        properties: {
                                            ok:         { type: "boolean", example: true },
                                            enabled:    { type: "boolean", example: true },
                                            status:     { type: "string",  example: "ready" },
                                            ping:       { type: "string",  example: "PONG" },
                                            readWrite:  { type: "string",  example: "ok" },
                                            latency_ms: { type: "integer", example: 3 },
                                        },
                                    },
                                    {
                                        title: "Redis not configured",
                                        type: "object",
                                        properties: {
                                            ok:      { type: "boolean", example: false },
                                            enabled: { type: "boolean", example: false },
                                            message: { type: "string",  example: "Redis not configured (no REDIS_URL / REDIS_PUBLIC_URL)." },
                                        },
                                    },
                                ],
                            },
                        },
                    },
                },
                503: {
                    description: "Redis unreachable or returned an unexpected error.",
                    content: {
                        "application/json": {
                            schema: obj({
                                ok:      { type: "boolean", example: false },
                                enabled: { type: "boolean", example: true },
                                status:  { type: "string",  example: "reconnecting" },
                                error:   { type: "string",  example: "connect ECONNREFUSED 127.0.0.1:6379" },
                            }),
                        },
                    },
                },
            },
        },
    },
};
