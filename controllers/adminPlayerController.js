import { supabaseAdmin } from "../config/supabaseClient.js";

// Strip PostgREST filter-injection chars and SQL LIKE wildcards (% matches all rows, _ matches any char)
const sanitizeSearch = (s) =>
    typeof s === 'string' ? s.replace(/[(),;"'\\%_]/g, '').trim().slice(0, 100) : '';

// GET /api/admin/players
export const listPlayers = async (req, res) => {
    try {
        const { page, limit, search } = req.query;

        const safe = search ? sanitizeSearch(search) : null;
        const searchExpr = safe
            ? `first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,email.ilike.%${safe}%,mobile.ilike.%${safe}%,player_id.ilike.%${safe}%`
            : null;

        /**
         * One definition of "the players we are talking about", reused by the row
         * query and by every count. The search narrows all of them; only the row
         * query is paginated. That is what lets the header tiles describe the
         * whole result set while the table shows one page of it — previously the
         * tiles counted the loaded page, so "Verified" meant "verified among
         * these twelve".
         */
        const scoped = (options) => {
            let q = supabaseAdmin.from("users").select("*", options).eq("role", "player");
            if (searchExpr) q = q.or(searchExpr);
            return q;
        };

        let query = scoped({ count: "exact" }).order("created_at", { ascending: false });

        if (page && limit) {
            const pageNum = parseInt(page, 10);
            const limitNum = parseInt(limit, 10);
            const from = (pageNum - 1) * limitNum;
            const to = from + limitNum - 1;
            query = query.range(from, to);
        }

        // head: true asks PostgREST for the count alone — the matching rows are
        // never serialised or sent, so these stay cheap as the table grows.
        const [rowsRes, verifiedRes, rejectedRes] = await Promise.all([
            query,
            scoped({ count: "exact", head: true }).eq("verification", "verified"),
            scoped({ count: "exact", head: true }).in("verification", ["rejected", "failed"]),
        ]);

        if (rowsRes.error) throw rowsRes.error;

        const total = rowsRes.count ?? 0;

        // A failed count must not be reported as zero — that would read as "no
        // verified players" rather than "we could not tell". Fall back to null
        // and let the client show a dash.
        const verified = verifiedRes.error ? null : verifiedRes.count ?? 0;
        const rejected = rejectedRes.error ? null : rejectedRes.count ?? 0;
        if (verifiedRes.error) console.warn("Player verified count failed:", verifiedRes.error.message);
        if (rejectedRes.error) console.warn("Player rejected count failed:", rejectedRes.error.message);

        // Pending is the remainder rather than its own query. `verification` is
        // null on older rows, and "null OR pending" would need a second `or`
        // clause stacked on the search one. Deriving it also guarantees the
        // three tiles add up to the total, which two independent counts taken a
        // moment apart would not.
        const pending =
            verified === null || rejected === null
                ? null
                : Math.max(total - verified - rejected, 0);

        res.json({
            success: true,
            players: rowsRes.data,
            total_count: total,
            counts: { total, verified, pending, rejected },
        });
    } catch (err) {
        console.error("ADMIN PLAYERS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch players" });
    }
};

// GET /api/admin/players/:id
export const getPlayerDetails = async (req, res) => {
    try {
        const { id } = req.params;

        const { data: player, error } = await supabaseAdmin.from("users").select("*").eq("id", id).maybeSingle();
        if (error) throw error;
        if (!player) return res.status(404).json({ success: false, message: "Player not found" });

        const { data: schoolDetails } = await supabaseAdmin.from("player_school_details").select("*").eq("player_id", id).maybeSingle();
        if (schoolDetails) {
            player.school = {
                name: schoolDetails.school_name,
                address: schoolDetails.school_address,
                city: schoolDetails.school_city,
                pincode: schoolDetails.school_pincode
            };
        }

        const { data: registrations } = await supabaseAdmin
            .from("event_registrations")
            .select(`*, events(id, name, sport, start_date, start_time, location, venue, categories)`)
            .eq("player_id", id)
            .order("created_at", { ascending: false });

        player.eventsParticipated = registrations ? registrations.map(reg => ({
            eventId: reg.events?.id,
            eventName: reg.events?.name,
            sport: reg.events?.sport,
            categories: reg.events?.category ? [reg.events.category] : [],
            registrationId: reg.registration_no,
            paymentStatus: reg.status === 'verified' ? 'paid' : (reg.status === 'rejected' ? 'failed' : 'pending'),
            playerStatus: reg.status,
            eventDate: reg.events?.start_date,
            eventTime: reg.events?.start_time || "N/A",
            eventLocation: reg.events?.location || "Unknown",
            eventVenue: reg.events?.venue || "Unknown",
            eventStatus: 'upcoming',
            amountPaid: reg.amount_paid
        })) : [];

        res.json({ success: true, player });
    } catch (err) {
        console.error("ADMIN PLAYER DETAIL ERROR:", err);
        res.status(500).json({ message: "Failed to fetch player details" });
    }
};
