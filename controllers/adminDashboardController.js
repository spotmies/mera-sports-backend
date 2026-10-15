import { supabaseAdmin } from "../config/supabaseClient.js";
import { getManageableEventIds } from "../middleware/eventAccess.js";
import { withoutPassword } from "../utils/userSanitize.js";
import { getDashboardStats } from "./adminController.js";

// --------------------------------------------------------------------------
// Dashboard numbers by role
//   A super admin gets the platform-wide dashboard (getDashboardStats).
//   An admin gets figures for the events assigned to them only: payments, and
//   the players registered in those events.
//   The response keeps the same shape so the page needs no special handling.
// --------------------------------------------------------------------------

const distinctPayments = (rows) => new Set((rows || []).map((r) => r.transaction_id || `row:${r.id}`)).size;

const PENDING_STATUSES = ["pending_verification", "pending", "payment_pending", "registered"];
const TREND_DAYS = 30;
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
// Calendar day in India, which is the day an organiser means by "that day".
const istDay = (value) => new Date(new Date(value).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Every registration row of the given events. PostgREST caps a single response, so read page by page. */
const loadRegistrationRows = async (eventIds) => {
    const rows = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabaseAdmin
            .from("event_registrations")
            .select("id, event_id, player_id, status, amount_paid, transaction_id, created_at")
            .in("event_id", eventIds)
            .order("id", { ascending: true })
            .range(from, from + PAGE - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    return rows;
};

/** Page views and Register clicks per event over the trend window. Optional: a failure just leaves them out. */
const loadEventFunnel = async () => {
    try {
        const to = new Date();
        const from = new Date(to.getTime() - TREND_DAYS * 86_400_000);
        const { data, error } = await supabaseAdmin.rpc("analytics_dashboard", { p_from: from.toISOString(), p_to: to.toISOString() });
        if (error) return new Map();
        return new Map((data?.top_events || []).map((row) => [String(row.event_id), row]));
    } catch {
        return new Map();
    }
};

/** Per-event performance and a day-by-day registration trend for the admin's assigned events. */
const buildEventAnalytics = async (eventIds) => {
    const [rows, eventsRes, funnel] = await Promise.all([
        loadRegistrationRows(eventIds),
        supabaseAdmin.from("events").select("id, name, sport, start_date, end_date").in("id", eventIds),
        loadEventFunnel(),
    ]);
    if (eventsRes.error) throw eventsRes.error;

    const paymentKey = (r) => r.transaction_id || `row:${r.id}`;
    const byEvent = new Map(eventIds.map((id) => [String(id), { registrations: new Set(), players: new Set(), pending: new Set(), revenue: 0 }]));
    const dayCounts = new Map();
    const trendFrom = istDay(Date.now() - (TREND_DAYS - 1) * 86_400_000);

    for (const r of rows) {
        const e = byEvent.get(String(r.event_id));
        if (!e || r.status === "rejected") continue;
        e.registrations.add(paymentKey(r));
        if (r.player_id) e.players.add(r.player_id);
        if (PENDING_STATUSES.includes(r.status)) e.pending.add(paymentKey(r));
        if (r.status === "verified") e.revenue += Number(r.amount_paid) || 0;

        const day = istDay(r.created_at);
        if (day >= trendFrom) {
            if (!dayCounts.has(day)) dayCounts.set(day, new Set());
            dayCounts.get(day).add(paymentKey(r));
        }
    }

    const today = istDay(Date.now());
    const eventBreakdown = (eventsRes.data || []).map((ev) => {
        const e = byEvent.get(String(ev.id));
        const f = funnel.get(String(ev.id));
        const start = ev.start_date, end = ev.end_date || ev.start_date;
        return {
            id: ev.id,
            name: ev.name,
            sport: ev.sport,
            start_date: ev.start_date,
            status: !start || start > today ? "upcoming" : end < today ? "completed" : "ongoing",
            registrations: e.registrations.size,
            players: e.players.size,
            pending: e.pending.size,
            revenue: e.revenue,
            views: f ? f.page_views : null,
            register_clicks: f ? f.register_clicks : null,
        };
    }).sort((a, b) => b.registrations - a.registrations);

    const registrationTrend = [];
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
        const day = istDay(Date.now() - i * 86_400_000);
        registrationTrend.push({ day, registrations: dayCounts.get(day)?.size || 0 });
    }
    return { eventBreakdown, registrationTrend };
};

const getAssignedEventsDashboardStats = async (req, res) => {
    try {
        const eventIds = Array.from(await getManageableEventIds(req.user.id));
        const noEvents = eventIds.length === 0;
        const forScope = (query) => query.in("event_id", eventIds);

        const { data: rejectedTransactions } = noEvents ? { data: [] } : await forScope(supabaseAdmin
            .from("event_registrations")
            .select(`*, events(name), users:player_id(first_name, last_name, player_id)`)
            .eq("status", "rejected"))
            .order("created_at", { ascending: false })
            .limit(5);

        const { data: pendingRows } = noEvents ? { data: [] } : await forScope(supabaseAdmin
            .from("event_registrations")
            .select("id, transaction_id")
            .in("status", ["pending_verification", "pending", "payment_pending", "registered"]));

        const { data: approvedTxns } = noEvents ? { data: [] } : await forScope(supabaseAdmin
            .from("event_registrations")
            .select("id, transaction_id, amount_paid")
            .eq("status", "verified"));

        // Players registered in the assigned events (each counted once).
        const playersInMyEvents = (options) => noEvents
            ? Promise.resolve({ count: 0, data: [] })
            : supabaseAdmin
                .from("users")
                .select("*, event_registrations!inner(event_id)", options)
                .eq("role", "player")
                .in("event_registrations.event_id", eventIds);
        const [totalP, verifiedP, pendingP, rejectedP, recentP] = await Promise.all([
            playersInMyEvents({ count: "exact", head: true }),
            playersInMyEvents({ count: "exact", head: true }).eq("verification", "verified"),
            playersInMyEvents({ count: "exact", head: true }).eq("verification", "pending"),
            playersInMyEvents({ count: "exact", head: true }).eq("verification", "rejected"),
            noEvents ? { data: [] } : playersInMyEvents({}).order("created_at", { ascending: false }).limit(6),
        ]);

        const { eventBreakdown, registrationTrend } = noEvents
            ? { eventBreakdown: [], registrationTrend: [] }
            : await buildEventAnalytics(eventIds);

        res.json({
            success: true,
            eventBreakdown,
            registrationTrend,
            stats: {
                totalPlayers: totalP.count || 0,
                verifiedPlayers: verifiedP.count || 0,
                pendingPlayers: pendingP.count || 0,
                rejectedPlayers: rejectedP.count || 0,
                totalRevenue: (approvedTxns || []).reduce((sum, txn) => sum + (Number(txn.amount_paid) || 0), 0),
                totalTransactionsCount: distinctPayments(approvedTxns),
                pendingTransactionsCount: distinctPayments(pendingRows),
            },
            recentPlayers: (recentP.data || []).map(({ event_registrations, ...player }) => withoutPassword(player)),
            rejectedPlayersList: [],
            rejectedTransactions: rejectedTransactions || [],
        });
    } catch (err) {
        console.error("ASSIGNED EVENTS DASHBOARD ERROR:", err);
        res.status(500).json({ message: "Failed to fetch dashboard stats" });
    }
};

// GET /api/admin/dashboard-stats
export const getDashboardStatsForRole = (req, res) =>
    req.user?.role === "superadmin" ? getDashboardStats(req, res) : getAssignedEventsDashboardStats(req, res);
