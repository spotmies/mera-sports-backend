import crypto from "crypto";
import Razorpay from "razorpay";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { createNotification } from "../services/notificationService.js";
import { resolveEventIdByIdentifier } from "../utils/eventResolver.js";
import { sendRegistrationEmail } from "../utils/mailer.js";
import { uploadBase64 } from "../utils/uploadHelper.js";

const getRazorpayInstance = () => new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * Batch-resolve team member UUIDs and notify them of event registration.
 * Uses a single prefetch query instead of sequential per-member lookups,
 * and Promise.allSettled for safe parallel notification delivery.
 */
async function notifyTeamMembersOfRegistration(teamId, eventId) {
    try {
        // Fetch team and event data in parallel
        const [teamResult, eventResult] = await Promise.all([
            supabaseAdmin.from('player_teams').select('team_name, captain_name, members').eq('id', teamId).maybeSingle(),
            supabaseAdmin.from('events').select('name').eq('id', eventId).maybeSingle()
        ]);

        const team = teamResult.data;
        const event = eventResult.data;
        if (!team || !Array.isArray(team.members) || team.members.length === 0) return;

        const eventName = event?.name || 'an event';
        const captainName = team.captain_name || 'Your captain';

        // Batch-resolve all member UUIDs in a single query
        const playerIds = [];
        const mobiles = [];
        const knownIds = [];
        for (const m of team.members) {
            if (m.id) knownIds.push(m.id);
            if (m.player_id) playerIds.push(m.player_id.toUpperCase());
            if (m.mobile) mobiles.push(m.mobile);
        }

        const orFilters = [];
        if (knownIds.length > 0) orFilters.push(`id.in.(${knownIds.join(',')})`);
        if (playerIds.length > 0) orFilters.push(`player_id.in.(${playerIds.join(',')})`);
        if (mobiles.length > 0) orFilters.push(`mobile.in.(${mobiles.join(',')})`);

        if (orFilters.length === 0) return;

        const { data: users, error } = await supabaseAdmin
            .from('users')
            .select('id, player_id, mobile')
            .or(orFilters.join(','));

        if (error || !users) {
            console.error('Batch user lookup for team notification error:', error);
            return;
        }

        // Build lookup maps
        const byId = new Map(users.map(u => [u.id, u.id]));
        const byPlayerId = new Map(users.filter(u => u.player_id).map(u => [u.player_id.toUpperCase(), u.id]));
        const byMobile = new Map(users.filter(u => u.mobile).map(u => [u.mobile, u.id]));

        // Send all notifications in parallel with safe error handling
        const promises = team.members.map(member => {
            const userId = (member.id && byId.get(member.id))
                || (member.player_id && byPlayerId.get(member.player_id.toUpperCase()))
                || (member.mobile && byMobile.get(member.mobile))
                || null;
            if (!userId) return Promise.resolve();
            return createNotification(
                userId,
                'Team Event Registration',
                `${captainName} registered your team "${team.team_name}" for "${eventName}".`,
                'info'
            );
        });

        const results = await Promise.allSettled(promises);
        results.forEach((r, i) => {
            if (r.status === 'rejected') {
                console.error(`Team reg notification ${i} failed:`, r.reason);
            }
        });
    } catch (e) {
        console.error('notifyTeamMembersOfRegistration error:', e);
    }
}

// POST /api/payment/create-razorpay-order
export const createRazorpayOrder = async (req, res) => {
    try {
        const { eventId, amount } = req.body;
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });
        if (!eventId || !amount) return res.status(400).json({ message: "Missing fields" });
        if (req.user.role === "admin") return res.status(403).json({ message: "Admins cannot register." });

        const resolvedEventId = await resolveEventIdByIdentifier(eventId);
        if (!resolvedEventId) return res.status(404).json({ message: "Event not found" });

        const razorpay = getRazorpayInstance();
        const order = await razorpay.orders.create({
            amount: Math.round(amount * 100), // paise
            currency: "INR",
            receipt: `rec_${Date.now()}`,
            notes: {
                // Stored so webhook fallback can create registration if frontend callback fails
                userId,
                eventId: resolvedEventId,
            },
        });

        res.json({
            success: true,
            order_id: order.id,
            amount: order.amount,
            currency: order.currency,
            key_id: process.env.RAZORPAY_KEY_ID,
        });
    } catch (err) {
        console.error("Razorpay Order Error:", err);
        res.status(500).json({ message: "Failed to create payment order" });
    }
};

