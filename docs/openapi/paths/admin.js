/**
 * /api/admin/* — everything except the draw / league / match engine,
 * which lives in tournament.js.
 *
 * Every route here is behind `verifyAdmin`: role must be `admin` or
 * `superadmin`. Routes marked "superadmin only" additionally reject a plain
 * admin with 403.
 */

import { errors, ok, okEnvelope } from "../components.js";

const p = (ref) => ({ $ref: `#/components/parameters/${ref}` });
const s = (name) => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (name) => ({ type: "array", items: s(name) });

const jsonBody = (schema) => ({ required: true, content: { "application/json": { schema } } });
const obj = (properties, required = []) => ({ type: "object", required, properties });

const auth = [{ bearerAuth: [] }];
const uuidPath = (name, description) => ({
    name,
    in: "path",
    required: true,
    description,
    schema: { type: "string", format: "uuid" },
});

export const adminPaths = {
    /* ── admin accounts ──────────────────────────────────────────────────── */

    "/api/admin/list-admins": {
        get: {
            tags: ["Admin · Accounts"],
            summary: "List admin accounts and their approval state",
            security: auth,
            responses: { ...okEnvelope("Admins.", { admins: arrayOf("User") }), ...errors(401, 403, 500) },
        },
    },

    "/api/admin/approve-admin/{id}": {
        post: {
            tags: ["Admin · Accounts"],
            summary: "Approve a pending admin application",
            security: auth,
            parameters: [uuidPath("id", "`users.id` of the pending admin.")],
            responses: { ...okEnvelope("Approved."), ...errors(401, 403, 404, 500) },
        },
    },

    "/api/admin/reject-admin/{id}": {
        post: {
            tags: ["Admin · Accounts"],
            summary: "Reject a pending admin application",
            security: auth,
            parameters: [uuidPath("id", "`users.id` of the pending admin.")],
            responses: { ...okEnvelope("Rejected."), ...errors(401, 403, 404, 500) },
        },
    },

    "/api/admin/update-admin-role/{id}": {
        post: {
            tags: ["Admin · Accounts"],
            summary: "Promote or demote an admin",
            description: "Superadmin only. You cannot demote yourself (400).",
            security: auth,
            parameters: [uuidPath("id", "`users.id` of the target admin.")],
            requestBody: jsonBody(obj({ role: { type: "string", enum: ["admin", "superadmin"] } }, ["role"])),
            responses: { ...okEnvelope("Role updated."), ...errors(400, 401, 403, 500) },
        },
    },

    "/api/admin/delete-admin/{id}": {
        delete: {
            tags: ["Admin · Accounts"],
            summary: "Delete an admin and reassign their events",
            security: auth,
            parameters: [uuidPath("id", "`users.id` of the admin to delete.")],
            responses: { ...okEnvelope("Deleted and events re-organised."), ...errors(401, 403, 404, 500) },
        },
    },

    "/api/admin/assignments": {
        get: {
            tags: ["Admin · Accounts"],
            summary: "Admins with the events assigned to each",
            description: "Superadmin only. Merges the legacy `events.assigned_to` column with the `event_admin_assignments` table.",
            security: auth,
            responses: {
                ...okEnvelope("Assignment map.", {
                    admins: { type: "array", items: { allOf: [s("User"), obj({ events: arrayOf("Event") })] } },
                }),
                ...errors(401, 403, 500),
            },
        },
    },

    /* ── permissions ─────────────────────────────────────────────────────── */

    "/api/admin/permissions": {
        get: {
            tags: ["Admin · Permissions"],
            summary: "Every admin with their permission flags",
            description: "Superadmin only.",
            security: auth,
            responses: {
                ...okEnvelope("Admins and permissions.", {
                    data: { type: "array", items: { allOf: [s("User"), obj({ permissions: s("AdminPermissions") })] } },
                }),
                ...errors(401, 403, 500),
            },
        },
    },

    "/api/admin/permissions/{adminId}": {
        put: {
            tags: ["Admin · Permissions"],
            summary: "Set one admin's permission flags",
            description: "Superadmin only. Omitted flags are left unchanged.",
            security: auth,
            parameters: [uuidPath("adminId", "`users.id` of the admin.")],
            requestBody: jsonBody(
                obj({
                    permit: { type: "boolean", description: "Approve/reject player registrations." },
                    apartments: { type: "boolean" },
                    advertisements: { type: "boolean" },
                    broadcast: { type: "boolean" },
                    reports: { type: "boolean" },
                })
            ),
            responses: { ...okEnvelope("Permissions updated."), ...errors(400, 401, 403, 404, 500) },
        },
    },

    "/api/admin/my-permissions": {
        get: {
            tags: ["Admin · Permissions"],
            summary: "The caller's own permission flags",
            description: "Any admin. Superadmins always get all-true without a DB read; an admin with no row yet also defaults to all-true.",
            security: auth,
            responses: { ...okEnvelope("Permissions.", { permissions: s("AdminPermissions") }), ...errors(401, 403, 500) },
        },
    },

    /* ── dashboard & uploads ─────────────────────────────────────────────── */

    "/api/admin/dashboard-stats": {
        get: {
            tags: ["Admin · Dashboard"],
            summary: "Headline counts, revenue and recent activity",
            description: "`totalRevenue` sums `amount_paid` across registrations in status `verified`.",
            security: auth,
            responses: {
                ...okEnvelope("Stats.", {
                    stats: obj({
                        totalPlayers: { type: "integer" },
                        verifiedPlayers: { type: "integer" },
                        pendingPlayers: { type: "integer" },
                        rejectedPlayers: { type: "integer" },
                        totalRevenue: { type: "number", format: "double" },
                        totalTransactionsCount: { type: "integer" },
                    }),
                    recentPlayers: arrayOf("User"),
                    rejectedPlayersList: arrayOf("User"),
                    rejectedTransactions: arrayOf("Transaction"),
                }),
                ...errors(401, 403, 500),
            },
        },
    },

    "/api/admin/upload": {
        post: {
            tags: ["Admin · Dashboard"],
            summary: "Upload a base64 image and get its URL back",
            description: "Generic asset upload used by the admin console before saving a record that references the file.",
            security: auth,
            requestBody: jsonBody(
                obj(
                    {
                        image: { type: "string", description: "`data:image/...;base64,...`" },
                        folder: { type: "string", description: "Sub-path inside the bucket.", example: "banners" },
                    },
                    ["image"]
                )
            ),
            responses: { ...okEnvelope("Uploaded.", { url: { type: "string" } }), ...errors(400, 401, 403, 500) },
        },
    },

    "/api/admin/settings": {
        get: {
            tags: ["Admin · Settings"],
            summary: "Read platform settings",
            security: auth,
            responses: { ...okEnvelope("Settings.", { settings: s("PlatformSettings") }), ...errors(401, 403, 500) },
        },
        post: {
            tags: ["Admin · Settings"],
            summary: "Update platform settings",
            security: auth,
            requestBody: jsonBody(
                obj({
                    platformName: { type: "string", example: "Sports Paramount" },
                    supportEmail: { type: "string", format: "email" },
                    supportPhone: { type: "string" },
                    logoUrl: { type: "string" },
                    logoSize: { type: "integer", example: 64 },
                })
            ),
            responses: { ...okEnvelope("Updated.", { settings: s("PlatformSettings") }), ...errors(400, 401, 403, 500) },
        },
    },

    /* ── players ─────────────────────────────────────────────────────────── */

    "/api/admin/players": {
        get: {
            tags: ["Admin · Players"],
            summary: "List players",
            security: auth,
            parameters: [p("Search"), p("Page"), p("Limit")],
            responses: { ...okEnvelope("Players.", { players: arrayOf("User"), total_count: { type: "integer" } }), ...errors(401, 403, 500) },
        },
    },

    "/api/admin/players/{id}": {
        get: {
            tags: ["Admin · Players"],
            summary: "One player with their registrations and family links",
            security: auth,
            parameters: [uuidPath("id", "`users.id` of the player.")],
            responses: { ...okEnvelope("Player detail.", { player: { allOf: [s("User"), obj({ registrations: arrayOf("Registration") })] } }), ...errors(401, 403, 404, 500) },
        },
    },

    /* ── institutes ──────────────────────────────────────────────────────── */

    "/api/admin/institutes/pending": {
        get: {
            tags: ["Admin · Institutes"],
            summary: "Institutes awaiting verification",
            security: auth,
            responses: { ...okEnvelope("Institutes.", { data: arrayOf("User") }), ...errors(401, 403, 500) },
        },
    },

    "/api/admin/institutes/verified": {
        get: {
            tags: ["Admin · Institutes"],
            summary: "Verified institutes",
            security: auth,
            responses: { ...okEnvelope("Institutes.", { data: arrayOf("User") }), ...errors(401, 403, 500) },
        },
    },

    "/api/admin/institutes/{id}/approve": {
        put: {
            tags: ["Admin · Institutes"],
            summary: "Approve an institute account",
            security: auth,
            parameters: [uuidPath("id", "`users.id` of the institute head.")],
            responses: { ...okEnvelope("Approved."), ...errors(401, 403, 404, 500) },
        },
    },

    "/api/admin/institutes/{id}/reject": {
        put: {
            tags: ["Admin · Institutes"],
            summary: "Reject an institute account",
            security: auth,
            parameters: [uuidPath("id", "`users.id` of the institute head.")],
            requestBody: { required: false, content: { "application/json": { schema: obj({ rejection_remark: { type: "string" } }) } } },
            responses: { ...okEnvelope("Rejected."), ...errors(401, 403, 404, 500) },
        },
    },

    "/api/admin/institutes/imports/pending": {
        get: {
            tags: ["Admin · Institutes"],
            summary: "Bulk student-import requests awaiting approval",
            security: auth,
            responses: { ...okEnvelope("Requests.", { data: arrayOf("InstituteApproval") }), ...errors(401, 403, 500) },
        },
    },

    "/api/admin/institutes/imports/approved": {
        get: {
            tags: ["Admin · Institutes"],
            summary: "Bulk student-import requests already approved",
            security: auth,
            responses: { ...okEnvelope("Requests.", { data: arrayOf("InstituteApproval") }), ...errors(401, 403, 500) },
        },
    },

    "/api/admin/institutes/imports/{id}/approve": {
        put: {
            tags: ["Admin · Institutes"],
            summary: "Approve a bulk student import",
            description: "Unblocks `POST /api/institute/bulk-import-finalize` for that institute.",
            security: auth,
            parameters: [uuidPath("id", "`institute_approvals.id`.")],
            responses: { ...okEnvelope("Approved."), ...errors(401, 403, 404, 500) },
        },
    },

    "/api/admin/institutes/imports/{id}/reject": {
        delete: {
            tags: ["Admin · Institutes"],
            summary: "Reject and remove a bulk-import request",
            security: auth,
            parameters: [uuidPath("id", "`institute_approvals.id`.")],
            responses: { ...okEnvelope("Rejected and removed."), ...errors(401, 403, 404, 500) },
        },
    },

    /* ── registrations & transactions ────────────────────────────────────── */

    "/api/admin/all-categories": {
        get: {
            tags: ["Admin · Registrations"],
            summary: "Distinct category labels across all events",
            description: "Feeds the category filter dropdowns.",
            security: auth,
            responses: { ...okEnvelope("Sorted labels.", { categories: { type: "array", items: { type: "string" } } }), ...errors(401, 403, 500) },
        },
    },

    "/api/admin/registrations": {
        get: {
            tags: ["Admin · Registrations"],
            summary: "List registrations",
            description: "Scope with `eventId`, or with `admin_id` to see only the events that admin owns or is assigned to.",
            security: auth,
            parameters: [
                { name: "eventId", in: "query", schema: { type: "string", example: "13" } },
                { name: "admin_id", in: "query", schema: { type: "string", format: "uuid" } },
                p("Page"),
                p("Limit"),
            ],
            responses: {
                ...okEnvelope("Registrations.", { registrations: arrayOf("Registration"), total_count: { type: "integer" } }),
                ...errors(401, 403, 500),
            },
        },
    },

    "/api/admin/transactions": {
        get: {
            tags: ["Admin · Registrations"],
            summary: "List payment transactions",
            security: auth,
            parameters: [
                { name: "eventId", in: "query", schema: { type: "string", example: "13" } },
                { name: "admin_id", in: "query", schema: { type: "string", format: "uuid" } },
                p("Page"),
                p("Limit"),
            ],
            responses: {
                ...okEnvelope("Transactions.", { transactions: arrayOf("Transaction"), total_count: { type: "integer" } }),
                ...errors(401, 403, 500),
            },
        },
    },

    "/api/admin/transactions/{id}/verify": {
        put: {
            tags: ["Admin · Registrations"],
            summary: "Verify a manual payment",
            description: "Marks the registration `verified` and triggers the confirmation email/WhatsApp with the receipt.",
            security: auth,
            parameters: [uuidPath("id", "`transactions.id`.")],
            responses: { ...okEnvelope("Verified."), ...errors(401, 403, 404, 500) },
        },
    },

    "/api/admin/transactions/{id}/reject": {
        put: {
            tags: ["Admin · Registrations"],
            summary: "Reject a manual payment",
            security: auth,
            parameters: [uuidPath("id", "`transactions.id`.")],
            responses: { ...okEnvelope("Rejected."), ...errors(401, 403, 404, 500) },
        },
    },

    "/api/admin/transactions/bulk-update": {
        post: {
            tags: ["Admin · Registrations"],
            summary: "Verify or reject many transactions at once",
            security: auth,
            requestBody: jsonBody(
                obj(
                    {
                        ids: { type: "array", items: { type: "string", format: "uuid" }, minItems: 1 },
                        status: { type: "string", enum: ["verified", "rejected"] },
                    },
                    ["ids", "status"]
                )
            ),
            responses: { ...okEnvelope("Updated.", { count: { type: "integer" }, message: { type: "string" } }), ...errors(400, 401, 403, 500) },
        },
    },

    /* ── event news ──────────────────────────────────────────────────────── */

    "/api/admin/news": {
        get: {
            tags: ["Admin · News"],
            summary: "News items for an event",
            security: auth,
            parameters: [{ name: "eventId", in: "query", required: true, schema: { type: "string", example: "13" } }],
            responses: { ...okEnvelope("News.", { news: arrayOf("EventNews") }), ...errors(400, 401, 403, 500) },
        },
        post: {
            tags: ["Admin · News"],
            summary: "Create a news item",
            security: auth,
            requestBody: jsonBody(
                obj(
                    {
                        eventId: { oneOf: [{ type: "integer" }, { type: "string" }], example: 13 },
                        title: { type: "string" },
                        content: { type: "string" },
                        imageUrl: { type: "string" },
                        isHighlight: { type: "boolean", default: false },
                    },
                    ["eventId", "title"]
                )
            ),
            responses: { ...okEnvelope("Created.", { news: s("EventNews") }), ...errors(400, 401, 403, 500) },
        },
    },

    "/api/admin/news/{id}": {
        put: {
            tags: ["Admin · News"],
            summary: "Update a news item",
            security: auth,
            parameters: [uuidPath("id", "`event_news.id`.")],
            requestBody: jsonBody(obj({ title: { type: "string" }, content: { type: "string" }, imageUrl: { type: "string" }, isHighlight: { type: "boolean" } })),
            responses: { ...okEnvelope("Updated.", { news: s("EventNews") }), ...errors(400, 401, 403, 404, 500) },
        },
        delete: {
            tags: ["Admin · News"],
            summary: "Delete a news item",
            security: auth,
            parameters: [uuidPath("id", "`event_news.id`.")],
            responses: { ...okEnvelope("Deleted."), ...errors(401, 403, 404, 500) },
        },
    },

    /* ── simple bracket/media CRUD ───────────────────────────────────────── */

    "/api/admin/brackets": {
        get: {
            tags: ["Admin · Brackets (simple)"],
            summary: "Bracket rows for an event",
            description:
                "The flat CRUD view of `event_brackets`, used by the media/PDF draw uploader. The interactive draw engine is under **Admin · Draws**.",
            security: auth,
            parameters: [{ name: "eventId", in: "query", required: true, schema: { type: "string", example: "13" } }],
            responses: { ...okEnvelope("Brackets.", { brackets: arrayOf("Bracket") }), ...errors(400, 401, 403, 500) },
        },
        post: {
            tags: ["Admin · Brackets (simple)"],
            summary: "Create or replace a bracket row",
            description: "Upserts on event + category + round.",
            security: auth,
            requestBody: jsonBody(
                obj(
                    {
                        eventId: { oneOf: [{ type: "integer" }, { type: "string" }], example: 13 },
                        category: { type: "string", description: "Category label or id.", example: "Above 17 Mixed" },
                        roundName: { type: "string", example: "Round 1" },
                        drawType: { type: "string", nullable: true },
                        drawData: { type: "object", additionalProperties: true },
                        pdfUrl: { type: "string", nullable: true },
                    },
                    ["eventId", "category", "roundName"]
                )
            ),
            responses: { ...okEnvelope("Saved.", { bracket: s("Bracket") }), ...errors(400, 401, 403, 500) },
        },
    },

    "/api/admin/brackets/{id}": {
        delete: {
            tags: ["Admin · Brackets (simple)"],
            summary: "Delete a bracket row and its matches",
            security: auth,
            parameters: [uuidPath("id", "`event_brackets.id`.")],
            responses: { ...okEnvelope("Bracket and related matches deleted."), ...errors(400, 401, 403, 404, 500) },
        },
    },

    /* ── broadcasts ──────────────────────────────────────────────────────── */

    "/api/admin/broadcast/audience": {
        get: {
            tags: ["Admin · Broadcasts"],
            summary: "Preview who a broadcast would reach",
            description:
                "Resolve the audience **before** sending, so the admin sees the exact recipient list. Phone numbers are never accepted from the browser on send — you pass back the `key` values you saw here.",
            security: auth,
            parameters: [
                { name: "type", in: "query", description: "`all` = every player; `event` = registrants of one event.", schema: { type: "string", enum: ["all", "event"], default: "all" } },
                { name: "eventId", in: "query", description: "Required when `type=event`.", schema: { type: "string", example: "13" } },
                { name: "categoryId", in: "query", description: "Narrow an event audience to one category.", schema: { type: "string" } },
                { name: "includeTeamMembers", in: "query", description: "Send `false` to message captains only.", schema: { type: "string", enum: ["true", "false"], default: "true" } },
            ],
            responses: {
                ...okEnvelope("Resolved audience.", {
                    recipients: arrayOf("BroadcastRecipient"),
                    categories: { type: "array", items: { type: "object", additionalProperties: true } },
                    eventName: { type: "string", nullable: true },
                    counts: obj({
                        total: { type: "integer" },
                        reachable: { type: "integer", description: "Recipients with a usable WhatsApp number." },
                        unreachable: { type: "integer" },
                        teamMembers: { type: "integer" },
                    }),
                    whatsapp: obj({
                        enabled: { type: "boolean", description: "False when `WHATSAPP_PHONE_ID`/`WHATSAPP_TOKEN` are unset." },
                        templates: { type: "object", additionalProperties: true },
                    }),
                }),
                ...errors(400, 401, 403, 500),
            },
        },
    },

    "/api/admin/broadcast": {
        post: {
            tags: ["Admin · Broadcasts"],
            summary: "Send a WhatsApp / in-app broadcast",
            description:
                "Returns **202** immediately and delivers in the background — a few hundred WhatsApp sends take minutes. Track progress with `GET /api/admin/broadcasts/{id}`. `audience.keys` may only narrow the resolved audience, never widen it.",
            security: auth,
            requestBody: jsonBody(
                obj(
                    {
                        title: { type: "string", example: "Draw published" },
                        message: { type: "string", example: "Round 1 draws for the Volleyball Premier League are live." },
                        image: { type: "string", nullable: true, description: "`data:image/...;base64,...` — uses the image WhatsApp template." },
                        audience: obj({
                            type: { type: "string", enum: ["all", "event"], default: "all" },
                            eventId: { type: "string", nullable: true },
                            categoryId: { type: "string", nullable: true },
                            includeTeamMembers: { type: "boolean", default: true },
                            keys: {
                                type: "array",
                                items: { type: "string" },
                                description: "Manual pick — the `key` values from `/broadcast/audience`.",
                            },
                        }),
                        channels: {
                            type: "array",
                            items: { type: "string", enum: ["whatsapp", "in_app"] },
                            default: ["whatsapp", "in_app"],
                        },
                    },
                    ["title", "message"]
                )
            ),
            responses: {
                202: {
                    description: "Queued — delivery continues in the background.",
                    content: {
                        "application/json": {
                            schema: obj({
                                success: { type: "boolean" },
                                broadcastId: { type: "string", format: "uuid" },
                                message: { type: "string" },
                                stats: obj({ total: { type: "integer" }, reachable: { type: "integer" }, unreachable: { type: "integer" } }),
                            }),
                        },
                    },
                },
                ...errors(400, 401, 403, 500),
                503: { description: "WhatsApp requested but `WHATSAPP_PHONE_ID`/`WHATSAPP_TOKEN` are not configured." },
            },
        },
    },

    "/api/admin/broadcasts": {
        get: {
            tags: ["Admin · Broadcasts"],
            summary: "Broadcast history",
            security: auth,
            parameters: [p("Page"), p("Limit")],
            responses: { ...okEnvelope("Broadcasts.", { broadcasts: arrayOf("Broadcast"), total_count: { type: "integer" } }), ...errors(401, 403, 500) },
        },
    },

    "/api/admin/broadcasts/{id}": {
        get: {
            tags: ["Admin · Broadcasts"],
            summary: "One broadcast with per-recipient delivery state",
            security: auth,
            parameters: [
                uuidPath("id", "`broadcast_logs.id`."),
                {
                    name: "status",
                    in: "query",
                    description: "Filter the recipient list.",
                    schema: { type: "string", enum: ["all", "pending", "sent", "delivered", "read", "failed", "skipped"], default: "all" },
                },
            ],
            responses: {
                ...okEnvelope("Broadcast detail.", {
                    broadcast: s("Broadcast"),
                    recipients: { type: "array", items: { type: "object", additionalProperties: true } },
                    summary: obj({
                        total: { type: "integer" },
                        pending: { type: "integer" },
                        sent: { type: "integer" },
                        delivered: { type: "integer" },
                        read: { type: "integer" },
                        failed: { type: "integer" },
                        skipped: { type: "integer" },
                    }),
                }),
                ...errors(401, 403, 404, 500),
            },
        },
    },

    "/api/admin/broadcasts/{id}/retry": {
        post: {
            tags: ["Admin · Broadcasts"],
            summary: "Re-send only the failed recipients",
            description: "409 while the original send is still running; 400 when nothing failed.",
            security: auth,
            parameters: [uuidPath("id", "`broadcast_logs.id`.")],
            responses: {
                202: { description: "Retry queued.", content: { "application/json": { schema: s("SuccessMessage") } } },
                ...errors(400, 401, 403, 404, 409, 500),
            },
        },
    },

    "/api/admin/broadcasts/{id}/refresh": {
        post: {
            tags: ["Admin · Broadcasts"],
            summary: "Recount delivery status from the stored recipient rows",
            description: "Use after Meta's delivery webhooks land, to refresh the summary counters.",
            security: auth,
            parameters: [uuidPath("id", "`broadcast_logs.id`.")],
            responses: { ...okEnvelope("Counters refreshed."), ...errors(401, 403, 404, 500) },
        },
    },
};
