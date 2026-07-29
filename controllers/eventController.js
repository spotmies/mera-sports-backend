import QRCode from 'qrcode';
import { supabaseAdmin } from "../config/supabaseClient.js";
import { cacheGet, cacheSet, cacheDel } from "../config/redisClient.js";
import { getPublicEventId, resolveEventByIdentifier, resolveEventIdByIdentifier } from "../utils/eventResolver.js";
import { uploadBase64 } from "../utils/uploadHelper.js";

/**
 * Invalidate all event-related caches. Call after any event write so public
 * reads (list + detail) don't serve stale data.
 */
export const invalidateEventCaches = async () => {
    await Promise.all([
        cacheDel("public:events:list"),
        cacheDel("event:detail:*"),
    ]);
};

const sanitizeSearch = (s) =>
    typeof s === 'string' ? s.replace(/[(),;"'\\%_]/g, '').trim().slice(0, 100) : '';

// Supports both numeric (bigint) and UUID event IDs as used throughout the DB.
const normalizeEventId = (id) => {
    if (id === null || id === undefined || String(id).trim() === '') return null;
    const parsed = Number(id);
    return Number.isNaN(parsed) ? id : parsed;
};

const isUuid = (str) => {
    if (!str || typeof str !== 'string') return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
};

const getAssignedEventIdsForAdmin = async (adminId) => {
    if (!adminId) return [];
    try {
        const { data, error } = await supabaseAdmin
            .from('event_admin_assignments')
            .select('event_id')
            .eq('admin_id', adminId);

        if (error) {
            if (error.code === '42P01') return [];
            throw error;
        }

        return (data || []).map((row) => row.event_id).filter((eventId) => eventId !== null && eventId !== undefined);
    } catch (err) {
        console.error('getAssignedEventIdsForAdmin error:', err?.message || err);
        return [];
    }
};

const loadAssignedAdminsForEvent = async (eventId) => {
    const normalizedId = normalizeEventId(eventId);
    if (normalizedId === null) return [];
    try {
        const { data, error } = await supabaseAdmin
            .from('event_admin_assignments')
            .select(`
                admin_id,
                assigned_by,
                created_at,
                users:admin_id ( id, name, email )
            `)
            .eq('event_id', normalizedId)
            .order('created_at', { ascending: true });

        if (error) {
            if (error.code === '42P01') return [];
            throw error;
        }

        return (data || []).map((row) => ({
            id: row.admin_id,
            name: row.users?.name || null,
            email: row.users?.email || null,
            assigned_by: row.assigned_by || null,
            assigned_at: row.created_at || null,
        }));
    } catch (err) {
        console.error('loadAssignedAdminsForEvent error:', err?.message || err);
        return [];
    }
};

const syncEventAdminAssignments = async (eventId, adminIds, assignedBy) => {
    const normalizedEventId = normalizeEventId(eventId);
    const uniqueAdminIds = Array.from(new Set((adminIds || []).filter(Boolean)));

    const { error: deleteError } = await supabaseAdmin
        .from('event_admin_assignments')
        .delete()
        .eq('event_id', normalizedEventId);

    if (deleteError) {
        if (deleteError.code === '42P01') return;
        throw deleteError;
    }

    if (uniqueAdminIds.length === 0) return;

    const rows = uniqueAdminIds.map((adminId) => ({
        event_id: normalizedEventId,
        admin_id: adminId,
        assigned_by: assignedBy || null,
    }));

    const { error: insertError } = await supabaseAdmin
        .from('event_admin_assignments')
        .upsert(rows, { onConflict: 'event_id,admin_id', ignoreDuplicates: true });

    if (insertError) {
        if (insertError.code === '42P01') return;
        throw insertError;
    }
};

// GET /api/events/list
export const listEvents = async (req, res) => {
    try {
        const { created_by, admin_id, page, limit, search } = req.query;
        let query = supabaseAdmin.from('events').select('*, event_registrations(count)', { count: 'exact' }).order('start_date', { ascending: false });

        if (created_by) query = query.eq('created_by', created_by);
        if (admin_id) {
            const multiAssignedEventIds = await getAssignedEventIdsForAdmin(admin_id);
            const orParts = [`created_by.eq.${admin_id}`, `assigned_to.eq.${admin_id}`];

            if (multiAssignedEventIds.length > 0) {
                orParts.push(`id.in.(${multiAssignedEventIds.join(',')})`);
            }

            query = query.or(orParts.join(','));
        }

        if (search) {
            const safe = sanitizeSearch(search);
            if (safe) query = query.ilike('name', `%${safe}%`);
        }

        if (page && limit) {
            const pageNum = parseInt(page, 10);
            const limitNum = parseInt(limit, 10);
            const from = (pageNum - 1) * limitNum;
            const to = from + limitNum - 1;
            query = query.range(from, to);
        }

        const { data, count, error } = await query;
        if (error) throw error;
        const events = (data || []).map((event) => ({
            ...event,
            public_id: getPublicEventId(event),
        }));
        res.json({ success: true, events, total_count: count });
    } catch (err) {
        console.error("Fetch Events Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
};

// GET /api/events/:id
export const getEventDetails = async (req, res) => {
    try {
        const { id } = req.params;

        // Cache-aside: full event detail (incl. counts) cached 60s. Writes call
        // invalidateEventCaches(); registrations also invalidate (see below).
        const cacheKey = `event:detail:${id}`;
        const cachedEvent = await cacheGet(cacheKey);
        if (cachedEvent) return res.json({ success: true, event: cachedEvent });

        const eventData = await resolveEventByIdentifier(id, '*');
        if (!eventData) return res.status(404).json({ success: false, message: "Event not found" });
        eventData.public_id = getPublicEventId(eventData);
        const internalEventId = eventData.id;

        // assigned admins, news and registration stats are independent of each
        // other — fetch them in one parallel batch instead of 3 sequential calls.
        const [assignedAdmins, { data: newsData }, { data: regStats }] = await Promise.all([
            loadAssignedAdminsForEvent(internalEventId),
            supabaseAdmin.from('event_news').select('*').eq('event_id', internalEventId).order('created_at', { ascending: false }),
            supabaseAdmin.from("event_registrations").select("categories, status, team_id, player_id").eq("event_id", internalEventId).in("status", ["verified", "paid", "confirmed", "approved", "registered", "pending", "Pending", "pending_verification", "Submitted"]),
        ]);

        if (assignedAdmins.length > 0) { 
            eventData.assigned_admins = assignedAdmins;
            eventData.assigned_admin_ids = assignedAdmins.map((admin) => admin.id);
            eventData.assigned_user = {
                id: assignedAdmins[0].id,
                name: assignedAdmins[0].name,
                email: assignedAdmins[0].email,
            };
        } else if (eventData.assigned_to) {
            const { data: assignedUser } = await supabaseAdmin.from('users').select('id, name, email').eq('id', eventData.assigned_to).single();
            if (assignedUser) {
                eventData.assigned_user = assignedUser;
                eventData.assigned_admins = [assignedUser];
                eventData.assigned_admin_ids = [assignedUser.id];
            }
        } else {
            eventData.assigned_admins = [];
            eventData.assigned_admin_ids = [];
        }

        eventData.news = newsData || [];

        // Stats — team_id lets team/doubles categories count distinct teams, not
        // individual players. (Singles: team_id null → count rows. Team/Doubles:
        // team_id shared → count distinct team_ids.) regStats fetched in the batch above.
        const registrationCounts = {};
        // Tracks distinct team_ids per category key (for Team/Doubles events)
        const teamIdsPerCategory = {};
        if (regStats) {
            regStats.forEach(reg => {
                const teamId = reg.team_id;
                const processKey = (key) => {
                    if (teamId) {
                        // Team or Doubles registration — count distinct teams/pairs
                        if (!teamIdsPerCategory[key]) teamIdsPerCategory[key] = new Set();
                        teamIdsPerCategory[key].add(teamId);
                    } else {
                        // Individual (Singles) registration — count rows
                        registrationCounts[key] = (registrationCounts[key] || 0) + 1;
                    }
                };
                if (Array.isArray(reg.categories)) {
                    reg.categories.forEach(cat => processKey(typeof cat === 'object' ? (cat.id || cat.name || cat.category) : cat));
                } else if (reg.categories) {
                    processKey(typeof reg.categories === 'object' ? (reg.categories.id || reg.categories.name || reg.categories.category) : reg.categories);
                }
            });
            // Merge distinct team/pair counts into registrationCounts
            Object.entries(teamIdsPerCategory).forEach(([key, teamSet]) => {
                registrationCounts[key] = (registrationCounts[key] || 0) + teamSet.size;
            });
        }
        eventData.registration_counts = registrationCounts;
        // A "registration" is a category entry, not a row: one player entering two
        // categories has registered twice, pays two fees and occupies two slots.
        // regStats.length counted rows, so the headline total contradicted the
        // per-category cards right below it (40 vs the cards' 9+18+5+12+9 = 53).
        // Summing registrationCounts also keeps team/doubles correct — those keys
        // already hold distinct team counts rather than one per member.
        eventData.total_registrations_count = Object.values(registrationCounts)
            .reduce((sum, n) => sum + (Number(n) || 0), 0);
        // Distinct people, for callers that need headcount rather than entries.
        eventData.total_players_count = regStats
            ? new Set(regStats.map(r => r.player_id).filter(Boolean)).size
            : 0;

        await cacheSet(cacheKey, eventData, 60); // 60s TTL
        res.json({ success: true, event: eventData });
    } catch (err) {
        console.error("Fetch Event Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
};

// POST /api/events/create
export const createEvent = async (req, res) => {
    try {
        const {
            name,
            sport,
            start_date,
            banner_image,
            document_file,
            document_url,
            sponsors,
            assigned_admin_ids,
            assigned_to,
            ...rest
        } = req.body;
        if (!name || !sport || !start_date) return res.status(400).json({ message: "Missing required fields" });

        const created_by = req.user.id;
        const normalizedAssignedAdminIds = Array.isArray(assigned_admin_ids)
            ? Array.from(new Set(assigned_admin_ids.filter(isUuid)))
            : (assigned_to && isUuid(assigned_to) ? [assigned_to] : []);
        const primaryAssignedAdminId = normalizedAssignedAdminIds[0] || null;

        const banner_url = await uploadBase64(banner_image, 'event-assets', 'banners');
        // Only upload document if document_file is provided (frontend sends document_file, not document_url)
        const uploadedDocUrl = (document_file && document_file.startsWith('data:'))
            ? await uploadBase64(document_file, 'event-documents', 'docs')
            : (document_url || null);
        const payment_qr_image = await uploadBase64(req.body.payment_qr_image, 'event-assets', 'payment-qrs');

        let processedSponsors = [];
        if (sponsors && Array.isArray(sponsors)) {
            processedSponsors = await Promise.all(sponsors.map(async (sp) => {
                const logoUrl = await uploadBase64(sp.logo, 'event-assets', 'sponsors');
                let mediaItems = [];
                if (sp.mediaItems) {
                    mediaItems = await Promise.all(sp.mediaItems.map(async (media) => ({ ...media, url: await uploadBase64(media.url, 'event-assets', 'sponsor-media') })));
                }
                return { ...sp, logo: logoUrl, mediaItems };
            }));
        }

        const { data, error } = await supabaseAdmin.from('events').insert({
            name, sport, start_date, created_by,
            banner_url, document_url: uploadedDocUrl, payment_qr_image,
            sponsors: processedSponsors,
            status: 'upcoming',
            assigned_to: primaryAssignedAdminId,
            assigned_by: primaryAssignedAdminId ? created_by : null,
            ...rest
        }).select().single();

        if (error) throw error;
        data.public_id = getPublicEventId(data);

        // QR Code
        try {
            const routeEventId = getPublicEventId(data);
            const link = `${process.env.FRONTEND_URL || 'http://localhost:8080'}/events/${routeEventId}`;
            const qrDataUrl = await QRCode.toDataURL(link);
            const qrPublicUrl = await uploadBase64(qrDataUrl, 'event-assets', 'qrcodes');
            await supabaseAdmin.from('events').update({ qr_code: qrPublicUrl }).eq('id', data.id);
            data.qr_code = qrPublicUrl;
        } catch (e) { console.error("QR Gen Failed:", e); }

        // Trigger Notifications for Superadmins if an admin created the event
        if (req.user && req.user.role === 'admin') {
            try {
                // Fetch the admin's name
                let adminName = 'An Admin';
                const { data: adminData } = await supabaseAdmin.from('users').select('name').eq('id', req.user.id).single();
                if (adminData && adminData.name) {
                    adminName = adminData.name;
                }

                // Fetch all active superadmins
                const { data: superadmins, error: fetchError } = await supabaseAdmin
                    .from('users')
                    .select('id')
                    .eq('role', 'superadmin');

                if (!fetchError && superadmins && superadmins.length > 0) {
                    // Format the inserted array based on the table schema
                    const notificationInserts = superadmins.map(sa => ({
                        user_id: sa.id,
                        title: 'New Event by Admin',
                        message: `${adminName} created the event "${data.name}". Please review and assign access.`,
                        type: 'info',
                        link: `/events/${getPublicEventId(data)}`
                    }));

                    // Insert into the public.notifications table
                    const { error: insertError } = await supabaseAdmin
                        .from('notifications')
                        .insert(notificationInserts);

                    if (insertError) {
                        console.error("Failed to insert notifications:", insertError);
                    }
                }
            } catch (notificationErr) {
                console.error("Critical error inside notification trigger logic:", notificationErr);
            }
        }

        await syncEventAdminAssignments(data.id, normalizedAssignedAdminIds, created_by);
        const assignedAdmins = await loadAssignedAdminsForEvent(data.id);
        data.assigned_admins = assignedAdmins;
        data.assigned_admin_ids = assignedAdmins.map((admin) => admin.id);
        if (assignedAdmins.length > 0) {
            data.assigned_user = {
                id: assignedAdmins[0].id,
                name: assignedAdmins[0].name,
                email: assignedAdmins[0].email,
            };
        }

        await invalidateEventCaches();
        res.json({ success: true, event: data });
    } catch (err) {
        console.error("Create Event Logic Error:", err);
        res.status(500).json({ message: err.message });
    }
};

// PUT /api/events/:id
export const updateEvent = async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        let assignedAdminIdsInput;

        if (updates.banner_image) {
            updates.banner_url = await uploadBase64(updates.banner_image, 'event-assets', 'banners');
            delete updates.banner_image;
        }
        if (updates.payment_qr_image?.startsWith('data:')) {
            updates.payment_qr_image = await uploadBase64(updates.payment_qr_image, 'event-assets', 'payment-qrs');
        }
        // Handle document_file upload (only if provided and is base64)
        if (updates.document_file !== undefined) {
            if (updates.document_file && updates.document_file.startsWith('data:')) {
                // Upload new document
                updates.document_url = await uploadBase64(updates.document_file, 'event-documents', 'docs');
            } else if (updates.document_file === null) {
                // Explicitly remove document
                updates.document_url = null;
            }
            // Always remove document_file from updates as it's not a DB column
            delete updates.document_file;
        }

        if (updates.sponsors && Array.isArray(updates.sponsors)) {
            updates.sponsors = await Promise.all(updates.sponsors.map(async (sp) => {
                const logo = await uploadBase64(sp.logo, 'event-assets', 'sponsors');
                const mediaItems = sp.mediaItems ? await Promise.all(sp.mediaItems.map(async m => ({ ...m, url: await uploadBase64(m.url, 'event-assets', 'sponsor-media') }))) : [];
                return { ...sp, logo, mediaItems };
            }));
        }

        ['start_date', 'end_date', 'registration_deadline'].forEach(f => { if (updates[f] === "") updates[f] = null; });
        delete updates.id; delete updates.created_at; delete updates.created_by;

        if (updates.hasOwnProperty('assigned_admin_ids')) {
            assignedAdminIdsInput = Array.isArray(updates.assigned_admin_ids)
                ? Array.from(new Set(updates.assigned_admin_ids.filter(isUuid)))
                : [];
            updates.assigned_to = assignedAdminIdsInput[0] || null;
            delete updates.assigned_admin_ids;
        } else if (updates.hasOwnProperty('assigned_to')) {
            assignedAdminIdsInput = updates.assigned_to && isUuid(updates.assigned_to)
                ? [updates.assigned_to]
                : [];
        }

        // Track who assigned the event
        if ((updates.hasOwnProperty('assigned_to') || assignedAdminIdsInput !== undefined) && req.user && req.user.id) {
            updates.assigned_by = req.user.id;
        }

        // document_file is already handled above (uploaded and converted to document_url, then deleted)
        delete updates.data; // Also remove potential junk

        const { data, error } = await supabaseAdmin.from('events').update(updates).eq('id', id).select().single();
        if (error) throw error;
        data.public_id = getPublicEventId(data);

        if (assignedAdminIdsInput !== undefined) {
            await syncEventAdminAssignments(id, assignedAdminIdsInput, req.user?.id);
        }

        const assignedAdmins = await loadAssignedAdminsForEvent(id);
        data.assigned_admins = assignedAdmins;
        data.assigned_admin_ids = assignedAdmins.map((admin) => admin.id);
        if (assignedAdmins.length > 0) {
            data.assigned_user = {
                id: assignedAdmins[0].id,
                name: assignedAdmins[0].name,
                email: assignedAdmins[0].email,
            };
        }

        await invalidateEventCaches();
        res.json({ success: true, event: data });
    } catch (err) {
        console.error("Update Event Error:", err);
        res.status(500).json({ message: err.message });
    }
};

// DELETE /api/events/:id
export const deleteEvent = async (req, res) => {
    try {
        const { id } = req.params;
        await supabaseAdmin.from('event_registrations').delete().eq('event_id', id);
        await supabaseAdmin.from('event_news').delete().eq('event_id', id);
        await supabaseAdmin.from('event_brackets').delete().eq('event_id', id);
        const { error } = await supabaseAdmin.from('events').delete().eq('id', id);
        if (error) throw error;
        await invalidateEventCaches();
        res.json({ success: true, message: "Event deleted" });
    } catch (err) {
        console.error("Delete Event Error:", err);
        res.status(500).json({ message: err.message });
    }
};

// GET /api/events/:id/brackets
export const getEventBrackets = async (req, res) => {
    try {
        const eventIdQuery = await resolveEventIdByIdentifier(req.params.id);
        if (!eventIdQuery) {
            return res.status(404).json({ success: false, message: "Event not found", brackets: [] });
        }

        const { data, error } = await supabaseAdmin
            .from('event_brackets')
            .select('id, event_id, category, round_name, draw_type, draw_data, pdf_url, created_at, mode, bracket_data, published')
            .eq('event_id', eventIdQuery)
            .neq('round_name', 'LEAGUE_PLACEHOLDER') // Exclude placeholder brackets for league matches
            .order('category', { ascending: true })
            .order('round_name', { ascending: true })
            .order('created_at', { ascending: true });

        if (error) {
            console.error("Supabase error fetching brackets:", error);
            throw error;
        }

        // Filter out placeholder brackets only
        // For now, show all brackets except LEAGUE_PLACEHOLDER
        // Published filtering can be added later if needed, but for now show all to debug
        const visibleBrackets = (data || []).filter(bracket => {
            // Exclude LEAGUE_PLACEHOLDER brackets (already filtered in query, but double-check)
            if (bracket.round_name === 'LEAGUE_PLACEHOLDER') {
                return false;
            }
            // Include all other brackets (we'll filter by published status later if needed)
            return true;
        });

        // Filter by published status:
        // - League/pool-converted brackets (createdFrom === "league" or "pool") are always included
        //   because the admin explicitly initiates conversion for public display.
        // - Media draws require explicit publishing.
        // - Regular brackets: include if published is true or null (backward compat); exclude if explicitly false.
        const publishedBrackets = visibleBrackets.filter(bracket => {
            // League/pool-converted BRACKET mode rows are always visible
            const createdFrom = bracket.bracket_data?.createdFrom || bracket.draw_data?.createdFrom;
            if (bracket.mode === 'BRACKET' && (createdFrom === 'league' || createdFrom === 'pool')) {
                return true;
            }
            // Include if published is true, or if published field doesn't exist (backward compatibility)
            // If explicitly false, exclude it.
            if (bracket.published === false) {
                return false;
            }

            // Validate bracket data integrity: BRACKET mode must have at least one round
            // with matches to be considered valid. This prevents exposing empty/incomplete
            // brackets that were initialized but never populated.
            if (bracket.mode === 'BRACKET') {
                const bd = bracket.bracket_data || bracket.draw_data;
                if (!bd) return false;
                const rounds = bd.rounds;
                if (!Array.isArray(rounds) || rounds.length === 0) return false;
                // At least one round must have at least one match
                const hasMatches = rounds.some(r => Array.isArray(r.matches) && r.matches.length > 0);
                if (!hasMatches) return false;
            }

            return true;
        });

        // Format brackets - return visible brackets (frontend will handle additional filtering for display)
        const formattedBrackets = publishedBrackets.map(bracket => {
            const mode = bracket.mode || null;
            const fullBracketData = bracket.bracket_data || null;

            // Prefer full bracket_data for BRACKET mode; otherwise fall back to legacy draw_data
            let drawType = bracket.draw_type || (mode === "BRACKET" ? "bracket" : "image");
            let drawData = bracket.draw_data || {};

            if (mode === "BRACKET" && fullBracketData) {
                drawType = "bracket";
                drawData = fullBracketData;
            }

            return {
                id: bracket.id,
                event_id: bracket.event_id,
                category: bracket.category || 'Unknown',
                round_name: bracket.round_name || 'Round 1',
                draw_type: drawType,
                draw_data: drawData,
                pdf_url: bracket.pdf_url || null,
                created_at: bracket.created_at,
                mode,
                bracket_data: fullBracketData,
                published: bracket.published // Explicitly return published status (useful for frontend debugging)
            };
        });


        res.json({ success: true, brackets: formattedBrackets });
    } catch (err) {
        console.error("GET EVENT BRACKETS ERROR:", err);
        res.status(500).json({ success: false, message: err.message, brackets: [] });
    }
};

// GET /api/events/:id/sponsors
export const getEventSponsors = async (req, res) => {
    try {
        const event = await resolveEventByIdentifier(req.params.id, 'sponsors');
        if (!event) return res.status(404).json({ success: false, sponsors: [] });
        res.json({ success: true, sponsors: event?.sponsors || [] });
    } catch (err) { res.status(500).json({ message: err.message }); }
};
