import { supabaseAdmin } from "../config/supabaseClient.js";
import { getManageableEventIds } from "../middleware/eventAccess.js";
import { withoutPassword } from "../utils/userSanitize.js";
import { getAnalyticsDashboard } from "./analyticsController.js";
import { getPlayerDetails, listPlayers } from "./adminPlayerController.js";

// --------------------------------------------------------------------------
// Players and analytics for an admin
//   A super admin sees everything (the existing handlers run unchanged). An
//   admin sees only what belongs to the events assigned to them: the players
//   registered in those events, and the funnel of those events. Platform-wide
//   visitor figures are not theirs, so they come back empty.
// --------------------------------------------------------------------------

const isSuperAdmin = (req) => req.user?.role === "superadmin";

// Strip PostgREST filter-injection chars and SQL LIKE wildcards
const sanitizeSearch = (s) =>
    typeof s === "string" ? s.replace(/[(),;"'\\%_]/g, "").trim().slice(0, 100) : "";

const emptyPlayersResponse = (res) =>
    res.json({ success: true, players: [], total_count: 0, counts: { total: 0, verified: 0, pending: 0, rejected: 0 } });

// GET /api/admin/players
export const listPlayersForRole = async (req, res) => {
    if (isSuperAdmin(req)) return listPlayers(req, res);
    try {
        const eventIds = Array.from(await getManageableEventIds(req.user.id));
        if (eventIds.length === 0) return emptyPlayersResponse(res);

        const { page, limit, search, status } = req.query;
        const safe = search ? sanitizeSearch(search) : null;
        const searchExpr = safe
            ? `first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,email.ilike.%${safe}%,mobile.ilike.%${safe}%,player_id.ilike.%${safe}%,city.ilike.%${safe}%`
            : null;
        const statusExpr = {
            verified: "verification.eq.verified",
            rejected: "verification.in.(rejected,failed)",
            pending: "verification.is.null,verification.not.in.(verified,rejected,failed)",
        }[status] || null;

        // Players with at least one registration in an assigned event. The inner
        // join keeps each player once however many registrations they have.
        const inMyEvents = (columns, options) =>
            supabaseAdmin
                .from("users")
                .select(`${columns}, event_registrations!inner(event_id)`, options)
                .eq("role", "player")
                .in("event_registrations.event_id", eventIds);
        const scoped = (options) => {
            let q = inMyEvents("id", options);
            if (searchExpr) q = q.or(searchExpr);
            return q;
        };

        let query = statusExpr
            ? inMyEvents("*", { count: "exact" })
                .or(searchExpr ? `and(or(${searchExpr}),or(${statusExpr}))` : statusExpr)
            : (() => {
                let q = inMyEvents("*", { count: "exact" });
                if (searchExpr) q = q.or(searchExpr);
                return q;
            })();
        query = query.order("created_at", { ascending: false });

        if (page && limit) {
            const from = (parseInt(page, 10) - 1) * parseInt(limit, 10);
            query = query.range(from, from + parseInt(limit, 10) - 1);
        }

        const [rowsRes, verifiedRes, rejectedRes, totalRes] = await Promise.all([
            query,
            scoped({ count: "exact", head: true }).eq("verification", "verified"),
            scoped({ count: "exact", head: true }).in("verification", ["rejected", "failed"]),
            statusExpr ? scoped({ count: "exact", head: true }) : null,
        ]);
        if (rowsRes.error) throw rowsRes.error;
        if (totalRes?.error) throw totalRes.error;

        const rowCount = rowsRes.count ?? 0;
        const total = totalRes ? totalRes.count ?? 0 : rowCount;
        const verified = verifiedRes.error ? null : verifiedRes.count ?? 0;
        const rejected = rejectedRes.error ? null : rejectedRes.count ?? 0;
        const pending = verified === null || rejected === null ? null : Math.max(total - verified - rejected, 0);

        res.json({
            success: true,
            players: (rowsRes.data || []).map(({ event_registrations, ...player }) => withoutPassword(player)),
            total_count: rowCount,
            counts: { total, verified, pending, rejected },
        });
    } catch (err) {
        console.error("ASSIGNED EVENTS PLAYERS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch players" });
    }
};

// GET /api/admin/players/:id
export const getPlayerDetailsForRole = async (req, res) => {
    if (isSuperAdmin(req)) return getPlayerDetails(req, res);
    try {
        const eventIds = new Set(Array.from(await getManageableEventIds(req.user.id)));
        const { data: shared, error } = await supabaseAdmin
            .from("event_registrations")
            .select("id")
            .eq("player_id", req.params.id)
            .in("event_id", Array.from(eventIds))
            .limit(1);
        if (error) throw error;
        if (eventIds.size === 0 || (shared || []).length === 0) {
            return res.status(404).json({ success: false, message: "Player not found" });
        }

        // Run the normal handler, but show only the registrations in this
        // admin's events — the player's other events are not theirs to see.
        const json = res.json.bind(res);
        res.json = (body) => {
            if (body?.player?.eventsParticipated) {
                body.player.eventsParticipated = body.player.eventsParticipated
                    .filter((reg) => eventIds.has(String(reg.eventId)));
            }
            return json(body);
        };
        return getPlayerDetails(req, res);
    } catch (err) {
        console.error("ASSIGNED EVENTS PLAYER DETAIL ERROR:", err);
        res.status(500).json({ message: "Failed to fetch player details" });
    }
};

// GET /api/admin/analytics
export const getAnalyticsDashboardForRole = async (req, res) => {
    if (isSuperAdmin(req)) return getAnalyticsDashboard(req, res);

    // Capture the full report, then keep only the assigned events' funnel.
    const json = res.json.bind(res);
    try {
        const eventIds = new Set(Array.from(await getManageableEventIds(req.user.id)));
        res.json = (body) => {
            if (!body?.success || !body.site) return json(body);
            const zero = { page_views: 0, clicks: 0, visitors: 0, sessions: 0, known_users: 0 };
            return json({
                success: true,
                range: body.range,
                days: body.days,
                scope: "events",
                site: {
                    totals: zero,
                    previous: zero,
                    timeseries: [],
                    top_pages: [],
                    top_events: (body.site.top_events || []).filter((row) => eventIds.has(String(row.event_id))),
                    clicks: [],
                    referrers: [],
                    devices: [],
                },
                google: { configured: false, reason: "Not available for admins." },
            });
        };
        return getAnalyticsDashboard(req, res);
    } catch (err) {
        console.error("ASSIGNED EVENTS ANALYTICS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to load analytics" });
    }
};
