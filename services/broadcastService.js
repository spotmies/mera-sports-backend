import { supabaseAdmin } from "../config/supabaseClient.js";
import { createNotification } from "./notificationService.js";
import { getSignedFileUrl } from "../utils/railwayStorage.js";
import {
    BROADCAST_TEMPLATES,
    isWhatsAppEnabled,
    normalizeWhatsAppNumber,
    sendBroadcastWhatsApp,
} from "../utils/whatsapp.js";

/**
 * ============================================================
 * BROADCASTS — audience resolution + throttled WhatsApp delivery
 * ============================================================
 *
 * Two responsibilities, deliberately in one module:
 *
 *  1. `resolveAudience` is the SINGLE definition of who a broadcast reaches.
 *     The admin UI renders the recipient table from it (via the preview
 *     endpoint) and the sender re-runs it at send time. Previously the browser
 *     built the list itself and posted names+numbers, which meant the list on
 *     screen and the list actually messaged could disagree — and did: the page
 *     kept only each player's FIRST category, so filtering an event by any
 *     other category silently dropped players who had registered for it.
 *
 *  2. `runBroadcast` walks that audience, sends, and records the outcome per
 *     recipient so the history screen can answer "who missed this?".
 */

/* ================= AUDIENCE ================= */

// A person may appear many times in one event (one registration per category)
// and may be both a captain and another team's member. The normalized WhatsApp
// number is the identity that matters, because that is what receives the
// message — deduping on user id alone would still double-message a team-mate
// who has no user row.
const recipientKey = (mobile, userId) => normalizeWhatsAppNumber(mobile) || (userId ? `u:${userId}` : null);

const fullName = (first, last) => `${first || ""} ${last || ""}`.trim() || "Player";

/** Event categories are `{id, category, gender, matchType}`; registration
 *  categories are `{id, name, gender, matchType}`. Same ids, different key for
 *  the label — hence the `category || name` dance. */
const categoryLabel = (cat) => {
    if (!cat || typeof cat !== "object") return String(cat || "").trim() || "General";
    const base = String(cat.category || cat.name || "General").trim();

    // Some events store the gender and match type inside the category name
    // already ("Elite (Male) - Team 24"), so appending them unconditionally
    // produced labels like "Elite (Male) - Team 24 (Male) - Team".
    const alreadyMentions = (value) =>
        value && base.toLowerCase().includes(String(value).toLowerCase());

    const bits = [base];
    if (cat.gender && !alreadyMentions(cat.gender)) bits.push(`(${cat.gender})`);
    if (cat.matchType && !alreadyMentions(cat.matchType)) bits.push(`- ${cat.matchType}`);
    return bits.join(" ");
};

const asArray = (value) => {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
            return [value];
        }
    }
    if (typeof value === "object") return [value];
    return [];
};

/**
 * The category list an admin picks from, straight off the event.
 * Keyed by category id, so "U-17 Male" and "U-17 Female" stay distinct — by
 * name alone they collapse into one entry that matches both.
 */
export const eventCategoryOptions = (event) =>
    asArray(event?.categories)
        .filter((cat) => cat && typeof cat === "object" && cat.id)
        .map((cat) => ({ id: String(cat.id), label: categoryLabel(cat) }));

/**
 * Resolve everyone a broadcast should reach.
 *
 * @param {object} spec
 * @param {'all'|'event'} spec.type
 * @param {string|number} [spec.eventId]  - required when type is 'event'
 * @param {string} [spec.categoryId]      - optional category filter within the event
 * @param {boolean} [spec.includeTeamMembers=true]
 * @returns {Promise<{recipients: Array, categories: Array, eventName: string|null}>}
 */
