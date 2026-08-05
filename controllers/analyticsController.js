import jwt from "jsonwebtoken";
import dotenv from "dotenv";

import { supabaseAdmin } from "../config/supabaseClient.js";
import { redis, isRedisReady } from "../config/redisClient.js";
import {
    fetchGoogleAnalytics,
    isGoogleAnalyticsConfigured,
} from "../services/googleAnalyticsService.js";

dotenv.config({ quiet: true });

/**
 * ============================================================
 * Site analytics — ingest (public) and reporting (admin)
 * ============================================================
 * The collect endpoint is unauthenticated by necessity: most visits to the
 * player site are anonymous, and those are precisely the ones worth counting.
 * Everything below therefore treats the request body as hostile — every field
 * is clamped, every unknown key is dropped, and a malformed row is discarded
 * rather than allowed to fail the batch it arrived in.
 *
 * The endpoint also never reports a problem to the browser. Analytics is
 * observation, not function: a 500 here would put errors in the console of a
 * working site and, worse, invite retry loops. Failures are logged server-side
 * and answered with 204.
 */

// One page has no legitimate reason to emit more than a handful of events; the
// client batches at most a few at a time. The ceiling is what stops a single
// POST from inserting ten thousand rows.
const MAX_BATCH = 30;

// Columns are `text`. These ceilings are the only thing between an
// unauthenticated POST and an unbounded row.
const LIMITS = {
    visitor_id: 64,
    session_id: 64,
    event_name: 60,
    page_path: 300,
    page_title: 200,
    referrer: 500,
    event_public_id: 64,
};

// events.public_id — the text handle that appears in player-site URLs
// ("evt_51a6b8f6c9aa"), not the internal bigint primary key.
const EVENT_PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_PARAMS_BYTES = 2000;

const DEVICES = new Set(["mobile", "tablet", "desktop"]);

// GA4 convention, and what the dashboard's `event_name <> 'page_view'` split
// assumes. Rejecting anything else keeps the clicks breakdown from filling up
// with typos and one-off names that never aggregate.
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{2,}$/;

// Cheap, deliberately non-exhaustive. Real bot filtering is a losing arms race;
// this removes the honest crawlers that identify themselves, which in practice
// is most of the junk. Anything cleverer than this would also have to defeat
// the JS execution required to reach here at all.
const BOT_PATTERN =
    /bot|crawler|spider|crawling|slurp|bingpreview|headlesschrome|phantomjs|puppeteer|playwright|lighthouse|gtmetrix|pingdom|uptimerobot|semrush|ahrefs|facebookexternalhit|whatsapp|telegram/i;

const clamp = (value, max) => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text) return null;
    return text.slice(0, max);
};

/**
 * Resolve the logged-in player, if there is one.
 *
 * Best-effort by design: an expired or absent token simply means the row is
 * recorded anonymously. This must never reject the request — a visitor whose
 * session lapsed mid-browse is still a visitor worth counting.
 */
const resolveUserId = (req) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return null;
    try {
        const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
        return decoded?.id || null;
    } catch {
        return null;
    }
};

/**
 * Per-visitor write ceiling, so a stuck loop or a scripted POST cannot grow the
 * table without bound. Fails OPEN: if Redis is down we would rather record
 * slightly too much than silently stop recording. Consistent with the codebase
 * rule that Redis is an accelerator, never a gate.
 */
const RATE_LIMIT_EVENTS = 600;
const RATE_LIMIT_WINDOW_SECONDS = 600;

const withinRateLimit = async (visitorId, count) => {
    if (!isRedisReady()) return true;
    try {
        const key = `analytics:rate:${visitorId}`;
        const total = await redis.incrby(key, count);
        if (total === count) await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
        return total <= RATE_LIMIT_EVENTS;
    } catch {
        return true;
    }
};

/**
 * POST /api/analytics/collect  (public)
 *
 * Body: { visitorId, sessionId, events: [{ name, path, title, referrer,
 *         device, eventId, params, ts }] }
 */
