import crypto from "crypto";
import Razorpay from "razorpay";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { createNotification } from "../services/notificationService.js";
import { resolveEventByIdentifier, resolveEventIdByIdentifier } from "../utils/eventResolver.js";
import { sendRegistrationEmail } from "../utils/mailer.js";
import { publishReceiptPdf } from "../utils/receiptDelivery.js";
import { sendRegistrationReceiptWhatsApp } from "../utils/whatsapp.js";
import { uploadBase64 } from "../utils/uploadHelper.js";

// ── Server-side fee computation ──────────────────────────────────────────────
// The fee shown in the player app is derived from events.categories (jsonb).
// It is recomputed here from the same data so the charged amount can never be
// tampered with from the browser. Mirrors EventRegistration.tsx fee logic.
const TEAM_MATCH_TYPES = ["doubles", "mixed doubles", "team"];
const DEFAULT_CATEGORY_FEE = 500; // player-app fallback when a category has no fee
const MAX_TEAM_MEMBERS = 100;

const normalizeEventCategories = (event) => {
    const raw = Array.isArray(event?.categories) ? event.categories : [];
    return raw.map((c, idx) => {
        const isObj = c && typeof c === "object";
        const name = (isObj ? (c.category || c.Category || c.name || "Unknown") : String(c)).trim();
        return {
            id: (isObj && c.id) || `cat-${idx}`,
            name,
            gender: (isObj && c.gender) || "Mixed",
            matchType: (isObj && c.matchType) || "Singles",
            entryFee: isObj ? (Number(c.entryFee ?? c.fee) || null) : null,
        };
    });
};

// Same matching rules the player app uses when it maps selected ids to categories
const findEventCategory = (normalizedCategories, catId) =>
    normalizedCategories.find(
        (c) => c.id === catId || `${c.name}-${c.gender}` === catId || c.name === catId
    ) || null;

// Returns { fee, categoryObjects }. Throws (statusCode 400) on unknown category ids.
const computeRegistrationFee = (event, requestedCategoryIds, teamMemberCount) => {
    const normalized = normalizeEventCategories(event);
    const baseFee = normalized[0]?.entryFee || DEFAULT_CATEGORY_FEE;

    let feeSum = 0;
    let hasTeamMatchType = false;
    const categoryObjects = [];

    for (const rawId of requestedCategoryIds) {
        const catId = String(rawId && typeof rawId === "object" ? rawId.id : rawId);
        const cat = findEventCategory(normalized, catId);
        if (!cat) {
            const err = new Error(`Unknown category for this event: ${catId}`);
            err.statusCode = 400;
            throw err;
        }
        const fee = cat.entryFee || baseFee;
        feeSum += fee;
        if (TEAM_MATCH_TYPES.some((t) => cat.matchType.toLowerCase().includes(t))) {
            hasTeamMatchType = true;
        }
        categoryObjects.push({ id: cat.id, name: cat.name, gender: cat.gender, fee, matchType: cat.matchType });
    }

    // Team pricing: fee × (captain + members) — members only count for team match types
    let multiplier = 1;
    const memberCount = Number.parseInt(teamMemberCount, 10);
    if (hasTeamMatchType && Number.isInteger(memberCount) && memberCount > 0) {
        multiplier = 1 + Math.min(memberCount, MAX_TEAM_MEMBERS);
    }

    return { fee: feeSum * multiplier, categoryObjects };
};

// ── Category eligibility (server-side mirror of the player app's check) ──────
// The player app disables ineligible categories, but that is browser-side only.
// Without this the gate is cosmetic: a crafted request could enter any category.
//
// Age rules are encoded in the category NAME, exactly as the player app parses
// them: "U-15" => max age 15, "Above 40" => min age 40, "All" => unrestricted.
const parseCategoryAgeRules = (name) => {
    const label = String(name || "");
    const maxMatch = label.match(/(?:U|Under)[-\s]?(\d+)/i);
    const minMatch = label.match(/(?:Above|Over)\s*(\d+)|\b(\d+)\s*\+/i);
    return {
        ageLimit: maxMatch ? Number.parseInt(maxMatch[1], 10) : undefined,
        minAge: minMatch ? Number.parseInt(minMatch[1] ?? minMatch[2], 10) : undefined,
    };
};