export const resolveAudience = async ({ type, eventId, categoryId, includeTeamMembers = true }) => {
    if (type === "all") {
        const { data, error } = await supabaseAdmin
            .from("users")
            // `avatar` is the real column — the old broadcast page asked for
            // `profile_picture_url`, which does not exist on users, so every
            // avatar there silently fell back to initials.
            .select("id, first_name, last_name, mobile, email, avatar")
            .eq("role", "player")
            .order("created_at", { ascending: false });
        if (error) throw error;

        const seen = new Set();
        const recipients = [];
        for (const user of data || []) {
            const key = recipientKey(user.mobile, user.id);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            recipients.push({
                key,
                userId: user.id,
                name: fullName(user.first_name, user.last_name),
                mobile: user.mobile || null,
                email: user.email || null,
                avatar: user.avatar || null,
                source: "player",
                teamName: null,
                categories: [],
                valid: Boolean(normalizeWhatsAppNumber(user.mobile)),
            });
        }
        return { recipients, categories: [], eventName: null };
    }

    if (type !== "event") throw new Error(`Unknown audience type "${type}"`);
    if (!eventId) return { recipients: [], categories: [], eventName: null };

    const { data: registrations, error } = await supabaseAdmin
        .from("event_registrations")
        .select(`
            id, event_id, team_id, status, categories,
            events ( id, name, categories ),
            users:player_id ( id, first_name, last_name, mobile, email, avatar ),
            player_teams ( id, team_name, members )
        `)
        .eq("event_id", eventId)
        .order("created_at", { ascending: false });
    if (error) throw error;

    const rows = registrations || [];
    const event = rows.find((r) => r.events)?.events || null;

    // The master list comes from the event, not from the registrations, so a
    // category nobody has signed up for yet is still offered as a filter.
    const categories = eventCategoryOptions(event);
    const knownCategoryIds = new Set(categories.map((c) => c.id));

    const byKey = new Map();

    const addRecipient = ({ userId, name, mobile, email, avatar, source, teamName }, regCategories) => {
        const key = recipientKey(mobile, userId);
        if (!key) return null;

        let recipient = byKey.get(key);
        if (!recipient) {
            recipient = {
                key,
                userId: userId || null,
                name,
                mobile: mobile || null,
                email: email || null,
                avatar: avatar || null,
                source,
                teamName: teamName || null,
                // EVERY category this person registered for, not just the first.
                categories: [],
                categoryIds: [],
                valid: Boolean(normalizeWhatsAppNumber(mobile)),
            };
            byKey.set(key, recipient);
        }
        // A captain who also appears as someone's team-mate stays a 'player':
        // the stronger relationship wins so the table does not mislabel them.
        if (recipient.source === "team_member" && source === "player") {
            recipient.source = "player";
            recipient.teamName = teamName || recipient.teamName;
            if (userId) recipient.userId = userId;
        }

        for (const cat of regCategories) {
            if (!recipient.categoryIds.includes(cat.id)) {
                recipient.categoryIds.push(cat.id);
                recipient.categories.push(cat.label);
            }
        }
        return recipient;
    };

    for (const reg of rows) {
        const regCategories = asArray(reg.categories)
            .filter(Boolean)
            .map((cat) => ({
                // Registrations carry the event category's id, so filtering by id
                // works even when two categories share a display name. The 11 rows
                // in QA whose id no longer exists on the event fall back to the
                // label, so they are still listed rather than silently dropped.
                id: cat && typeof cat === "object" && cat.id ? String(cat.id) : categoryLabel(cat),
                label: categoryLabel(cat),
            }));

        if (reg.users) {
            addRecipient({
                userId: reg.users.id,
                name: fullName(reg.users.first_name, reg.users.last_name),
                mobile: reg.users.mobile,
                email: reg.users.email,
                avatar: reg.users.avatar,
                source: "player",
                teamName: reg.player_teams?.team_name || null,
            }, regCategories);
        }

        // Team registrations name only the captain in player_id; the rest of the
        // squad lives in player_teams.members, and roughly half of them have no
        // user row at all — their number exists nowhere else. Skipping this block
        // is why team events reached only their captains.
        if (includeTeamMembers && reg.player_teams?.members) {
            for (const member of asArray(reg.player_teams.members)) {
                if (!member || typeof member !== "object") continue;
                addRecipient({
                    userId: member.id || null,
                    name: member.name || "Team member",
                    mobile: member.mobile,
                    email: null,
                    avatar: null,
                    source: "team_member",
                    teamName: reg.player_teams.team_name || null,
                }, regCategories);
            }
        }
    }

    let recipients = Array.from(byKey.values());

    if (categoryId && categoryId !== "all") {
        recipients = recipients.filter((r) => r.categoryIds.includes(categoryId));
    }

    // Categories a registration referenced that the event no longer lists, so the
    // filter dropdown can still reach those players.
    const orphanCategories = new Map();
    for (const recipient of Array.from(byKey.values())) {
        recipient.categoryIds.forEach((id, index) => {
            if (!knownCategoryIds.has(id) && !orphanCategories.has(id)) {
                orphanCategories.set(id, { id, label: recipient.categories[index] });
            }
        });
    }

    return {
        recipients,
        categories: [...categories, ...orphanCategories.values()],
        eventName: event?.name || null,
    };
};

