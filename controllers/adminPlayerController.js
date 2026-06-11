import { supabaseAdmin } from "../config/supabaseClient.js";

// GET /api/admin/players
export const listPlayers = async (req, res) => {
    try {
        const { page, limit, search } = req.query;
        let query = supabaseAdmin.from("users").select("*", { count: 'exact' }).eq("role", "player").order('created_at', { ascending: false });

        if (search) {
            query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,mobile.ilike.%${search}%,player_id.ilike.%${search}%`);
        }

        if (page && limit) {
            const pageNum = parseInt(page, 10);
            const limitNum = parseInt(limit, 10);
            const from = (pageNum - 1) * limitNum;
            const to = from + limitNum - 1;
            query = query.range(from, to);
        }

        const { data: players, count, error } = await query;
        if (error) throw error;
        res.json({ success: true, players, total_count: count });
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
