import { supabaseAdmin } from "../config/supabaseClient.js";
import { cacheDel } from "../config/redisClient.js";
import { createNotification } from "../services/notificationService.js";
import { invalidateDashboardForRegistration } from "../utils/dashboardCache.js";
import { uploadBase64 } from "../utils/uploadHelper.js";
import { sendRegistrationStatusWhatsApp } from "../utils/whatsapp.js";
import { notifyRegistrationApproved } from "../utils/approvalNotifications.js";
import { invalidateMatchesCache } from "../utils/matchesCache.js";
import { getManageableEventIds } from "../middleware/eventAccess.js";
import { tallyRegistrationEntries } from "../utils/registrationRules.js";

// Fire-and-forget WhatsApp status update to the registration's player
const notifyRegistrationStatusWhatsApp = (playerId, eventName, registrationNo, status) => {
    (async () => {
        try {
            const { data: user } = await supabaseAdmin
                .from("users")
                .select("first_name, mobile")
                .eq("id", playerId)
                .maybeSingle();
            if (user?.mobile) {
                await sendRegistrationStatusWhatsApp(user.mobile, {
                    playerName: user.first_name,
                    eventName,
                    registrationNo,
                    status,
                });
            }
        } catch (e) { console.error("Registration status WhatsApp error:", e.message); }
    })();
};

/* ================= CATEGORIES ================= */
export const getAllCategories = async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin.from("events").select("categories");
        if (error) throw error;

        const uniqueCategories = new Set(["All Categories"]);
        data.forEach(event => {
            let cats = event.categories;
            if (typeof cats === 'string') try { if (cats.startsWith('[')) cats = JSON.parse(cats); } catch (e) { }

            const addCat = (cat) => {
                const name = cat.name || cat.category || cat.Category || cat.id;
                if (name) uniqueCategories.add(name);
                else if (typeof cat === 'string') uniqueCategories.add(cat);
            };

            if (Array.isArray(cats)) cats.forEach(addCat);
            else if (typeof cats === 'object' && cats !== null) addCat(cats);
            else if (cats) uniqueCategories.add(String(cats));
        });

        res.json({ success: true, categories: Array.from(uniqueCategories).sort() });
    } catch (err) {
        console.error("Error fetching categories:", err);
        res.status(500).json({ success: false, message: "Server Error" });
    }
};

/**
 * Attach each team member's public player code to the roster rows.
 *
 * `player_teams.members` stores {id, name, mobile}, where `id` is a `users`
 * uuid and the readable code ("P1769") lives on the user row. A roster on its
 * own therefore cannot tell two same-named members apart — which is exactly
 * what the pool scoring screen needs to do, one goal input per member.
 *
 * The codes are looked up once for the whole response and merged in as
 * `player_id`, leaving every existing member field untouched, so readers that
 * know nothing about the new field are unaffected.
 */
const attachMemberPlayerCodes = async (registrations) => {
    const rows = Array.isArray(registrations) ? registrations : [];
    const teamsOf = (reg) => {
        const t = reg?.player_teams;
        if (Array.isArray(t)) return t;
        return t ? [t] : [];
    };

    const memberIds = new Set();
    for (const reg of rows) {
        for (const team of teamsOf(reg)) {
            if (!Array.isArray(team?.members)) continue;
            for (const member of team.members) {
                const id = member && typeof member === "object" ? member.id : null;
                if (id) memberIds.add(String(id));
            }
        }
    }
    if (memberIds.size === 0) return;

    // Chunked: a large event's rosters run to thousands of ids, and PostgREST
    // takes `in` as a query string — one unbounded list would blow the URL limit.
    const ids = Array.from(memberIds);
    const codeById = new Map();
    for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await supabaseAdmin
            .from("users")
            .select("id, player_id")
            .in("id", ids.slice(i, i + 200));
        if (error) {
            // Non-fatal by design: without codes the roster still renders, just
            // without the disambiguator. A lookup failure must not take the
            // whole registrations page down with it.
            console.warn("[getRegistrations] member player_id lookup failed:", error.message);
            return;
        }
        for (const user of data || []) codeById.set(String(user.id), user.player_id);
    }

    for (const reg of rows) {
        for (const team of teamsOf(reg)) {
            if (!Array.isArray(team?.members)) continue;
            team.members = team.members.map((member) => {
                if (!member || typeof member !== "object" || !member.id) return member;
                const code = codeById.get(String(member.id));
                return code ? { ...member, player_id: code } : member;
            });
        }
    }
};