export const collectEvents = async (req, res) => {
    // Answer first, work after. The browser gets its 204 regardless of what
    // happens below, and sendBeacon in particular ignores the response anyway.
    const respond = () => {
        if (!res.headersSent) res.status(204).end();
    };

    try {
        const userAgent = req.headers["user-agent"] || "";
        if (!userAgent || BOT_PATTERN.test(userAgent)) return respond();

        const body = req.body || {};
        const visitorId = clamp(body.visitorId, LIMITS.visitor_id);
        const sessionId = clamp(body.sessionId, LIMITS.session_id);
        const incoming = Array.isArray(body.events) ? body.events.slice(0, MAX_BATCH) : [];

        if (!visitorId || !sessionId || incoming.length === 0) return respond();
        if (!(await withinRateLimit(visitorId, incoming.length))) return respond();

        const userId = resolveUserId(req);
        const now = Date.now();

        const rows = [];
        for (const raw of incoming) {
            if (!raw || typeof raw !== "object") continue;

            const eventName = clamp(raw.name, LIMITS.event_name);
            const pagePath = clamp(raw.path, LIMITS.page_path);
            if (!eventName || !pagePath) continue;
            if (!EVENT_NAME_PATTERN.test(eventName)) continue;

            // Clients batch and flush, so a timestamp is legitimately a little
            // older than "now". Anything outside a day in either direction is a
            // wrong clock or a replay; fall back to server time rather than
            // letting it land in the wrong reporting bucket.
            const clientTs = Number(raw.ts);
            const occurredAt =
                Number.isFinite(clientTs) && Math.abs(now - clientTs) < 86_400_000
                    ? new Date(clientTs)
                    : new Date(now);

            // Unrecognised ids are stored anyway rather than rejected: the read
            // side joins to events and drops whatever does not match, so a stale
            // link costs one ignored row instead of a lost page view.
            const eventPublicId = clamp(raw.eventPublicId, LIMITS.event_public_id);
            const validEventId =
                eventPublicId && EVENT_PUBLIC_ID_PATTERN.test(eventPublicId)
                    ? eventPublicId
                    : null;

            let params = {};
            if (raw.params && typeof raw.params === "object" && !Array.isArray(raw.params)) {
                const encoded = JSON.stringify(raw.params);
                // Oversized param blobs are dropped, not truncated: half a JSON
                // document is not a smaller JSON document.
                if (encoded.length <= MAX_PARAMS_BYTES) params = raw.params;
            }

            const device = String(raw.device || "").toLowerCase();

            rows.push({
                occurred_at: occurredAt.toISOString(),
                visitor_id: visitorId,
                session_id: sessionId,
                event_name: eventName,
                page_path: pagePath,
                page_title: clamp(raw.title, LIMITS.page_title),
                referrer: clamp(raw.referrer, LIMITS.referrer),
                device: DEVICES.has(device) ? device : null,
                event_public_id: validEventId,
                user_id: userId,
                params,
            });
        }

        if (rows.length === 0) return respond();

        const { error } = await supabaseAdmin.from("site_analytics_events").insert(rows);
        if (error) console.warn("Analytics insert failed:", error.message);

        return respond();
    } catch (err) {
        console.warn("Analytics collect error:", err.message);
        return respond();
    }
};

// Selectable reporting windows. An arbitrary caller-supplied range would let a
// single request ask the database to aggregate all history.
const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };
const DEFAULT_RANGE = "30d";

const resolveRange = (rangeKey) => {
    const days = RANGE_DAYS[rangeKey] || RANGE_DAYS[DEFAULT_RANGE];
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const prevFrom = new Date(from.getTime() - days * 86_400_000);
    return { days, from, to, prevFrom, prevTo: from };
};

/**
 * GET /api/admin/analytics?range=30d  (admin)
 *
 * Returns both halves of the picture in one response:
 *   `site`   — our own table: page views, clicks, per-event funnels
 *   `google` — GA4: users, sessions, acquisition channels, devices
 *
 * GA is fetched in parallel and can never fail the request; when it is missing
 * or erroring the client renders `site` alone and shows GA's reason.
 */
export const getAnalyticsDashboard = async (req, res) => {
    try {
        const rangeKey = RANGE_DAYS[req.query.range] ? req.query.range : DEFAULT_RANGE;
        const { days, from, to, prevFrom, prevTo } = resolveRange(rangeKey);

        const [siteResult, googleResult] = await Promise.all([
            supabaseAdmin.rpc("analytics_dashboard", {
                p_from: from.toISOString(),
                p_to: to.toISOString(),
            }),
            fetchGoogleAnalytics({ from, to, prevFrom, prevTo }),
        ]);

        if (siteResult.error) {
            console.error("analytics_dashboard RPC failed:", siteResult.error);
            return res.status(500).json({
                success: false,
                message:
                    "Analytics query failed. If this is a fresh deploy, the " +
                    "site_analytics migration may not have been run yet.",
            });
        }

        return res.json({
            success: true,
            range: rangeKey,
            days,
            site: siteResult.data,
            google: googleResult,
        });
    } catch (err) {
        console.error("Analytics dashboard error:", err);
        return res.status(500).json({ success: false, message: "Failed to load analytics" });
    }
};

/**
 * GET /api/admin/analytics/status  (admin)
 * Small probe so the UI can explain a missing GA panel without guessing.
 */
export const getAnalyticsStatus = async (_req, res) => {
    res.json({
        success: true,
        google_configured: isGoogleAnalyticsConfigured(),
    });
};
