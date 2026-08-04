/** Events, public (unauthenticated) reads, file delivery, health and webhooks. */

import { errors, ok, okEnvelope } from "../components.js";

const p = (ref) => ({ $ref: `#/components/parameters/${ref}` });
const s = (name) => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (name) => ({ type: "array", items: s(name) });

const jsonBody = (schema) => ({ required: true, content: { "application/json": { schema } } });

/** Query params shared by every "which category / which round" reader. */
const matchFilterParams = [
    { name: "categoryId", in: "query", description: "Category id from `events.categories[].id`.", schema: { type: "string" } },
    { name: "categoryName", in: "query", description: "Category label — alternative to `categoryId`.", schema: { type: "string" } },
    { name: "roundName", in: "query", description: "e.g. `Round 1`, `Quarter Final`, `Final`.", schema: { type: "string" } },
    { name: "bracketId", in: "query", description: "Narrow to a single bracket.", schema: { type: "string" } },
];

export const eventPaths = {
    "/api/events/list": {
        get: {
            tags: ["Events"],
            summary: "List events (admin console list)",
            description:
                "Unauthenticated. Pagination applies only when **both** `page` and `limit` are sent; otherwise every row comes back. `total_count` is the unpaginated total.",
            parameters: [
                { name: "created_by", in: "query", description: "Only events created by this admin.", schema: { type: "string", format: "uuid" } },
                {
                    name: "admin_id",
                    in: "query",
                    description: "Events this admin created **or** is assigned to (single or multi-assignment).",
                    schema: { type: "string", format: "uuid" },
                },
                p("Search"),
                p("Page"),
                p("Limit"),
            ],
            responses: {
                ...okEnvelope("Events, newest start date first.", {
                    events: arrayOf("Event"),
                    total_count: { type: "integer", nullable: true, example: 42 },
                }),
                ...errors(500),
            },
        },
    },

    "/api/events/create": {
        post: {
            tags: ["Events"],
            summary: "Create an event",
            description:
                "Admin only. Uploads any `data:` images, generates the share QR code, notifies superadmins when a non-superadmin creates the event, and syncs admin assignments.",
            security: [{ bearerAuth: [] }],
            requestBody: jsonBody(s("EventWriteRequest")),
            responses: { ...okEnvelope("Created.", { event: s("Event") }), ...errors(400, 401, 403, 500) },
        },
    },

    "/api/events/{id}": {
        get: {
            tags: ["Events"],
            summary: "Get one event",
            description: "Unauthenticated. Cached for 60s in Redis; writes invalidate it.",
            parameters: [p("EventIdPath")],
            responses: { ...okEnvelope("Event detail.", { event: s("Event") }), ...errors(404, 500) },
        },
        put: {
            tags: ["Events"],
            summary: "Update an event",
            description: "Admin only. Same body shape as create — send only the fields you want changed.",
            security: [{ bearerAuth: [] }],
            parameters: [p("EventIdPath")],
            requestBody: jsonBody(s("EventWriteRequest")),
            responses: { ...okEnvelope("Updated.", { event: s("Event") }), ...errors(400, 401, 403, 404, 500) },
        },
        delete: {
            tags: ["Events"],
            summary: "Delete an event",
            description: "Admin only. Refuses with **409** when the event still has registrations.",
            security: [{ bearerAuth: [] }],
            parameters: [p("EventIdPath")],
            responses: { ...okEnvelope("Deleted.", { message: { type: "string", example: "Event deleted" } }), ...errors(401, 403, 404, 409, 500) },
        },
    },

    "/api/events/{id}/brackets": {
        get: {
            tags: ["Events"],
            summary: "All brackets/draws for an event",
            description: "Unauthenticated. Excludes the internal `LEAGUE_PLACEHOLDER` rows.",
            parameters: [p("EventIdPath")],
            responses: { ...okEnvelope("Brackets grouped by category and round.", { brackets: arrayOf("Bracket") }), ...errors(404, 500) },
        },
    },

    "/api/events/{id}/matches": {
        get: {
            tags: ["Events"],
            summary: "Public scoreboard for an event",
            description:
                "Unauthenticated read used by the live scoreboard. The admin equivalent is `GET /api/admin/matches/{eventId}`.",
            parameters: [p("EventIdPath"), ...matchFilterParams],
            responses: { ...okEnvelope("Matches.", { matches: arrayOf("Match") }), ...errors(404, 500) },
        },
    },

    "/api/events/{id}/sponsors": {
        get: {
            tags: ["Events"],
            summary: "Sponsors for an event",
            parameters: [p("EventIdPath")],
            responses: { ...okEnvelope("Sponsors.", { sponsors: arrayOf("Sponsor") }), ...errors(404, 500) },
        },
    },

    /* ── public reads ────────────────────────────────────────────────────── */

    "/api/public/settings": {
        get: {
            tags: ["Public"],
            summary: "Platform branding and registration-form config",
            description: "Unauthenticated. Cached in Redis.",
            responses: { ...okEnvelope("Settings.", { settings: s("PlatformSettings") }), ...errors(500) },
        },
    },

    "/api/public/events/list": {
        get: {
            tags: ["Public"],
            summary: "Public events list",
            description:
                "Unauthenticated and deliberately parameter-free — the client fetches once and filters/sorts/paginates in memory. Cached 5 minutes (`EVENTS_LIST_CACHE_TTL_SECONDS`).",
            responses: { ...okEnvelope("Events.", { events: arrayOf("Event") }), ...errors(500) },
        },
    },

    "/api/public/events/{id}/draws": {
        get: {
            tags: ["Public"],
            summary: "All **published** draws for an event, grouped by category",
            description: "Unpublished draws are never returned here — use the admin `/api/admin/events/{id}/draws` for those.",
            parameters: [p("EventIdPath")],
            responses: {
                ...okEnvelope("Published draws.", {
                    draws: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                categoryId: { type: "string", nullable: true },
                                categoryLabel: { type: "string", nullable: true },
                                rounds: arrayOf("Bracket"),
                            },
                        },
                    },
                }),
                ...errors(400, 404, 500),
            },
        },
    },

    "/api/public/events/{id}/categories/{categoryId}/draw": {
        get: {
            tags: ["Public"],
            summary: "Published draw for one category",
            parameters: [p("EventIdPath"), p("CategoryIdPath")],
            responses: { ...okEnvelope("Draw.", { draw: s("Bracket"), rounds: arrayOf("Bracket") }), ...errors(400, 404, 500) },
        },
    },

    "/api/public/events/{id}/categories/draw": {
        get: {
            tags: ["Public"],
            summary: "Published draw for one category (by label)",
            description: "Same as the `{categoryId}` route, addressing the category with the `categoryLabel` query parameter instead.",
            parameters: [p("EventIdPath"), p("CategoryLabelQuery")],
            responses: { ...okEnvelope("Draw.", { draw: s("Bracket"), rounds: arrayOf("Bracket") }), ...errors(400, 404, 500) },
        },
    },

    "/api/public/events/{id}/categories/{categoryId}/league": {
        get: {
            tags: ["Public"],
            summary: "Published league table for one category",
            parameters: [p("EventIdPath"), p("CategoryIdPath")],
            responses: { ...okEnvelope("League config and standings.", { league: s("League") }), ...errors(400, 404, 500) },
        },
    },

    "/api/public/events/{id}/categories/league": {
        get: {
            tags: ["Public"],
            summary: "Published league table for one category (by label)",
            parameters: [p("EventIdPath"), p("CategoryLabelQuery")],
            responses: { ...okEnvelope("League config and standings.", { league: s("League") }), ...errors(400, 404, 500) },
        },
    },

    "/api/public/events/{id}/share": {
        get: {
            tags: ["Public"],
            summary: "OG link-preview page for an event",
            description: "Returns **HTML**, not JSON — it exists so chat apps render a rich card for a shared event link.",
            parameters: [p("EventIdPath")],
            responses: {
                200: { description: "HTML document with OpenGraph meta tags.", content: { "text/html": { schema: { type: "string" } } } },
                ...errors(404, 500),
            },
        },
    },

    /* ── files ───────────────────────────────────────────────────────────── */

    "/api/files/{bucket}/{path}": {
        get: {
            tags: ["Files"],
            summary: "Fetch a file from the private Railway bucket",
            description: [
                "Every file URL stored in the database points here, so the storage backend can change without rewriting URLs.",
                "",
                "- **Default** — 302 redirect to a 1-hour signed bucket URL. Right for `<img src>`; useless to `fetch()` because the bucket response carries no CORS header.",
                "- **`?download=1`** — the bytes are streamed through this server with `Content-Disposition: attachment`, so `fetch`/blob/File work.",
            ].join("\n"),
            parameters: [
                {
                    name: "bucket",
                    in: "path",
                    required: true,
                    description: "One of the known buckets.",
                    schema: {
                        type: "string",
                        enum: ["admin-assets", "event-assets", "event-documents", "player-photos", "player_uploads"],
                    },
                },
                {
                    name: "path",
                    in: "path",
                    required: true,
                    description: "Object key within the bucket, slashes allowed. `..` is rejected.",
                    schema: { type: "string", example: "banners/1772700606209_u1k62g.jpg" },
                },
                { name: "download", in: "query", description: "Present (any value) ⇒ stream the bytes instead of redirecting.", schema: { type: "string" } },
            ],
            responses: {
                200: { description: "File bytes (only in `?download` mode).", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
                302: { description: "Redirect to a short-lived signed bucket URL." },
                ...errors(400, 404, 500),
                502: { description: "Upstream bucket did not return the object." },
            },
        },
    },

    /* ── health ──────────────────────────────────────────────────────────── */

    "/api/health/redis": {
        get: {
            tags: ["Health"],
            summary: "Redis round-trip check",
            description: "PING plus a real write→read, with latency. `ok: false, enabled: false` means no `REDIS_URL` is configured — the app runs fine without it (fail-soft cache).",
            responses: {
                ...ok("Redis reachable, or not configured.", {
                    type: "object",
                    properties: {
                        ok: { type: "boolean" },
                        enabled: { type: "boolean" },
                        status: { type: "string", example: "ready" },
                        ping: { type: "string", example: "PONG" },
                        readWrite: { type: "string", enum: ["ok", "mismatch"] },
                        latency_ms: { type: "integer", example: 12 },
                    },
                }),
                503: { description: "Redis configured but unreachable or inconsistent." },
            },
        },
    },

    /* ── inbound webhooks ────────────────────────────────────────────────── */

    "/api/payment/webhook": {
        post: {
            tags: ["Webhooks"],
            summary: "Razorpay payment webhook",
            description: [
                "Called by Razorpay, not by clients. Mounted **before** the JSON body parser because signature verification needs the exact raw bytes.",
                "",
                "Handles `payment.captured`, `payment.failed` and `order.paid`. Always answer 200 quickly — a non-2xx makes Razorpay retry.",
            ].join("\n"),
            parameters: [
                { name: "x-razorpay-signature", in: "header", required: true, description: "HMAC-SHA256 of the raw body using `RAZORPAY_WEBHOOK_SECRET`.", schema: { type: "string" } },
            ],
            requestBody: {
                required: true,
                content: { "application/json": { schema: { type: "object", additionalProperties: true, description: "Razorpay event envelope." } } },
            },
            responses: {
                ...ok("Acknowledged.", {
                    type: "object",
                    properties: { received: { type: "boolean", example: true }, ignored: { type: "string", nullable: true } },
                }),
                400: { description: "Bad signature, malformed payload, or a stale event." },
                500: { description: "Processing failed — Razorpay will retry." },
            },
        },
    },

    "/api/whatsapp/webhook": {
        get: {
            tags: ["Webhooks"],
            summary: "Meta webhook verification handshake",
            description: "Meta calls this once when you save the callback URL. Echoes `hub.challenge` when the verify token matches `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.",
            parameters: [
                { name: "hub.mode", in: "query", schema: { type: "string", example: "subscribe" } },
                { name: "hub.verify_token", in: "query", schema: { type: "string" } },
                { name: "hub.challenge", in: "query", schema: { type: "string" } },
            ],
            responses: {
                200: { description: "The challenge string, echoed back verbatim.", content: { "text/plain": { schema: { type: "string" } } } },
                403: { description: "Verify token mismatch." },
            },
        },
        post: {
            tags: ["Webhooks"],
            summary: "WhatsApp delivery-status callback",
            description:
                "Meta reports sent/delivered/read/failed for broadcast messages here. Public by design — Meta cannot present an admin JWT, and the payload can only move a known message id forward in status.",
            requestBody: {
                required: true,
                content: { "application/json": { schema: { type: "object", additionalProperties: true, description: "Meta Cloud API webhook envelope." } } },
            },
            responses: { 200: { description: "Acknowledged." } },
        },
    },
};