/* ================= REGISTRATIONS & TRANSACTIONS ================= */
/**
 * Which admin's events a list request is limited to. An admin always sees only
 * their own (created or assigned) events — the `admin_id` the browser sends is
 * ignored for them, since trusting it let any admin read anyone's payments.
 * A superadmin sees everything, or one admin's events if they ask for that.
 */
const resolveScopedAdminId = (req) =>
    req.user?.role === 'superadmin' ? (req.query.admin_id || null) : req.user?.id;

const REGISTRATION_LIST_FIELDS = `
                id, event_id, player_id, team_id, registration_no, status, amount_paid, payment_proof:screenshot_url, manual_transaction_id, transaction_id, created_at, categories, document_url,
                events ( id, name, sport, start_date, end_date, start_time, location, venue, categories, status ),
                users:player_id ( id, first_name, last_name, player_id, mobile, email, gender, apartment ),
                player_teams ( id, team_name, captain_name, captain_mobile, members )
            `;

/** Statuses the "Pending" filter covers (same list the admin page always used). */
const PENDING_FILTER_STATUSES = ['pending', 'payment_pending', 'registered', 'pending_verification', 'Submitted'];

const parseRegistrationCategories = (cats) => {
    if (!cats) return [];
    if (typeof cats === "string") {
        try {
            const parsed = JSON.parse(cats);
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
            return [cats];
        }
    }
    return Array.isArray(cats) ? cats : [cats];
};

/** "Adults (Male) - Doubles" — the label the admin page shows and filters by. */
const registrationCategoryLabel = (c) => {
    if (!c) return "Unknown";
    if (typeof c === "string") return c;
    const name = c.name || c.category || c.Category || c.id || "Unknown";
    const genderPart = c.gender ? ` (${c.gender})` : "";
    const type = c.matchType || c.match_type || c.type;
    return `${name}${genderPart}${type ? ` - ${type}` : ""}`;
};

/**
 * The page's filters, applied to one row exactly as the admin page used to
 * apply them in the browser — only now to every row, before paging.
 */
const matchesRegistrationFilters = (reg, { search, category, apartment }) => {
    if (search) {
        const q = search.toLowerCase();
        const playerName = `${reg.users?.first_name} ${reg.users?.last_name}`.toLowerCase();
        const hit = playerName.includes(q)
            || reg.registration_no?.toLowerCase().includes(q)
            || reg.events?.name?.toLowerCase().includes(q)
            || reg.users?.player_id?.toLowerCase().includes(q);
        if (!hit) return false;
    }
    if (category) {
        const hit = parseRegistrationCategories(reg.categories).some((c) => {
            const base = (c && typeof c === "object") ? (c.name || c.category || c.Category || c.id) : String(c);
            return registrationCategoryLabel(c) === category || base === category;
        });
        if (!hit) return false;
    }
    if (apartment) {
        if (!reg.users?.apartment || reg.users.apartment.trim() !== apartment.trim()) return false;
    }
    return true;
};

/** Event scope + the filters the database can apply directly (event, status). */
const applyRegistrationScope = (query, { eventIds, eventId, status }) => {
    if (eventIds) query = query.in('event_id', eventIds);
    if (eventId) query = query.eq('event_id', eventId);
    if (status === 'pending') query = query.in('status', PENDING_FILTER_STATUSES);
    else if (status && status !== 'all') query = query.eq('status', status);
    return query;
};

/**
 * Active vs rejected registrations for the current filters (every filter but
 * status), counted by the shared rule so the list reconciles with the event
 * page: "183 active · 1 rejected" for a list of 184 rows.
 */
const summarizeRegistrations = async ({ eventIds, eventId, search, category, apartment }) => {
    const needsJsFilter = !!(search || category || apartment);
    const fields = needsJsFilter
        ? "id, status, team_id, registration_no, categories, users:player_id ( first_name, last_name, player_id, apartment ), events ( name )"
        : "id, status, team_id, categories";
    const rows = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await applyRegistrationScope(
            supabaseAdmin.from("event_registrations").select(fields).order("id", { ascending: true }),
            { eventIds, eventId, status: null }
        ).range(from, from + 999);
        if (error) throw error;
        for (const r of data || []) {
            if (!needsJsFilter || matchesRegistrationFilters(r, { search, category, apartment })) rows.push(r);
        }
        if (!data || data.length < 1000) break;
    }
    const { active, rejected } = tallyRegistrationEntries(rows);
    return { active, rejected };
};

