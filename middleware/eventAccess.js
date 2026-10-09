import { cacheDel, cacheGet, cacheSet } from "../config/redisClient.js";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { resolveEventIdByIdentifier } from "../utils/eventResolver.js";

// --------------------------------------------------------------------------
// "Can this admin manage this event?"
//   A superadmin can manage every event. An admin can manage an event they
//   created, or one they are assigned to (events.assigned_to or a row in
//   event_admin_assignments). Everything event-scoped in the admin API —
//   editing, draws, matches, scores, leagues, heats, news, media, payment
//   verification — goes through this one rule.
// --------------------------------------------------------------------------
const EVENT_ACCESS_TTL_SECONDS = 60;
const accessCacheKey = (adminId, eventId) => `event-access:${adminId}:${eventId}`;

// Call after assignments change or an admin is removed.
export const invalidateEventAccessCache = (adminId = "*", eventId = "*") =>
    cacheDel(accessCacheKey(adminId, eventId));

/** Internal ids (as strings) of every event this admin may manage. */
export const getManageableEventIds = async (adminId) => {
    const [direct, assigned] = await Promise.all([
        supabaseAdmin.from("events").select("id").or(`created_by.eq.${adminId},assigned_to.eq.${adminId}`),
        supabaseAdmin.from("event_admin_assignments").select("event_id").eq("admin_id", adminId),
    ]);
    if (direct.error) throw direct.error;
    if (assigned.error && assigned.error.code !== "42P01") throw assigned.error;

    const ids = new Set();
    (direct.data || []).forEach((row) => row.id != null && ids.add(String(row.id)));
    (assigned.data || []).forEach((row) => row.event_id != null && ids.add(String(row.event_id)));
    return ids;
};

const adminManagesEvent = async (adminId, eventId) => {
    const key = accessCacheKey(adminId, eventId);
    const cached = await cacheGet(key);
    if (cached) return cached.allowed;

    const [{ data: event, error: eventError }, assignment] = await Promise.all([
        supabaseAdmin.from("events").select("created_by, assigned_to").eq("id", eventId).maybeSingle(),
        supabaseAdmin.from("event_admin_assignments").select("event_id").eq("event_id", eventId).eq("admin_id", adminId).limit(1),
    ]);
    if (eventError) throw eventError;
    if (assignment.error && assignment.error.code !== "42P01") throw assignment.error;

    const allowed = !!event && (
        String(event.created_by) === String(adminId) ||
        String(event.assigned_to) === String(adminId) ||
        (assignment.data || []).length > 0
    );
    await cacheSet(key, { allowed }, EVENT_ACCESS_TTL_SECONDS);
    return allowed;
};

/**
 * @param user        req.user (role already re-read from the DB by verifyAdmin)
 * @param identifier  internal id or public id of the event
 * @returns {Promise<{ found: boolean, allowed: boolean, eventId: string|null }>}
 */
export const canManageEvent = async (user, identifier) => {
    const eventId = identifier == null || identifier === "" ? null : await resolveEventIdByIdentifier(identifier);
    if (eventId == null) return { found: false, allowed: user?.role === "superadmin", eventId: null };
    if (user?.role === "superadmin") return { found: true, allowed: true, eventId: String(eventId) };
    return { found: true, allowed: await adminManagesEvent(user.id, String(eventId)), eventId: String(eventId) };
};

// Returned by a lookup when the row it was asked about does not exist.
export const ROW_NOT_FOUND = Symbol("ROW_NOT_FOUND");

const forbidden = (res) =>
    res.status(403).json({ error: "You are not assigned to this event", code: "EVENT_ACCESS_DENIED" });

/**
 * Route guard. `getEventIds(req)` returns the event identifier(s) the request
 * touches — a value, an array, or a promise of either. Use after verifyAdmin.
 *
 * Superadmins always pass. For an admin, every event the request touches must
 * be one they manage; a request that names no event at all is refused, since
 * the handler would otherwise act without a scope.
 */
export const requireEventAccess = (getEventIds) => async (req, res, next) => {
    if (req.user?.role === "superadmin") return next();
    try {
        const raw = await getEventIds(req);
        if (raw === ROW_NOT_FOUND) return res.status(404).json({ error: "Not found" });
        const identifiers = (Array.isArray(raw) ? raw : [raw]).filter((v) => v !== null && v !== undefined && v !== "");
        if (identifiers.length === 0) {
            return res.status(400).json({ error: "An event is required for this request" });
        }
        for (const identifier of new Set(identifiers.map(String))) {
            const { found, allowed } = await canManageEvent(req.user, identifier);
            if (!found) return res.status(404).json({ error: "Event not found" });
            if (!allowed) return forbidden(res);
        }
        return next();
    } catch (err) {
        console.error("EVENT ACCESS CHECK ERROR:", err.message || err);
        return res.status(503).json({ error: "Could not check event access, please retry" });
    }
};

// ── Ways to find the event a request is about ────────────────────────────────
export const fromParam = (name) => (req) => req.params?.[name];
export const fromBody = (...names) => (req) => {
    for (const name of names) {
        if (req.body?.[name] !== undefined && req.body?.[name] !== null && req.body?.[name] !== "") return req.body[name];
    }
    return null;
};
export const fromQuery = (name) => (req) => req.query?.[name];

/** Looks up `event_id` on the row of `table` whose id is in req.params[param]. */
export const fromRow = (table, param = "id") => async (req) => {
    const id = req.params?.[param];
    if (!id) return null;
    const { data, error } = await supabaseAdmin.from(table).select("event_id").eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? data.event_id : ROW_NOT_FOUND;
};