/* ================= DELIVERY ================= */

// Meta's Cloud API allows ~80 messages/second on a healthy number, but the
// binding constraint is the phone number's 24-hour messaging tier, not raw
// throughput. Sending slower than the ceiling keeps a large broadcast from
// tripping rate limiting (error 130429) and starving OTP delivery, which shares
// the same number and is the one message players actually wait on.
const SEND_CONCURRENCY = Number(process.env.BROADCAST_CONCURRENCY || 5);
const SEND_DELAY_MS = Number(process.env.BROADCAST_DELAY_MS || 250);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Signed URL for the attached image.
 *
 * The DB stores the stable `/api/files/<bucket>/<path>` URL so the admin UI can
 * keep showing the image, but that route answers with a 302 and Meta's media
 * fetcher does not reliably follow redirects — the same trap that made receipt
 * PDFs fail. Meta downloads the image during the send call, so a short-lived
 * signed URL minted per broadcast is enough.
 */
const signedImageUrl = async (publicUrl) => {
    if (!publicUrl) return null;
    const match = publicUrl.match(/\/api\/files\/(.+)$/);
    if (!match) return publicUrl; // already a direct URL
    try {
        return await getSignedFileUrl(decodeURIComponent(match[1]), 3600);
    } catch (err) {
        console.error("Broadcast image signing failed:", err.message);
        return null;
    }
};

const markRecipient = async (id, patch) => {
    const { error } = await supabaseAdmin
        .from("broadcast_recipients")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id);
    if (error) console.error("Failed to update broadcast recipient:", error.message);
};

/**
 * Send (or re-send) the pending recipients of a broadcast.
 *
 * Runs detached from the HTTP request that started it: a few hundred sends at
 * ~4/second outlives any sensible request timeout, so the controller answers
 * 202 and this keeps going. Every recipient's outcome is persisted as it
 * happens, so a backend restart mid-broadcast leaves an accurate partial record
 * and the remaining rows can be retried from the history screen.
 *
 * @param {string} broadcastId
 * @param {object} [options]
 * @param {boolean} [options.retryOnly=false] - only rows currently 'failed'
 */