export const getRegistrations = async (req, res) => {
    try {
        const { eventId, page, limit } = req.query;
        const status = req.query.status || null;
        const search = String(req.query.search || "").trim();
        const category = req.query.category && req.query.category !== "All Categories" ? String(req.query.category) : "";
        const apartment = req.query.apartment && req.query.apartment !== "all" ? String(req.query.apartment) : "";

        let eventIds = null;
        const scopedAdminId = resolveScopedAdminId(req);
        if (scopedAdminId) {
            eventIds = Array.from(await getManageableEventIds(scopedAdminId));
            if (eventIds.length === 0) {
                return res.json({ success: true, registrations: [], total_count: 0 });
            }
        }

        const pageNum = page && limit ? Math.max(parseInt(page, 10) || 1, 1) : null;
        const limitNum = page && limit ? Math.max(parseInt(limit, 10) || 20, 1) : null;

        // Search, category and apartment can't be expressed reliably as
        // PostgREST filters (player names live on users, category labels are
        // built from jsonb that comes in several legacy shapes). So: scan a
        // light projection of every in-scope row, filter it exactly as the page
        // always did, then page the result and load full rows for that page.
        // Before this the page fetched 20 rows and filtered only those, so the
        // filters, the event list and the page count all described one page.
        if (search || category || apartment) {
            const matchedIds = [];
            const CHUNK = 1000;
            for (let from = 0; ; from += CHUNK) {
                const { data: chunk, error: scanErr } = await applyRegistrationScope(
                    supabaseAdmin.from("event_registrations")
                        .select("id, registration_no, categories, users:player_id ( first_name, last_name, player_id, apartment ), events ( name )")
                        .order('created_at', { ascending: false })
                        .order('id', { ascending: true }),
                    { eventIds, eventId, status }
                ).range(from, from + CHUNK - 1);
                if (scanErr) throw scanErr;
                for (const row of chunk || []) {
                    if (matchesRegistrationFilters(row, { search, category, apartment })) matchedIds.push(row.id);
                }
                if (!chunk || chunk.length < CHUNK) break;
            }

            const pageIds = pageNum ? matchedIds.slice((pageNum - 1) * limitNum, pageNum * limitNum) : matchedIds;
            let registrations = [];
            for (let i = 0; i < pageIds.length; i += 200) {
                const { data: rows, error: rowsErr } = await supabaseAdmin
                    .from("event_registrations").select(REGISTRATION_LIST_FIELDS).in("id", pageIds.slice(i, i + 200));
                if (rowsErr) throw rowsErr;
                registrations = registrations.concat(rows || []);
            }
            const order = new Map(pageIds.map((id, i) => [id, i]));
            registrations.sort((a, b) => order.get(a.id) - order.get(b.id));

            await attachMemberPlayerCodes(registrations);
            const summary = await summarizeRegistrations({ eventIds, eventId, search, category, apartment });
            return res.json({ success: true, registrations, total_count: matchedIds.length, summary });
        }

        let query = applyRegistrationScope(
            supabaseAdmin.from("event_registrations")
                .select(REGISTRATION_LIST_FIELDS, { count: 'exact' })
                .order('created_at', { ascending: false })
                .order('id', { ascending: true }),
            { eventIds, eventId, status }
        );

        if (pageNum) {
            const from = (pageNum - 1) * limitNum;
            query = query.range(from, from + limitNum - 1);
        }

        const { data: registrations, count, error } = await query;
        if (error) throw error;
        await attachMemberPlayerCodes(registrations);
        // The summary is for the paged list page only; the event page (no page
        // param) loads every row and does not need it.
        const summary = pageNum ? await summarizeRegistrations({ eventIds, eventId, search, category, apartment }) : undefined;
        res.json({ success: true, registrations, total_count: count, ...(summary ? { summary } : {}) });
    } catch (err) {
        console.error("ADMIN REGISTRATIONS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch registrations" });
    }
};

/**
 * GET /api/admin/registrations/filters
 * Options for the registrations page's Event and Category dropdowns, taken from
 * every event the caller can see — not from whichever 20 rows are on screen,
 * which is why the Event list used to show a single event.
 */
