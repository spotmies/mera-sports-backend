import { supabaseAdmin } from "../config/supabaseClient.js";
import {
    refreshBroadcastCounts,
    resolveAudience,
    runBroadcast,
} from "../services/broadcastService.js";
import { uploadBase64 } from "../utils/uploadHelper.js";
import {
    BROADCAST_MESSAGE_MAX,
    BROADCAST_TITLE_MAX,
    BROADCAST_TEMPLATES,
    isWhatsAppEnabled,
} from "../utils/whatsapp.js";

/**
 * GET /api/admin/broadcast/audience
 *
 * The recipient table on the broadcast page is rendered from this, and
 * `POST /broadcast` re-runs the same resolver — so what the admin sees is
 * exactly what gets messaged. Phone numbers are never accepted from the
 * browser; the client sends only the audience description and, for a manual
 * pick, the recipient keys it saw here.
 *
 * Query: ?type=all|event&eventId=&categoryId=&includeTeamMembers=true|false
 */
export const getBroadcastAudience = async (req, res) => {
    try {
        const { type = "all", eventId, categoryId, includeTeamMembers } = req.query;

        if (!["all", "event"].includes(type)) {
            return res.status(400).json({ success: false, message: `Unknown audience type "${type}"` });
        }
        if (type === "event" && !eventId) {
            return res.status(400).json({ success: false, message: "eventId is required for event audiences" });
        }

        const { recipients, categories, eventName } = await resolveAudience({
            type,
            eventId,
            categoryId,
            includeTeamMembers: includeTeamMembers !== "false",
        });

        res.json({
            success: true,
            recipients,
            categories,
            eventName,
            counts: {
                total: recipients.length,
                reachable: recipients.filter((r) => r.valid).length,
                unreachable: recipients.filter((r) => !r.valid).length,
                teamMembers: recipients.filter((r) => r.source === "team_member").length,
            },
            whatsapp: {
                enabled: isWhatsAppEnabled(),
                templates: BROADCAST_TEMPLATES,
            },
        });
    } catch (err) {
        console.error("BROADCAST AUDIENCE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to resolve broadcast audience" });
    }
};

/**
 * POST /api/admin/broadcast
 *
 * Accepts the broadcast, writes the full recipient list, and returns 202 —
 * delivery then runs detached. A few hundred WhatsApp sends take minutes, which
 * no HTTP client will wait through, and a request that times out mid-send used
 * to leave the admin with no idea how far it got.
 *
 * Body: {
 *   title, message, image?,
 *   audience: { type, eventId?, categoryId?, includeTeamMembers?, keys?: string[] },
 *   channels?: ['whatsapp','in_app']
 * }
 */
export const sendBroadcast = async (req, res) => {
    try {
        const { title, message, image, audience = {}, channels } = req.body;

        if (!title?.trim() || !message?.trim()) {
            return res.status(400).json({ success: false, message: "Title and message are required." });
        }
        if (title.length > BROADCAST_TITLE_MAX) {
            return res.status(400).json({ success: false, message: `Title must be ${BROADCAST_TITLE_MAX} characters or fewer.` });
        }
        if (message.length > BROADCAST_MESSAGE_MAX) {
            return res.status(400).json({ success: false, message: `Message must be ${BROADCAST_MESSAGE_MAX} characters or fewer.` });
        }

        const wantedChannels = Array.isArray(channels) && channels.length ? channels : ["whatsapp", "in_app"];
        if (wantedChannels.includes("whatsapp") && !isWhatsAppEnabled()) {
            return res.status(503).json({
                success: false,
                message: "WhatsApp is not configured on this server. Set WHATSAPP_PHONE_ID and WHATSAPP_TOKEN.",
            });
        }

        const { type = "all", eventId, categoryId, includeTeamMembers = true, keys } = audience;
        const { recipients: resolved, eventName } = await resolveAudience({
            type,
            eventId,
            categoryId,
            includeTeamMembers,
        });

        // A manual selection narrows the resolved audience; it can never widen it
        // or introduce a number that was not already in scope for this admin.
        const selected = Array.isArray(keys) && keys.length
            ? resolved.filter((r) => keys.includes(r.key))
            : resolved;

        if (selected.length === 0) {
            return res.status(400).json({ success: false, message: "No recipients matched this audience." });
        }

        // The admin JWT carries only { id, role }, so the sender's name for the
        // history screen has to be looked up rather than read off the token.
        let createdByName = null;
        if (req.user?.id) {
            const { data: admin } = await supabaseAdmin
                .from("users")
                .select("first_name, last_name, email")
                .eq("id", req.user.id)
                .maybeSingle();
            if (admin) {
                createdByName = `${admin.first_name || ""} ${admin.last_name || ""}`.trim() || admin.email || null;
            }
        }

        let imageUrl = null;
        if (image && typeof image === "string" && image.startsWith("data:")) {
            imageUrl = await uploadBase64(image, "admin-assets", "broadcasts");
            if (!imageUrl) {
                return res.status(400).json({ success: false, message: "Attached image could not be uploaded." });
            }
        }

        const { data: broadcast, error: insertError } = await supabaseAdmin
            .from("broadcast_logs")
            .insert({
                title: title.trim(),
                message: message.trim(),
                recipient_type: type,
                status: "queued",
                channels: wantedChannels,
                template_name: imageUrl ? BROADCAST_TEMPLATES.image : BROADCAST_TEMPLATES.text,
                event_id: type === "event" && eventId ? Number(eventId) : null,
                category: categoryId && categoryId !== "all" ? categoryId : null,
                created_by: req.user?.id || null,
                created_by_name: createdByName,
                target_count: selected.length,
                success_count: 0,
                failure_count: 0,
                image_url: imageUrl,
                meta: {
                    event_name: eventName,
                    include_team_members: Boolean(includeTeamMembers),
                    manual_selection: Array.isArray(keys) && keys.length > 0,
                },
            })
            .select()
            .single();

        if (insertError) throw insertError;

        const rows = selected.map((r) => ({
            broadcast_id: broadcast.id,
            // Team-mates pulled from player_teams.members often have no user row,
            // so this is null for roughly half of them by design.
            user_id: r.userId || null,
            name: r.name,
            mobile: r.mobile,
            source: r.source,
            team_name: r.teamName,
            status: "pending",
        }));

        // Chunked because a single insert of a few thousand rows is a request
        // body PostgREST will reject outright.
        for (let i = 0; i < rows.length; i += 500) {
            const { error: rowError } = await supabaseAdmin
                .from("broadcast_recipients")
                .insert(rows.slice(i, i + 500));
            if (rowError) throw rowError;
        }

        // Detached on purpose — see runBroadcast's note. Failures inside it are
        // recorded on the broadcast row, which is what the history screen reads.
        runBroadcast(broadcast.id).catch((err) => {
            console.error(`Broadcast ${broadcast.id} crashed:`, err);
        });

        res.status(202).json({
            success: true,
            broadcastId: broadcast.id,
            message: `Broadcast queued for ${selected.length} recipients.`,
            stats: {
                total: selected.length,
                reachable: selected.filter((r) => r.valid).length,
                unreachable: selected.filter((r) => !r.valid).length,
            },
        });
    } catch (err) {
        console.error("BROADCAST ERROR:", err);
        res.status(500).json({ success: false, message: "Internal Server Error processing broadcast." });
    }
};

