import express from "express";
import { redis, isRedisReady } from "../config/redisClient.js";

const router = express.Router();

/**
 * GET /health/  (and /api/health/)
 * Basic liveness probe — returns 200 OK with uptime so load balancers and
 * deployment platforms (Railway, etc.) can confirm the server is alive.
 */
router.get("/", (_req, res) => {
    res.status(200).json({
        ok: true,
        status: "healthy",
        uptime_s: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
    });
});

/**
 * GET /api/health/redis
 * Proves the Redis wiring end-to-end: PING + a real write→read round-trip.
 * Returns latency so you can confirm it's actually reachable and fast.
 */
router.get("/redis", async (_req, res) => {
    if (!redis) {
        return res.json({
            ok: false,
            enabled: false,
            message: "Redis not configured (no REDIS_URL / REDIS_PUBLIC_URL).",
        });
    }
    try {
        const start = Date.now();
        const pong = await redis.ping();
        const stamp = String(Date.now());
        await redis.set("health:redis", stamp, "EX", 30);
        const readBack = await redis.get("health:redis");
        const latency = Date.now() - start;

        const ok = pong === "PONG" && readBack === stamp;
        return res.status(ok ? 200 : 503).json({
            ok,
            enabled: true,
            status: redis.status,
            ping: pong,
            readWrite: readBack === stamp ? "ok" : "mismatch",
            latency_ms: latency,
        });
    } catch (e) {
        return res.status(503).json({
            ok: false,
            enabled: true,
            status: redis?.status,
            error: e.message,
        });
    }
});

export default router;