export const getRegistrationFilters = async (req, res) => {
    try {
        let query = supabaseAdmin.from("events")
            .select("id, name, start_date, categories")
            .order('start_date', { ascending: false });
        const scopedAdminId = resolveScopedAdminId(req);
        if (scopedAdminId) {
            const eventIds = Array.from(await getManageableEventIds(scopedAdminId));
            if (eventIds.length === 0) return res.json({ success: true, events: [], categories: [] });
            query = query.in('id', eventIds);
        }
        const { data: events, error } = await query;
        if (error) throw error;

        const labels = new Set();
        for (const ev of events || []) {
            for (const c of Array.isArray(ev.categories) ? ev.categories : []) {
                if (c) labels.add(registrationCategoryLabel(c));
            }
        }
        res.json({
            success: true,
            events: (events || []).map((e) => ({ id: e.id, name: e.name, start_date: e.start_date })),
            categories: [...labels].sort(),
        });
    } catch (err) {
        console.error("ADMIN REGISTRATION FILTERS ERROR:", err);
        res.status(500).json({ message: "Failed to load filters" });
    }
};
const TRANSACTION_ROW_FIELDS = `
                id, event_id, player_id, team_id, registration_no, status, amount_paid, payment_proof:screenshot_url, manual_transaction_id, transaction_id, created_at, categories,
                events ( id, name, created_by, assigned_to ),
                users:player_id ( id, first_name, last_name, player_id, mobile, email, apartment ),
                transactions:transaction_id ( id, payment_mode, payment_id, order_id ),
                player_teams ( id, team_name )
            `;

/**
 * One record per PAYMENT. A payment writes one registration row per
 * Doubles/Team entry plus one for the singles (all sharing a transaction);
 * the Transactions screen is about money, so those rows are shown as one line:
 * summed amount, every category, and an `entries` breakdown (which team was
 * entered in which category, at what fee). `id` stays the first row's id, so
 * verify/reject keep working — the server applies them to the whole payment.
 * Rows without a transaction (legacy) stay one record each.
 */
const groupRowsByPayment = (rows) => {
    const groups = new Map();
    for (const row of rows) {
        const key = row.transaction_id ? `tx:${row.transaction_id}` : `row:${row.id}`;
        if (!groups.has(key)) groups.set(key, []);
        const list = groups.get(key);
        if (!list.some((r) => r.id === row.id)) list.push(row);
    }
    return [...groups.values()].map((list) => {
        const first = list[0];
        const team = (r) => (Array.isArray(r.player_teams) ? r.player_teams[0] : r.player_teams) || null;
        const unsettled = list.find((r) => r.status !== "verified");
        return {
            ...first,
            status: (unsettled || first).status,
            amount_paid: list.reduce((sum, r) => sum + (Number(r.amount_paid) || 0), 0),
            categories: list.flatMap((r) => (Array.isArray(r.categories) ? r.categories : (r.categories ? [r.categories] : []))),
            registration_ids: list.map((r) => r.id),
            entries: list.map((r) => ({
                id: r.id,
                team_id: r.team_id || null,
                team_name: team(r)?.team_name || null,
                categories: r.categories,
                amount_paid: r.amount_paid,
                status: r.status,
            })),
        };
    });
};

export const getTransactions = async (req, res) => {
    try {
        const { eventId, page, limit } = req.query;
        let query = supabaseAdmin.from("event_registrations")
            .select(TRANSACTION_ROW_FIELDS, { count: 'exact' })
            .order('created_at', { ascending: false })
            // Rows of one payment share created_at; ordering by transaction
            // next keeps them adjacent so a page boundary rarely splits one.
            .order('transaction_id', { ascending: true });

        if (eventId) query = query.eq('event_id', eventId);
        const scopedAdminId = resolveScopedAdminId(req);
        if (scopedAdminId) {
            const eventIds = Array.from(await getManageableEventIds(scopedAdminId));
            if (eventIds.length === 0) {
                return res.json({ success: true, transactions: [], total_count: 0 });
            }
            query = query.in('event_id', eventIds);
        }

        if (page && limit) {
            const pageNum = parseInt(page, 10);
            const limitNum = parseInt(limit, 10);
            const from = (pageNum - 1) * limitNum;
            const to = from + limitNum - 1;
            query = query.range(from, to);
        }

        const { data: rows, count, error } = await query;
        if (error) throw error;

        // A page can end part-way through a payment: fetch the rest of each
        // payment on this page so its line shows the full amount/categories.
        let allRows = rows || [];
        if (page && limit) {
            const txIds = [...new Set(allRows.map((r) => r.transaction_id).filter(Boolean))];
            for (let i = 0; i < txIds.length; i += 100) {
                const { data: siblings, error: sibErr } = await supabaseAdmin
                    .from("event_registrations")
                    .select(TRANSACTION_ROW_FIELDS)
                    .in("transaction_id", txIds.slice(i, i + 100));
                if (sibErr) throw sibErr;
                allRows = allRows.concat(siblings || []);
            }
        }

        // `total_count` stays the number of registration ROWS (what pagination
        // and the "any registrations yet?" checks count); `row_count` is how
        // many of those this response covers, for "loaded N of M" notices.
        res.json({
            success: true,
            transactions: groupRowsByPayment(allRows),
            total_count: count,
            row_count: (rows || []).length,
        });
    } catch (err) {
        console.error("ADMIN TRANSACTIONS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch transactions" });
    }
};

