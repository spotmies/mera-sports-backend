import { supabaseAdmin } from "../config/supabaseClient.js";
import { refreshBroadcastCounts } from "../services/broadcastService.js";

/**
 * ============================================================
 * WHATSAPP STATUS WEBHOOK (Meta Cloud API)
 * ============================================================
 * Meta reports delivery asynchronously: the send call only tells you the
 * message was *accepted*. sent → delivered → read (or failed, e.g. the number
 * has no WhatsApp account) arrives here afterwards, keyed by the message id
 * returned at send time and nothing else — which is why broadcast_recipients
 * stores `wa_message_id`.
 *
 * Setup (Meta App → WhatsApp → Configuration → Webhooks):
 *   Callback URL:  https://<backend>/api/whatsapp/webhook
 *   Verify token:  WHATSAPP_WEBHOOK_VERIFY_TOKEN (any string; must match)
 *   Subscribe to the `messages` field.
 */

// Meta only ever moves a message forward. Without this ordering a 'delivered'
// callback that arrives after 'read' (they are not ordered in transit) would
// walk the status backwards in the UI.
const STATUS_RANK = { pending: 0, skipped: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

/** GET /api/whatsapp/webhook — Meta's one-time subscription handshake. */
export const verifyWhatsAppWebhook = (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    if (!expected) {
        console.error("WhatsApp webhook: WHATSAPP_WEBHOOK_VERIFY_TOKEN is not set — cannot verify subscription");
        return res.sendStatus(500);
    }

    if (mode === "subscribe" && token === expected) {
        console.log("✅ WhatsApp webhook verified");
        return res.status(200).send(challenge);
    }

    console.warn("WhatsApp webhook verification failed (token mismatch)");
    return res.sendStatus(403);
};

/**
 * POST /api/whatsapp/webhook — delivery status callbacks.
 *
 * Answers 200 immediately and processes afterwards: Meta retries with backoff
 * on any non-200 and will disable the subscription if it keeps failing, so a
 * slow database write must never hold up the response.
 */
export const handleWhatsAppWebhook = (req, res) => {
    res.sendStatus(200);

    const statuses = (req.body?.entry || [])
        .flatMap((entry) => entry.changes || [])
        .flatMap((change) => change.value?.statuses || []);

    if (!statuses.length) return;

    processStatuses(statuses).catch((err) => {
        console.error("WhatsApp webhook processing failed:", err.message);
    });
};

const processStatuses = async (statuses) => {
    const touchedBroadcasts = new Set();

    for (const status of statuses) {
        const messageId = status.id;
        const newStatus = status.status; // sent | delivered | read | failed
        if (!messageId || !STATUS_RANK[newStatus]) continue;

        const { data: recipient, error } = await supabaseAdmin
            .from("broadcast_recipients")
            .select("id, broadcast_id, status")
            .eq("wa_message_id", messageId)
            .maybeSingle();

        // Registration confirmations, OTPs and receipts go through the same
        // number, so most callbacks belong to messages this table never tracked.
        if (error || !recipient) continue;

        if (STATUS_RANK[newStatus] <= STATUS_RANK[recipient.status]) continue;

        const patch = { status: newStatus, updated_at: new Date().toISOString() };
        if (newStatus === "failed") {
            const detail = status.errors?.[0];
            patch.error = detail ? `${detail.code} ${detail.title || detail.message || ""}`.trim() : "Delivery failed";
        }

        const { error: updateError } = await supabaseAdmin
            .from("broadcast_recipients")
            .update(patch)
            .eq("id", recipient.id);

        if (updateError) {
            console.error("WhatsApp webhook: failed to update recipient:", updateError.message);
            continue;
        }

        touchedBroadcasts.add(recipient.broadcast_id);
    }

    for (const broadcastId of touchedBroadcasts) {
        await refreshBroadcastCounts(broadcastId);
    }
};