// Returns the player's birth year, or null when nothing usable is on file.
const resolveBirthYear = (user, currentYear) => {
    if (user?.dob) {
        const parsed = new Date(user.dob);
        if (!Number.isNaN(parsed.getTime())) return parsed.getFullYear();
    }
    const age = Number(user?.age);
    if (Number.isFinite(age) && age > 0) return currentYear - age;
    return null;
};

/**
 * Throws a 400 if the player may not enter one of the requested categories.
 *
 * Mirrors the player app's policy deliberately, including the lenient part: a
 * player with no date of birth or age on file is allowed through, because most
 * accounts have neither and blocking them would stop registration entirely.
 * Tighten this only once DOB collection is in place.
 */
const assertPlayerEligible = (user, categoryObjects) => {
    const playerGender = String(user?.gender || "").toLowerCase();
    const currentYear = new Date().getFullYear();
    const birthYear = resolveBirthYear(user, currentYear);

    for (const cat of categoryObjects) {
        const categoryGender = String(cat.gender || "Mixed").toLowerCase();
        if (playerGender && categoryGender !== "mixed" && categoryGender !== "open") {
            if (categoryGender !== playerGender) {
                const err = new Error(`You are not eligible for "${cat.name}" (gender restricted)`);
                err.statusCode = 400;
                throw err;
            }
        }

        if (birthYear === null) continue; // no age on file — see note above

        const { ageLimit, minAge } = parseCategoryAgeRules(cat.name);
        // "Under 9" is strictly under 9 — the player must not turn 9 this year,
        // so the earliest allowed birth year is (currentYear - ageLimit + 1).
        // In 2026: U-9 => 2018, U-12 => 2015, U-15 => 2012.
        if (ageLimit !== undefined && birthYear < currentYear - ageLimit + 1) {
            const err = new Error(
                `You are not eligible for "${cat.name}" — born ${currentYear - ageLimit + 1} or later required`
            );
            err.statusCode = 400;
            throw err;
        }
        if (minAge !== undefined && birthYear > currentYear - minAge) {
            const err = new Error(`You are not eligible for "${cat.name}" (minimum age ${minAge})`);
            err.statusCode = 400;
            throw err;
        }
    }
};

const getRazorpayInstance = () => {
    const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env;
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
        throw new Error("Razorpay credentials (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) are not configured");
    }
    return new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
};

// ── Shared order → registration plumbing ─────────────────────────────────────
// Three writers can complete a Razorpay payment: the browser `handler` callback,
// the `payment.captured` webhook, and the reconcile endpoint the player app hits
// when the browser callback never fires (UPI app-switch, 3DS redirect, tab
// reload). They race, so every path goes through these helpers and treats an
// already-recorded order as success rather than an error.

// Rebuild category objects from the ids stored in the order notes, using the
// event's own category definitions so fees are authoritative.
const rebuildCategoriesFromNotes = async (notes) => {
    try {
        if (notes?.catIds) {
            const { data: event } = await supabaseAdmin
                .from("events")
                .select("id, categories")
                .eq("id", notes.eventId)
                .maybeSingle();
            if (event) {
                return computeRegistrationFee(event, String(notes.catIds).split(","), notes.teamMemberCount).categoryObjects;
            }
        } else if (notes?.categories) {
            return JSON.parse(notes.categories);
        }
    } catch (catErr) {
        console.warn("Could not reconstruct categories from order notes:", catErr.message);
    }
    return [];
};

// Look up whatever has already been recorded for a Razorpay order.
const findExistingOrderRecord = async (orderId) => {
    const { data: transaction, error: txErr } = await supabaseAdmin
        .from("transactions")
        .select("id, user_id, payment_id, amount")
        .eq("order_id", orderId)
        .maybeSingle();
    if (txErr) throw txErr;
    if (!transaction) return null;

    const { data: registration, error: regErr } = await supabaseAdmin
        .from("event_registrations")
        .select("registration_no, player_id, event_id, amount_paid")
        .eq("transaction_id", transaction.id)
        .maybeSingle();
    if (regErr) throw regErr;

    return { transaction, registration: registration || null };
};