/**
 * Every row that belongs to the same payment as the given registration ids.
 *
 * One payment writes one registration row per Doubles/Team entry plus one for
 * the singles, all sharing a transaction. The admin approves or rejects the
 * PAYMENT — one screenshot, one amount — so a status change on any of its rows
 * has to move all of them, or the player's receipt (which merges the rows)
 * would be stuck half-approved.
 */
const expandToPaymentRows = async (ids) => {
    const { data: rows, error } = await supabaseAdmin
        .from("event_registrations").select("id, transaction_id").in("id", ids);
    if (error) throw error;

    const all = new Set((rows || []).map((r) => r.id));
    const txIds = [...new Set((rows || []).map((r) => r.transaction_id).filter(Boolean))];
    for (let i = 0; i < txIds.length; i += 100) {
        const { data: siblings, error: sibErr } = await supabaseAdmin
            .from("event_registrations").select("id").in("transaction_id", txIds.slice(i, i + 100));
        if (sibErr) throw sibErr;
        (siblings || []).forEach((s) => all.add(s.id));
    }
    return [...all];
};

/** Tell a partner / squad that their captain's entry was approved or rejected. */
const notifyTeamOfStatus = async (teamId, eventName, status) => {
    try {
        const { data: team } = await supabaseAdmin
            .from("player_teams").select("team_name, captain_name, members").eq("id", teamId).maybeSingle();
        if (!team || !Array.isArray(team.members)) return;
        const text = status === "verified"
            ? `${team.captain_name || "Your captain"}'s registration of "${team.team_name}" for ${eventName} is confirmed — the entry fee is paid.`
            : `${team.captain_name || "Your captain"}'s registration of "${team.team_name}" for ${eventName} was rejected by the organiser.`;
        await Promise.allSettled(
            team.members
                .filter((m) => m?.id)
                .map((m) => createNotification(
                    m.id,
                    status === "verified" ? "Team Registration Confirmed" : "Team Registration Rejected",
                    text,
                    status === "verified" ? "success" : "error",
                    "/dashboard?tab=events"
                ))
        );
    } catch (e) {
        console.error("Team status notification error:", e.message);
    }
};

/**
 * Set a status on registrations — and on every other row of the same payments —
 * then refresh caches and notify. The payer hears once per payment (not once
 * per row); each partner / squad hears about their own entry.
 */
const applyRegistrationStatus = async (ids, status) => {
    const allIds = await expandToPaymentRows(ids);
    if (allIds.length === 0) return [];

    const { data: updatedRegs, error } = await supabaseAdmin
        .from("event_registrations")
        .update({ status })
        .in("id", allIds)
        .select("id, player_id, team_id, registration_no, transaction_id, events(name)");
    if (error) throw error;
    const rows = updatedRegs || [];

    // Invalidated together, before the notifications go out, so nobody is told
    // their status changed while the app still shows the old one. Covers the
    // payer and every team-mate (their dashboards list the team's entries too).
    await Promise.allSettled(
        rows.map((reg) => invalidateDashboardForRegistration({ userId: reg.player_id, teamId: reg.team_id }))
    );

    const statusLabel = status === "verified" ? "Verified" : "Rejected";
    const notifiedPayments = new Set();
    for (const reg of rows) {
        if (reg.team_id) notifyTeamOfStatus(reg.team_id, reg.events?.name || "the event", status);

        const paymentKey = reg.transaction_id || reg.id;
        if (notifiedPayments.has(paymentKey)) continue;
        notifiedPayments.add(paymentKey);

        createNotification(
            reg.player_id,
            status === "verified" ? "Registration Verified" : "Registration Rejected",
            `Your registration for ${reg.events?.name} (Reg No: ${reg.registration_no}) was ${status}.`,
            status === "verified" ? "success" : "error"
        );
        // Approval is what releases the receipt: email + WhatsApp with the PDF
        // (merged across the payment's rows).
        if (status === "verified") notifyRegistrationApproved(reg.id);
        else notifyRegistrationStatusWhatsApp(reg.player_id, reg.events?.name, reg.registration_no, statusLabel);
    }
    return rows;
};