/** GET /api/admin/broadcasts — history list, newest first. */
export const listBroadcasts = async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const from = (page - 1) * limit;

        const { data, count, error } = await supabaseAdmin
            .from("broadcast_logs")
            .select("*", { count: "exact" })
            .order("created_at", { ascending: false })
            .range(from, from + limit - 1);

        if (error) throw error;
        res.json({ success: true, broadcasts: data || [], total_count: count });
    } catch (err) {
        console.error("BROADCAST HISTORY ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to load broadcast history" });
    }
};

/** GET /api/admin/broadcasts/:id — one broadcast plus its recipients. */
export const getBroadcastDetail = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.query;

        const { data: broadcast, error } = await supabaseAdmin
            .from("broadcast_logs")
            .select("*")
            .eq("id", id)
            .maybeSingle();

        if (error) throw error;
        if (!broadcast) return res.status(404).json({ success: false, message: "Broadcast not found" });

        let query = supabaseAdmin
            .from("broadcast_recipients")
            .select("id, user_id, name, mobile, source, team_name, status, error, attempts, sent_at, updated_at")
            .eq("broadcast_id", id)
            .order("status", { ascending: true })
            .order("name", { ascending: true });

        if (status && status !== "all") query = query.eq("status", status);

        const { data: recipients, error: recipientError } = await query;
        if (recipientError) throw recipientError;

        const all = recipients || [];
        const countOf = (...statuses) => all.filter((r) => statuses.includes(r.status)).length;

        res.json({
            success: true,
            broadcast,
            recipients: all,
            summary: {
                total: all.length,
                pending: countOf("pending"),
                sent: countOf("sent"),
                delivered: countOf("delivered"),
                read: countOf("read"),
                failed: countOf("failed"),
                skipped: countOf("skipped"),
            },
        });
    } catch (err) {
        console.error("BROADCAST DETAIL ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to load broadcast" });
    }
};

/**
 * POST /api/admin/broadcasts/:id/retry
 *
 * Re-sends only the rows that failed. 'skipped' rows are left alone — their
 * number is unusable, so retrying just fails again.
 */
export const retryBroadcast = async (req, res) => {
    try {
        const { id } = req.params;

        const { data: broadcast, error } = await supabaseAdmin
            .from("broadcast_logs")
            .select("id, status")
            .eq("id", id)
            .maybeSingle();

        if (error) throw error;
        if (!broadcast) return res.status(404).json({ success: false, message: "Broadcast not found" });
        if (broadcast.status === "sending") {
            return res.status(409).json({ success: false, message: "This broadcast is still sending." });
        }

        const { data: failed, error: countError } = await supabaseAdmin
            .from("broadcast_recipients")
            .select("id")
            .eq("broadcast_id", id)
            .eq("status", "failed");

        if (countError) throw countError;
        if (!failed?.length) {
            return res.status(400).json({ success: false, message: "Nothing to retry — no failed recipients." });
        }

        runBroadcast(id, { retryOnly: true }).catch((err) => {
            console.error(`Broadcast retry ${id} crashed:`, err);
        });

        res.status(202).json({ success: true, message: `Retrying ${failed.length} failed recipients.` });
    } catch (err) {
        console.error("BROADCAST RETRY ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to retry broadcast" });
    }
};

/** POST /api/admin/broadcasts/:id/refresh — recompute counters from recipient rows. */
export const refreshBroadcast = async (req, res) => {
    try {
        await refreshBroadcastCounts(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error("BROADCAST REFRESH ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to refresh broadcast" });
    }
};