// Insert transaction + verified registration as one unit (rolls the transaction
// back if the registration insert fails, so a retry can re-attempt both).
const recordVerifiedRegistration = async ({ orderId, paymentId, userId, eventId, amount, categories, teamId }) => {
    const { data: transaction, error: txError } = await supabaseAdmin.from("transactions").insert({
        order_id: orderId,
        payment_id: paymentId,
        payment_mode: "razorpay",
        amount,
        currency: "INR",
        user_id: userId,
    }).select().maybeSingle();

    if (txError || !transaction) throw txError || new Error("Tx Insert Failed");

    const registrationNo = `REG-${Date.now()}`;
    const { error: regError } = await supabaseAdmin.from("event_registrations").insert({
        event_id: eventId,
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

    return { transaction, registrationNo };
};

// Email + WhatsApp + team notifications — fire-and-forget, never blocks the response.
const dispatchRegistrationSideEffects = ({ userId, eventId, registrationNo, amount, categories, teamId, paymentId, paymentMode = "razorpay", status = "Confirmed" }) => {
    (async () => {
        try {
            const { data: user } = await supabaseAdmin.from("users").select("email, first_name, mobile").eq("id", userId).single();
            const { data: event } = await supabaseAdmin.from("events").select("name").eq("id", eventId).single();
            const details = {
                playerName: user?.first_name, eventName: event?.name, registrationNo,
                amount, category: categories, date: new Date(), status,
                paymentId, paymentMode,
            };

            // The email builds its own PDF; WhatsApp needs one Meta can fetch.
            const receipt = user?.mobile ? await publishReceiptPdf(details) : null;

            await Promise.allSettled([
                user?.email ? sendRegistrationEmail(user.email, details) : Promise.resolve(),
                user?.mobile
                    ? sendRegistrationReceiptWhatsApp(user.mobile, details, receipt || {})
                    : Promise.resolve(),
            ]);
        } catch (e) { console.error("Email/WhatsApp Error:", e); }
    })();

    if (teamId) {
        notifyTeamMembersOfRegistration(teamId, eventId).catch(e =>
            console.error("Team registration notification error:", e)
        );
    }
};

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
        const { eventId, amount, categories, teamMemberCount, teamId } = req.body;
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });
        if (req.user.role === "admin") return res.status(403).json({ message: "Admins cannot register." });
        if (!eventId || !Array.isArray(categories) || categories.length === 0) {
            return res.status(400).json({ message: "Missing fields: eventId and categories are required" });
        }

        const event = await resolveEventByIdentifier(eventId, "id, categories, payment_gateway");
        if (!event) return res.status(404).json({ message: "Event not found" });
        if ((event.payment_gateway || "manual") !== "razorpay") {
            return res.status(400).json({ message: "This event does not accept Razorpay payments" });
        }

        // The server-computed fee is authoritative. The client-sent amount is only
        // compared so a stale or tampered UI fails loudly instead of mischarging.
        const { fee, categoryObjects } = computeRegistrationFee(event, categories, teamMemberCount);

        // Eligibility is enforced here as well as in the UI — the UI check alone
        // is bypassable. Runs before the order is created so an ineligible player
        // is never charged.
        const { data: payingUser } = await supabaseAdmin
            .from("users").select("gender, dob, age").eq("id", userId).maybeSingle();
        assertPlayerEligible(payingUser, categoryObjects);
        if (amount !== undefined && Math.round(Number(amount) * 100) !== Math.round(fee * 100)) {
            return res.status(400).json({ message: "Amount mismatch — please refresh the page and try again" });
        }

        const catIds = categories.map((c) => (c && typeof c === "object" ? c.id : c)).join(",");
        const razorpay = getRazorpayInstance();
        const order = await razorpay.orders.create({
            amount: Math.round(fee * 100), // paise
            currency: "INR",
            receipt: `rec_${Date.now()}`,
            notes: {
                // Consumed by verify (ownership/event checks) and by the webhook
                // fallback to rebuild the registration if the browser callback dies.
                // Razorpay caps note values at 256 chars — skip catIds if oversized.
                userId,
                eventId: String(event.id),
                catIds: catIds.length <= 250 ? catIds : "",
                teamMemberCount: String(Number.parseInt(teamMemberCount, 10) || 0),
                teamId: teamId || "",
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
        if (err.statusCode === 400) return res.status(400).json({ message: err.message });
        res.status(500).json({ message: "Failed to create payment order" });
    }
};

// POST /api/payment/verify-razorpay-payment
export const verifyRazorpayPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, eventId, categories, teamId } = req.body;
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });
        if (req.user.role === "admin") return res.status(403).json({ message: "Admins cannot register." });
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !eventId || !categories) {
            return res.status(400).json({ message: "Missing fields" });
        }

        // Verify signature (constant-time to prevent timing attacks)
        const keySecret = process.env.RAZORPAY_KEY_SECRET;
        if (!keySecret) return res.status(500).json({ message: "Payment verification not configured" });

        const expectedSignature = crypto
            .createHmac("sha256", keySecret)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest("hex");

        const expectedBuf = Buffer.from(expectedSignature, "hex");
        const receivedBuf = Buffer.from(razorpay_signature || "", "hex");
        const sigValid = receivedBuf.length === expectedBuf.length &&
            crypto.timingSafeEqual(expectedBuf, receivedBuf);
        if (!sigValid) {
            return res.status(400).json({ success: false, message: "Payment signature verification failed" });
        }

        const resolvedEventId = await resolveEventIdByIdentifier(eventId);
        if (!resolvedEventId) return res.status(404).json({ message: "Event not found" });

        // Replay protection — one Razorpay order can produce exactly one registration.
        // Without this, a single genuine payment could be re-submitted with different
        // eventIds/categories to mint unlimited verified registrations.
        //
        // An order already recorded for THIS user is not an attack: the webhook
        // usually wins this race (payment.captured fires within a second or two for
        // UPI, while the browser is still round-tripping). Returning the existing
        // registration lets the player reach the receipt instead of being told to
        // pay again for a payment that already succeeded.
        const existingRecord = await findExistingOrderRecord(razorpay_order_id);
        if (existingRecord) {
            if (existingRecord.transaction.user_id !== userId) {
                return res.status(409).json({ success: false, message: "This payment has already been processed" });
            }
            if (!existingRecord.registration) {
                // Transaction row exists but the registration is still being written
                // by the other writer — tell the client to poll rather than fail.
                return res.status(202).json({ success: false, pending: true, message: "Payment is still being confirmed" });
            }
            return res.json({
                success: true,
                message: "Payment already verified",
                registrationNo: existingRecord.registration.registration_no,
                // transactions.payment_id is nullable. Fall back to the id from
                // this request — the signature check above already proved it
                // belongs to this order, so it is safe and strictly better than
                // handing the client an empty receipt field.
                paymentId: existingRecord.transaction.payment_id || razorpay_payment_id,
                alreadyProcessed: true,
            });
        }

        // Fetch the order from Razorpay — ties the payment to the user, event and
        // server-computed amount from order creation. Body values are untrusted.
        const razorpay = getRazorpayInstance();
        let order;
        try {
            order = await razorpay.orders.fetch(razorpay_order_id);
        } catch (fetchErr) {
            console.error("Razorpay order fetch failed:", fetchErr);
            return res.status(400).json({ success: false, message: "Payment order not found" });
        }
        const orderNotes = order?.notes || {};
        if (orderNotes.userId !== userId) {
            return res.status(403).json({ success: false, message: "Order does not belong to this user" });
        }
        if (String(orderNotes.eventId) !== String(resolvedEventId)) {
            return res.status(400).json({ success: false, message: "Order does not match this event" });
        }

        const paidAmount = order.amount / 100; // authoritative — set server-side at order creation

        const { registrationNo } = await recordVerifiedRegistration({
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id,
            userId,
            eventId: resolvedEventId,
            amount: paidAmount,
            categories,
            teamId,
        });

        dispatchRegistrationSideEffects({
            userId, eventId: resolvedEventId, registrationNo, amount: paidAmount, categories, teamId,
            paymentId: razorpay_payment_id,
        });

        res.json({ success: true, message: "Payment verified", registrationNo, paymentId: razorpay_payment_id });
    } catch (err) {
        console.error("Razorpay Verify Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
};

// GET /api/payment/order-status/:orderId
// Reconciliation endpoint for the case the browser callback never runs — UPI
// intent app-switch, 3DS full-page redirect, or the tab being reloaded while the
// payment completes. The player app calls this on load for any order it opened
// but never saw confirmed. If Razorpay says the order is paid and no webhook has
// recorded it yet, the registration is created here so the money is never taken
// without a registration to show for it.
export const getRazorpayOrderStatus = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });

        const { orderId } = req.params;
        if (!orderId) return res.status(400).json({ message: "orderId is required" });

        const existing = await findExistingOrderRecord(orderId);
        if (existing) {
            // Never leak another user's order — report it as unknown.
            if (existing.transaction.user_id !== userId) {
                return res.json({ success: true, status: "not_found" });
            }
            if (!existing.registration) {
                return res.json({ success: true, status: "pending" });
            }
            return res.json({
                success: true,
                status: "registered",
                registrationNo: existing.registration.registration_no,
                paymentId: existing.transaction.payment_id,
                amount: existing.registration.amount_paid ?? existing.transaction.amount,
                eventId: existing.registration.event_id,
            });
        }

        // Nothing recorded yet — ask Razorpay directly.
        const razorpay = getRazorpayInstance();
        let order;
        try {
            order = await razorpay.orders.fetch(orderId);
        } catch (fetchErr) {
            console.error("Razorpay order fetch failed (status check):", fetchErr);
            return res.json({ success: true, status: "not_found" });
        }

        const notes = order?.notes || {};
        if (notes.userId !== userId) return res.json({ success: true, status: "not_found" });
        if (order.status !== "paid") {
            return res.json({ success: true, status: order.status === "attempted" ? "pending" : "unpaid" });
        }

        // Order is paid but unrecorded — recover it.
        const resolvedEventId = await resolveEventIdByIdentifier(notes.eventId);
        if (!resolvedEventId) return res.status(404).json({ message: "Event not found" });

        let paymentId = null;
        try {
            const payments = await razorpay.orders.fetchPayments(orderId);
            paymentId = (payments?.items || []).find((p) => p.status === "captured" || p.status === "authorized")?.id || null;
        } catch (payErr) {
            console.warn("Could not fetch payments for order:", payErr.message);
        }

        const amount = order.amount_paid / 100;
        const categories = await rebuildCategoriesFromNotes(notes);
        const teamId = notes.teamId || null;

        let registrationNo;
        try {
            ({ registrationNo } = await recordVerifiedRegistration({
                orderId, paymentId, userId, eventId: resolvedEventId, amount, categories, teamId,
            }));
        } catch (writeErr) {
            // The webhook may have won the race between our lookup and this insert.
            const raced = await findExistingOrderRecord(orderId);
            if (raced?.registration && raced.transaction.user_id === userId) {
                return res.json({
                    success: true,
                    status: "registered",
                    registrationNo: raced.registration.registration_no,
                    paymentId: raced.transaction.payment_id,
                    amount: raced.registration.amount_paid ?? raced.transaction.amount,
                    eventId: raced.registration.event_id,
                });
            }
            throw writeErr;
        }

        console.log("Reconcile: recovered unrecorded paid order", orderId, "→", registrationNo);
        dispatchRegistrationSideEffects({
            userId, eventId: resolvedEventId, registrationNo, amount, categories, teamId, paymentId,
        });

        res.json({ success: true, status: "registered", registrationNo, paymentId, amount, eventId: resolvedEventId, recovered: true });
    } catch (err) {
        console.error("Razorpay Order Status Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
};

// POST /api/payment/webhook  (raw body — mounted before express.json in server.js)
export const razorpayWebhook = async (req, res) => {
    // --- Validate secret is configured ---
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
        console.error("RAZORPAY_WEBHOOK_SECRET is not set");
        return res.status(500).json({ error: "Webhook secret not configured" });
    }

    // --- Signature verification (constant-time to prevent timing attacks) ---
    const rawBody = req.body; // Buffer from express.raw()
    const receivedSignature = req.headers["x-razorpay-signature"] || "";

    const expectedSignature = crypto
        .createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex");

    const expectedBuffer = Buffer.from(expectedSignature, "hex");
    const receivedBuffer = Buffer.from(receivedSignature, "hex");
    const isValidSignature =
        receivedBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(expectedBuffer, receivedBuffer);

    if (!isValidSignature) {
        console.error("Webhook signature mismatch");
        return res.status(400).json({ error: "Invalid webhook signature" });
    }

    // --- Parse payload (non-recoverable if malformed — don't retry) ---
    let payload;
    try {
        payload = JSON.parse(rawBody.toString());
    } catch (parseErr) {
        console.error("Webhook payload parse error:", parseErr);
        return res.status(400).json({ error: "Invalid webhook payload" });
    }

    // --- Replay attack prevention: reject events older than 5 minutes ---
    // Normalize to seconds — Razorpay uses seconds, but guard against ms payloads
    let webhookTimestampSec = payload.created_at;
    if (webhookTimestampSec > 1e12) webhookTimestampSec = webhookTimestampSec / 1000;
    const nowSec = Date.now() / 1000;
    if (webhookTimestampSec && (nowSec - webhookTimestampSec) > 300) {
        // Older than 5 minutes — likely a replay; reject with 400 so Razorpay stops retrying
        console.warn("Webhook rejected: stale event timestamp:", webhookTimestampSec);
        return res.status(400).json({ error: "Stale webhook event" });
    }
    if (!webhookTimestampSec) {
        // Missing timestamp (test/tool webhooks) — warn but allow through
        console.warn("Webhook missing created_at timestamp, proceeding with caution");
    }

    // --- Process event (DB errors return 500 so Razorpay retries) ---
    try {
        const event = payload.event;
        const paymentEntity = payload.payload?.payment?.entity;

        if (event === "payment.captured") {
            const orderId = paymentEntity?.order_id;
            const paymentId = paymentEntity?.id;
            const amountPaise = paymentEntity?.amount; // in paise
            const notes = paymentEntity?.notes || {};

            // Idempotency check — skip if already processed by frontend callback
            const { data: existing, error: existingErr } = await supabaseAdmin
                .from("transactions")
                .select("id")
                .eq("order_id", orderId)
                .maybeSingle();

            if (existingErr) throw existingErr;

            if (!existing && notes.userId && notes.eventId) {
                // QA and PROD share one Razorpay account, so this account's webhook
                // fires into whichever backend URL is registered — which may not be
                // the environment the order was created in. Confirm the order's user
                // and event actually exist in THIS database before writing, otherwise
                // a QA payment could mint a phantom registration in prod (UUIDs
                // overlap: both databases were seeded from the same source).
                const [{ data: notesUser }, { data: notesEvent }] = await Promise.all([
                    supabaseAdmin.from("users").select("id").eq("id", notes.userId).maybeSingle(),
                    supabaseAdmin.from("events").select("id").eq("id", notes.eventId).maybeSingle(),
                ]);
                if (!notesUser || !notesEvent) {
                    // Not this environment's payment. 200 so Razorpay stops retrying.
                    console.warn("Webhook ignored — order belongs to another environment:", orderId);
                    return res.json({ received: true, ignored: "unknown user or event" });
                }

                // Frontend callback never fired — create registration as fallback
                const amount = amountPaise / 100;
                const categories = await rebuildCategoriesFromNotes(notes);

                const { registrationNo } = await recordVerifiedRegistration({
                    orderId,
                    paymentId,
                    userId: notes.userId,
                    eventId: notes.eventId,
                    amount,
                    categories,
                    teamId: notes.teamId,
                });
                console.log("Webhook fallback: registration created", registrationNo);

                dispatchRegistrationSideEffects({
                    userId: notes.userId,
                    eventId: notes.eventId,
                    registrationNo,
                    amount,
                    categories,
                    teamId: notes.teamId,
                    paymentId,
                });
            }
        }

        if (event === "payment.failed") {
            console.log("Payment failed:", paymentEntity?.id, "for order:", paymentEntity?.order_id);
        }

        // Respond 200 — Razorpay retries for up to 24h on non-2xx
        res.json({ received: true });
    } catch (err) {
        console.error("Webhook processing error (recoverable):", err);
        // Return 500 so Razorpay retries transient DB/infra failures
        res.status(500).json({ error: "Webhook processing failed, will retry" });
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

        const eventForEligibility = await resolveEventByIdentifier(eventId, "id, categories");
        if (!eventForEligibility) return res.status(404).json({ message: "Event not found" });
        const resolvedEventId = eventForEligibility.id;

        // Same eligibility gate as the Razorpay path — manual payments must not
        // be a way around it.
        try {
            const { categoryObjects } = computeRegistrationFee(eventForEligibility, categories, 0);
            const { data: payingUser } = await supabaseAdmin
                .from("users").select("gender, dob, age").eq("id", userId).maybeSingle();
            assertPlayerEligible(payingUser, categoryObjects);
        } catch (eligErr) {
            if (eligErr.statusCode === 400) return res.status(400).json({ message: eligErr.message });
            throw eligErr;
        }

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

        // 3. Email + WhatsApp + team notifications (Async)
        dispatchRegistrationSideEffects({
            userId,
            eventId: resolvedEventId,
            registrationNo,
            amount,
            categories,
            teamId,
            paymentId: transactionId || null,
            paymentMode: "manual",
            status: "Pending Verification",
        });

        res.json({ success: true, message: "Payment submitted", transactionId: transaction.id, registrationNo });

    } catch (err) {
        console.error("Manual Payment Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
};