export const verifyTransaction = async (req, res) => {
    try {
        const rows = await applyRegistrationStatus([req.params.id], "verified");
        res.json({ success: true, message: "Transaction verified", count: rows.length });
    } catch (err) {
        console.error("VERIFY ERROR:", err);
        res.status(500).json({ message: "Verification failed" });
    }
};

export const rejectTransaction = async (req, res) => {
    try {
        const rows = await applyRegistrationStatus([req.params.id], "rejected");
        res.json({ success: true, message: "Transaction rejected", count: rows.length });
    } catch (err) {
        console.error("REJECT ERROR:", err);
        res.status(500).json({ message: "Rejection failed" });
    }
};

export const bulkUpdateTransactions = async (req, res) => {
    try {
        const { ids, status } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: "Invalid IDs" });
        if (!['verified', 'rejected'].includes(status)) return res.status(400).json({ message: "Invalid status" });

        // An admin can only act on registrations of events they manage; the
        // rest of the selection is skipped and reported back, not failed.
        // Rows of the same payment always share an event, so expanding to them
        // afterwards cannot reach outside what was allowed here.
        let allowedIds = ids;
        if (req.user?.role !== 'superadmin') {
            const { data: rows, error: lookupError } = await supabaseAdmin
                .from("event_registrations").select("id, event_id").in("id", ids);
            if (lookupError) throw lookupError;
            const manageable = await getManageableEventIds(req.user.id);
            allowedIds = (rows || []).filter((r) => manageable.has(String(r.event_id))).map((r) => r.id);
        }
        const skipped = ids.length - allowedIds.length;
        if (allowedIds.length === 0) {
            return res.status(403).json({ message: "None of the selected registrations belong to your events", skipped });
        }

        const updated = await applyRegistrationStatus(allowedIds, status);
        res.json({ success: true, message: `Transactions ${status}`, count: updated.length, skipped });
    } catch (err) {
        console.error("BULK UPDATE ERROR:", err);
        res.status(500).json({ message: "Batch update failed" });
    }
};

/* ================= NEWS ================= */
export const getEventNews = async (req, res) => {
    try {
        const { eventId } = req.query;
        if (!eventId) return res.status(400).json({ message: "Event ID required" });
        const { data: news, error } = await supabaseAdmin.from("event_news").select("*").eq("event_id", eventId).order("created_at", { ascending: false });
        if (error) throw error;
        res.json({ success: true, news });
    } catch (err) {
        res.status(500).json({ message: "Failed to fetch news" });
    }
};

/**
 * News attachments arrive as data URIs and must land in object storage — a
 * base64 string written straight into `image_url` bloats every row and every
 * later read of it. `image_url` holds either an image or a PDF; the apps tell
 * them apart by the file extension on the stored URL.
 */
const NEWS_ATTACHMENT_TYPES = /^data:(image\/[a-z0-9.+-]+|application\/pdf);base64,/i;

const storeNewsAttachment = async (imageUrl, fileName) => {
    if (!imageUrl || typeof imageUrl !== 'string') return { url: imageUrl || null };
    if (!imageUrl.startsWith('data:')) return { url: imageUrl }; // already-uploaded URL, keep as is
    if (!NEWS_ATTACHMENT_TYPES.test(imageUrl)) {
        return { error: "Only image or PDF attachments are supported" };
    }
    const uploaded = await uploadBase64(imageUrl, 'event-assets', 'news', fileName);
    if (!uploaded) return { error: "Attachment upload failed" };
    return { url: uploaded };
};

export const createEventNews = async (req, res) => {
    try {
        const { eventId, title, content, imageUrl, fileName, isHighlight } = req.body;

        const attachment = await storeNewsAttachment(imageUrl, fileName);
        if (attachment.error) return res.status(400).json({ success: false, message: attachment.error });

        const { data, error } = await supabaseAdmin.from("event_news")
            .insert({ event_id: eventId, title, content, image_url: attachment.url, is_highlight: isHighlight })
            .select().maybeSingle();
        if (error) throw error;
        await cacheDel("event:detail:*"); // player event page embeds news
        res.json({ success: true, news: data });
    } catch (err) {
        console.error("createEventNews error:", err.message);
        res.status(500).json({ success: false, message: "Failed to create news" });
    }
};