export const runBroadcast = async (broadcastId, { retryOnly = false } = {}) => {
    const { data: broadcast, error: loadError } = await supabaseAdmin
        .from("broadcast_logs")
        .select("*")
        .eq("id", broadcastId)
        .maybeSingle();

    if (loadError || !broadcast) {
        console.error(`Broadcast ${broadcastId} could not be loaded:`, loadError?.message || "not found");
        return;
    }

    const wantsWhatsApp = (broadcast.channels || []).includes("whatsapp");

    if (wantsWhatsApp && !isWhatsAppEnabled()) {
        await supabaseAdmin.from("broadcast_logs").update({
            status: "failed",
            error: "WhatsApp is not configured on this server (WHATSAPP_PHONE_ID / WHATSAPP_TOKEN missing)",
            completed_at: new Date().toISOString(),
        }).eq("id", broadcastId);
        return;
    }

    await supabaseAdmin.from("broadcast_logs").update({
        status: "sending",
        started_at: broadcast.started_at || new Date().toISOString(),
        error: null,
    }).eq("id", broadcastId);

    const { data: pending, error: pendingError } = await supabaseAdmin
        .from("broadcast_recipients")
        .select("id, user_id, name, mobile, status, attempts")
        .eq("broadcast_id", broadcastId)
        .in("status", retryOnly ? ["failed"] : ["pending", "failed"]);

    if (pendingError) {
        console.error("Failed to load broadcast recipients:", pendingError.message);
        await supabaseAdmin.from("broadcast_logs").update({
            status: "failed",
            error: `Could not load recipients: ${pendingError.message}`,
            completed_at: new Date().toISOString(),
        }).eq("id", broadcastId);
        return;
    }

    const queue = pending || [];
    const imageUrl = wantsWhatsApp ? await signedImageUrl(broadcast.image_url) : null;

    // The image template is a different, separately-approved template. If the
    // image cannot be signed, sending the text template instead would drop the
    // attachment silently — better to send nothing and say why.
    if (wantsWhatsApp && broadcast.image_url && !imageUrl) {
        await supabaseAdmin.from("broadcast_logs").update({
            status: "failed",
            error: "Attached image could not be published for WhatsApp delivery",
            completed_at: new Date().toISOString(),
        }).eq("id", broadcastId);
        return;
    }

    const deliverOne = async (recipient) => {
        // In-app notification first: it needs no external service, so a player
        // with an unusable number still hears about the announcement in the app.
        if ((broadcast.channels || []).includes("in_app") && recipient.user_id) {
            await createNotification(recipient.user_id, broadcast.title, broadcast.message, "info", null);
        }

        if (!wantsWhatsApp) {
            // `error: null` matters on a retry — without it a row that has since
            // succeeded keeps displaying the reason it failed the first time.
            await markRecipient(recipient.id, {
                status: "sent",
                error: null,
                sent_at: new Date().toISOString(),
            });
            return "sent";
        }

        if (!normalizeWhatsAppNumber(recipient.mobile)) {
            await markRecipient(recipient.id, {
                status: "skipped",
                error: `Not a valid WhatsApp number: "${recipient.mobile || "none"}"`,
            });
            return "skipped";
        }

        const result = await sendBroadcastWhatsApp(
            recipient.mobile,
            { title: broadcast.title, message: broadcast.message, imageUrl },
            recipient.name
        );

        await markRecipient(recipient.id, {
            status: result.ok ? "sent" : "failed",
            wa_message_id: result.messageId || null,
            error: result.ok ? null : result.error || "Unknown WhatsApp error",
            attempts: (recipient.attempts || 0) + 1,
            sent_at: result.ok ? new Date().toISOString() : null,
        });
        return result.ok ? "sent" : "failed";
    };

    for (let i = 0; i < queue.length; i += SEND_CONCURRENCY) {
        const batch = queue.slice(i, i + SEND_CONCURRENCY);
        await Promise.all(batch.map(async (recipient) => {
            try {
                await deliverOne(recipient);
            } catch (err) {
                console.error(`Broadcast ${broadcastId}: recipient ${recipient.id} threw:`, err.message);
                await markRecipient(recipient.id, {
                    status: "failed",
                    error: err.message,
                    attempts: (recipient.attempts || 0) + 1,
                });
            }
        }));
        if (i + SEND_CONCURRENCY < queue.length) await sleep(SEND_DELAY_MS);
    }

    await refreshBroadcastCounts(broadcastId, { markCompleted: true });
};

/**
 * Recompute a broadcast's counters from its recipient rows.
 *
 * Derived rather than incremented: the status webhook moves rows to
 * delivered/read/failed long after the send loop has exited, so a counter
 * maintained at send time goes stale within seconds.
 */
export const refreshBroadcastCounts = async (broadcastId, { markCompleted = false } = {}) => {
    const { data: rows, error } = await supabaseAdmin
        .from("broadcast_recipients")
        .select("status")
        .eq("broadcast_id", broadcastId);

    if (error) {
        console.error("Failed to refresh broadcast counts:", error.message);
        return;
    }

    const all = rows || [];
    const countOf = (...statuses) => all.filter((r) => statuses.includes(r.status)).length;

    const patch = {
        target_count: all.length,
        success_count: countOf("sent", "delivered", "read"),
        failure_count: countOf("failed", "skipped"),
    };

    if (markCompleted) {
        patch.status = "completed";
        patch.completed_at = new Date().toISOString();
    }

    const { error: updateError } = await supabaseAdmin
        .from("broadcast_logs")
        .update(patch)
        .eq("id", broadcastId);
    if (updateError) console.error("Failed to update broadcast counts:", updateError.message);
};

export const broadcastTemplateNames = BROADCAST_TEMPLATES;