// POST /api/payment/verify-razorpay-payment
export const verifyRazorpayPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, eventId, amount, categories, teamId } = req.body;
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !eventId || !amount || !categories) {
            return res.status(400).json({ message: "Missing fields" });
        }

        // Verify signature
        const expectedSignature = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest("hex");

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ success: false, message: "Payment signature verification failed" });
        }

        const resolvedEventId = await resolveEventIdByIdentifier(eventId);
        if (!resolvedEventId) return res.status(404).json({ message: "Event not found" });

        // Create verified transaction
        const { data: transaction, error: txError } = await supabaseAdmin.from("transactions").insert({
            order_id: razorpay_order_id,
            payment_id: razorpay_payment_id,
            payment_mode: "razorpay",
            amount,
            currency: "INR",
            user_id: userId,
        }).select().maybeSingle();

        if (txError || !transaction) throw txError || new Error("Tx Insert Failed");

        // Create registration — immediately verified since payment is confirmed
        const registrationNo = `REG-${Date.now()}`;
        const { error: regError } = await supabaseAdmin.from("event_registrations").insert({
            event_id: resolvedEventId,
            player_id: userId,
            registration_no: registrationNo,
            categories,
            amount_paid: amount,
            transaction_id: transaction.id,
            team_id: teamId || null,
            status: "verified",
        });

        if (regError) {
            await supabaseAdmin.from("transactions").delete().eq("id", transaction.id);
            throw regError;
        }

        // Email (async, non-blocking)
        (async () => {
            try {
                const { data: user } = await supabaseAdmin.from("users").select("email, first_name").eq("id", userId).single();
                const { data: event } = await supabaseAdmin.from("events").select("name").eq("id", resolvedEventId).single();
                if (user?.email) {
                    await sendRegistrationEmail(user.email, {
                        playerName: user.first_name, eventName: event?.name, registrationNo, amount, category: categories, date: new Date(), status: "Confirmed"
                    });
                }
            } catch (e) { console.error("Email Error:", e); }
        })();

        if (teamId) {
            notifyTeamMembersOfRegistration(teamId, resolvedEventId).catch(e =>
                console.error("Team registration notification error:", e)
            );
        }

        res.json({ success: true, message: "Payment verified", registrationNo });
    } catch (err) {
        console.error("Razorpay Verify Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
};

// POST /api/payment/webhook  (raw body — mounted before express.json in server.js)
export const razorpayWebhook = async (req, res) => {
    try {
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        if (!webhookSecret) {
            console.error("RAZORPAY_WEBHOOK_SECRET is not set");
            return res.status(500).json({ error: "Webhook secret not configured" });
        }

        // req.body is a Buffer because we used express.raw()
        const rawBody = req.body;
        const receivedSignature = req.headers["x-razorpay-signature"];

        const expectedSignature = crypto
            .createHmac("sha256", webhookSecret)
            .update(rawBody) // raw Buffer — NOT JSON.stringify
            .digest("hex");

        if (expectedSignature !== receivedSignature) {
            console.error("Webhook signature mismatch");
            return res.status(400).json({ error: "Invalid webhook signature" });
        }

        // Parse body now that signature is verified
        const payload = JSON.parse(rawBody.toString());
        const event = payload.event;
        const paymentEntity = payload.payload?.payment?.entity;

        if (event === "payment.captured") {
            const orderId = paymentEntity?.order_id;
            const paymentId = paymentEntity?.id;
            const amountPaise = paymentEntity?.amount; // in paise
            const notes = paymentEntity?.notes || {};

            // Idempotency check — skip if already processed by frontend callback
            const { data: existing } = await supabaseAdmin
                .from("transactions")
                .select("id")
                .eq("order_id", orderId)
                .maybeSingle();

            if (!existing && notes.userId && notes.eventId) {
                // Frontend callback never fired — create registration as fallback
                const amount = amountPaise / 100;
                const categories = notes.categories ? JSON.parse(notes.categories) : [];

                const { data: transaction } = await supabaseAdmin.from("transactions").insert({
                    order_id: orderId,
                    payment_id: paymentId,
                    payment_mode: "razorpay",
                    amount,
                    currency: "INR",
                    user_id: notes.userId,
                }).select().maybeSingle();

                if (transaction) {
                    const registrationNo = `REG-${Date.now()}`;
                    await supabaseAdmin.from("event_registrations").insert({
                        event_id: notes.eventId,
                        player_id: notes.userId,
                        registration_no: registrationNo,
                        categories,
                        amount_paid: amount,
                        transaction_id: transaction.id,
                        status: "verified",
                    });
                    console.log("Webhook fallback: registration created", registrationNo);
                }
            }
        }

        if (event === "payment.failed") {
            console.log("Payment failed:", paymentEntity?.id, "for order:", paymentEntity?.order_id);
            // Optionally create a notification for the player
        }

        // Always respond 200 quickly — Razorpay retries for up to 24h if you don't
        res.json({ received: true });
    } catch (err) {
        console.error("Webhook Error:", err);
        // Still return 200 to stop Razorpay retrying a broken payload
        res.json({ received: true });
    }
};

// POST /api/payment/submit-manual-payment
export const submitManualPayment = async (req, res) => {
    try {
        const { eventId, amount, categories, transactionId, screenshot, teamId, document } = req.body;
        const userId = req.user?.id;

        if (!userId) return res.status(401).json({ message: "Unauthorized" });
        if (!eventId || !amount || !categories || !screenshot) return res.status(400).json({ message: "Missing fields" });
        if (req.user.role === "admin") return res.status(403).json({ message: "Admins cannot register." });

        const resolvedEventId = await resolveEventIdByIdentifier(eventId);
        if (!resolvedEventId) return res.status(404).json({ message: "Event not found" });

        const screenshotUrl = await uploadBase64(screenshot, "event-assets", "payment-proofs");
        if (!screenshotUrl) return res.status(500).json({ message: "Failed to upload screenshot" });

        const documentUrl = await uploadBase64(document, "event-documents", "user-docs");

        // 1. Create Transaction
        const { data: transaction, error: txError } = await supabaseAdmin.from("transactions").insert({
            order_id: `MANUAL_${Date.now()}`,
            manual_transaction_id: transactionId || null,
            payment_mode: "manual",
            screenshot_url: screenshotUrl,
            amount,
            currency: "INR",
            user_id: userId,
        }).select().maybeSingle();

        if (txError || !transaction) throw txError || new Error("Tx Insert Failed");

        // 2. Create Registration
        const registrationNo = `REG-${Date.now()}`;
        const { error: regError } = await supabaseAdmin.from("event_registrations").insert({
            event_id: resolvedEventId,
            player_id: userId,
            registration_no: registrationNo,
            categories,
            amount_paid: amount,
            transaction_id: transaction.id,
            screenshot_url: screenshotUrl,
            manual_transaction_id: transactionId || null,
            team_id: teamId || null,
            document_url: documentUrl,
            status: 'pending_verification'
        });

        if (regError) {
            await supabaseAdmin.from("transactions").delete().eq("id", transaction.id);
            throw regError;
        }

        // 3. Email (Async)
        (async () => {
            try {
                const { data: user } = await supabaseAdmin.from("users").select("email, first_name").eq("id", userId).single();
                const { data: event } = await supabaseAdmin.from("events").select("name").eq("id", resolvedEventId).single();
                if (user?.email) {
                    await sendRegistrationEmail(user.email, {
                        playerName: user.first_name, eventName: event?.name, registrationNo, amount, category: categories, date: new Date(), status: 'Pending Verification'
                    });
                }
            } catch (e) { console.error("Email Error:", e); }
        })();

        // 4. Notify team members about event registration (Async, non-blocking)
        if (teamId) {
            notifyTeamMembersOfRegistration(teamId, resolvedEventId).catch(e =>
                console.error('Team registration notification error:', e)
            );
        }

        res.json({ success: true, message: "Payment submitted", transactionId: transaction.id, registrationNo });

    } catch (err) {
        console.error("Manual Payment Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
};