export const updateEventNews = async (req, res) => {
    try {
        const { id } = req.params;
        const { title, content, imageUrl, fileName, isHighlight } = req.body;

        const attachment = await storeNewsAttachment(imageUrl, fileName);
        if (attachment.error) return res.status(400).json({ success: false, message: attachment.error });

        const { data, error } = await supabaseAdmin.from("event_news")
            .update({ title, content, image_url: attachment.url, is_highlight: isHighlight }).eq("id", id).select().maybeSingle();
        if (error) throw error;
        await cacheDel("event:detail:*");
        res.json({ success: true, news: data });
    } catch (err) {
        console.error("updateEventNews error:", err.message);
        res.status(500).json({ success: false, message: "Failed to update news" });
    }
};

export const deleteEventNews = async (req, res) => {
    try {
        const { error } = await supabaseAdmin.from("event_news").delete().eq("id", req.params.id);
        if (error) throw error;
        await cacheDel("event:detail:*");
        res.json({ success: true, message: "News deleted" });
    } catch (err) {
        console.error("deleteEventNews error:", err.message);
        res.status(500).json({ success: false, message: "Failed to delete news" });
    }
};

/* ================= BRACKETS ================= */
export const getBrackets = async (req, res) => {
    try {
        const { eventId } = req.query;
        if (!eventId) return res.status(400).json({ message: "Event ID required" });
        const { data, error } = await supabaseAdmin.from("event_brackets").select("*").eq("event_id", eventId).order("created_at", { ascending: true });
        if (error) throw error;
        res.json({ success: true, brackets: data });
    } catch (err) { res.status(500).json({ message: "Failed to fetch brackets" }); }
};

export const saveBracket = async (req, res) => {
    try {
        const { eventId, category, roundName, drawType, drawData, pdfUrl } = req.body;
        let finalDrawData = drawData;
        let finalPdfUrl = null;

        if (drawType === 'image') {
            // Handle multiple images format (new)
            if (drawData?.images && Array.isArray(drawData.images)) {
                const uploadedImages = [];

                for (const img of drawData.images) {
                    // If image URL is base64, upload it
                    if (img.url?.startsWith('data:')) {
                        const uploadedUrl = await uploadBase64(img.url, 'event-assets', 'draws');
                        if (uploadedUrl) {
                            uploadedImages.push({
                                id: img.id || `img-${Date.now()}-${Math.random()}`,
                                url: uploadedUrl,
                                description: img.description || ""
                            });
                        }
                    } else {
                        // Already uploaded URL, keep as is
                        uploadedImages.push({
                            id: img.id || `img-${Date.now()}-${Math.random()}`,
                            url: img.url,
                            description: img.description || ""
                        });
                    }
                }

                finalDrawData = { images: uploadedImages };
            }
            // Handle old single image format (backward compatibility)
            else if (drawData?.url?.startsWith('data:')) {
                const url = await uploadBase64(drawData.url, 'event-assets', 'draws');
                if (url) {
                    finalDrawData = {
                        images: [{
                            id: `img-${Date.now()}-${Math.random()}`,
                            url: url,
                            description: drawData.description || ""
                        }]
                    };
                }
            }
            // If single URL already uploaded (backward compatibility)
            else if (drawData?.url) {
                finalDrawData = {
                    images: [{
                        id: `img-${Date.now()}-${Math.random()}`,
                        url: drawData.url,
                        description: drawData.description || ""
                    }]
                };
            }
        }

        // Handle PDF upload
        if (pdfUrl !== undefined) {
            if (pdfUrl === null) {
                // Clear PDF URL
                finalPdfUrl = null;
            } else if (pdfUrl.startsWith('data:')) {
                // Upload PDF from base64
                finalPdfUrl = await uploadBase64(pdfUrl, 'event-assets', 'draws');
            } else {
                // Already a URL, keep as is
                finalPdfUrl = pdfUrl;
            }
        }

        const { data: existing } = await supabaseAdmin.from("event_brackets").select("id, draw_type, draw_data").eq("event_id", eventId).eq("category", category).eq("round_name", roundName).maybeSingle();

        let result;

        if (existing) {
            // Update existing bracket - preserve existing draw_data when only updating pdf_url
            const updateData = {};

            // Always preserve existing draw_data first
            updateData.draw_data = existing.draw_data || {};

            // Only update draw_type if provided
            if (drawType) {
                updateData.draw_type = drawType;
            }

            // Only update draw_data if new data is provided and different from existing
            if (finalDrawData && Object.keys(finalDrawData).length > 0) {
                // Check if we're actually updating draw_data (not just pdf_url)
                const hasNewImages = finalDrawData.images && Array.isArray(finalDrawData.images) && finalDrawData.images.length > 0;
                const hasNewMatches = finalDrawData.matches && Array.isArray(finalDrawData.matches) && finalDrawData.matches.length > 0;
                const hasExistingImages = existing.draw_data?.images && Array.isArray(existing.draw_data.images) && existing.draw_data.images.length > 0;
                const hasExistingMatches = existing.draw_data?.matches && Array.isArray(existing.draw_data.matches) && existing.draw_data.matches.length > 0;

                // If we have new images or matches, update draw_data
                if (hasNewImages) {
                    const existingImages = existing.draw_data?.images || [];
                    const existingUrls = new Set(existingImages.map(img => typeof img === 'string' ? img : (img.url || img)));
                    const newImages = finalDrawData.images.filter(img => {
                        const imgUrl = typeof img === 'string' ? img : (img.url || img);
                        return !existingUrls.has(imgUrl);
                    });
                    updateData.draw_data = {
                        ...(existing.draw_data || {}),
                        images: [...existingImages, ...newImages]
                    };
                } else if (hasNewMatches) {
                    // For bracket type, replace matches
                    updateData.draw_data = {
                        ...(existing.draw_data || {}),
                        matches: finalDrawData.matches
                    };
                }
                // If no new images/matches, keep existing draw_data (already set above)
            }

            // Only update pdf_url if it's explicitly provided
            if (pdfUrl !== undefined) {
                updateData.pdf_url = finalPdfUrl;
            }

            const { data, error } = await supabaseAdmin.from("event_brackets").update(updateData).eq("id", existing.id).select().maybeSingle();
            if (error) throw error;
            result = data;
        } else {
            // Insert new bracket
            const insertData = {
                event_id: eventId,
                category,
                round_name: roundName,
                draw_type: drawType || 'image',
                draw_data: finalDrawData || { images: [] }
            };
            if (pdfUrl !== undefined) {
                insertData.pdf_url = finalPdfUrl;
            }
            const { data, error } = await supabaseAdmin.from("event_brackets").insert(insertData).select().maybeSingle();
            if (error) throw error;
            result = data;
        }
        res.json({ success: true, bracket: result });
    } catch (err) {
        console.error("SAVE BRACKET ERROR:", err);
        res.status(500).json({ message: "Failed to save bracket" });
    }
};

export const deleteBracket = async (req, res) => {
    try {
        const bracketId = req.params.id;
        if (!bracketId) {
            return res.status(400).json({ success: false, message: "Bracket id is required" });
        }

        // Fetch bracket to know event/category for match cleanup
        const { data: bracket, error: fetchError } = await supabaseAdmin
            .from("event_brackets")
            .select("id,event_id,category_id,category")
            .eq("id", bracketId)
            .maybeSingle();

        if (fetchError) throw fetchError;
        if (!bracket) {
            return res.status(404).json({ success: false, message: "Bracket not found" });
        }

        const { event_id: eventId, category_id: categoryId, category } = bracket;

        // Best-effort: delete all matches for this event+category from scoreboard
        try {
            let matchQuery = supabaseAdmin
                .from("matches")
                .delete()
                .eq("event_id", eventId)
                .select("id");

            if (categoryId) {
                matchQuery = matchQuery.eq("category_id", categoryId);
            } else if (category) {
                matchQuery = matchQuery.eq("category_id", category);
            }

            const { error: deleteMatchesError } = await matchQuery;
            if (deleteMatchesError) {
                console.error("Failed to delete matches when deleting bracket:", deleteMatchesError);
            }
        } catch (matchErr) {
            console.error("Error while deleting matches for bracket:", matchErr);
        }

        const { error: deleteBracketError } = await supabaseAdmin
            .from("event_brackets")
            .delete()
            .eq("id", bracketId);

        if (deleteBracketError) throw deleteBracketError;
        await invalidateMatchesCache(eventId);
        res.json({ success: true, message: "Bracket and related matches deleted" });
    } catch (err) {
        console.error("DELETE BRACKET ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to delete bracket" });
    }
};