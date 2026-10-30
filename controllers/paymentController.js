import crypto from "crypto";
import Razorpay from "razorpay";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { createNotification } from "../services/notificationService.js";
import { invalidateDashboardForRegistration } from "../utils/dashboardCache.js";
import { resolveEventByIdentifier, resolveEventIdByIdentifier } from "../utils/eventResolver.js";
import { sendRegistrationEmail } from "../utils/mailer.js";
import { publishReceiptPdf } from "../utils/receiptDelivery.js";
import { generateReceiptPdf, receiptFilename } from "../utils/receiptPdf.js";
import { sendRegistrationReceiptWhatsApp, sendRegistrationWhatsApp } from "../utils/whatsapp.js";
import { isReceiptEligible } from "../utils/approvalNotifications.js";
import { uploadBase64 } from "../utils/uploadHelper.js";
import { acceptsManual, acceptsRazorpay } from "../utils/paymentGateway.js";
import { assertCommunityAllowed } from "../utils/communityRestriction.js";
import {
    allocateAmount,
    badRequestBody,
    entriesFromNotes,
    entriesFromRequest,
    groupsForPaidOrder,
    packEntriesIntoNotes,
    validateRegistrationEntries,
} from "../utils/registrationRules.js";

// These routes accept any signed token, so staff accounts must be turned away
// explicitly. Listing staff roles (rather than requiring 'player') keeps older
// player tokens working.
const STAFF_ROLES = new Set(["admin", "superadmin", "institutehead"]);
const isStaffRole = (role) => STAFF_ROLES.has(role);

// Fee, eligibility, team and duplicate-entry rules live in utils/registrationRules.js
// so every writer below applies the same ones.

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

// Rebuild the rows to store from the order notes, using the event's own
// category definitions so fees are authoritative. `fallback` is used only when
// the notes carry no categories at all (very old orders, or an oversized legacy
// catIds that was dropped at order time): it is the client's own selection,
// stored as one row, exactly as before.
const rebuildGroupsFromNotes = async (notes, fallback = null) => {
    try {
        const entries = entriesFromNotes(notes);
        if (entries.length > 0) {
            const { data: event } = await supabaseAdmin
                .from("events")
                .select("id, categories")
                .eq("id", notes.eventId)
                .maybeSingle();
            if (event) {
                const groups = groupsForPaidOrder(event, entries);
                if (groups.length > 0) return groups;
            }
        } else if (notes?.categories) {
            return [{ teamId: notes.teamId || null, categories: JSON.parse(notes.categories), fee: 0 }];
        }
    } catch (catErr) {
        console.warn("Could not reconstruct categories from order notes:", catErr.message);
    }
    if (fallback) return [{ teamId: fallback.teamId || null, categories: fallback.categories || [], fee: 0 }];
    return [{ teamId: notes?.teamId || null, categories: [], fee: 0 }];
};

/**
 * The registration a payment produced, as one record. A payment writes one row
 * per Doubles/Team entry plus one for the singles; they share the transaction
 * and registration number, so callers see the summed amount and all categories.
 */
const summarizeRegistrationRows = (rows) => {
    if (!rows || rows.length === 0) return null;
    const first = rows[0];
    return {
        registration_no: first.registration_no,
        player_id: first.player_id,
        event_id: first.event_id,
        amount_paid: rows.reduce((sum, r) => sum + (Number(r.amount_paid) || 0), 0),
        categories: rows.flatMap((r) => (Array.isArray(r.categories) ? r.categories : (r.categories ? [r.categories] : []))),
    };
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

    const { data: rows, error: regErr } = await supabaseAdmin
        .from("event_registrations")
        .select("registration_no, player_id, event_id, amount_paid, categories")
        .eq("transaction_id", transaction.id);
    if (regErr) throw regErr;

    return { transaction, registration: summarizeRegistrationRows(rows) };
};

/**
 * Write the registration rows for one payment. They go in as a single INSERT
 * (atomic in Postgres), sharing the transaction and registration number. If the
 * insert fails the transaction row is removed, so a retry re-attempts both.
 * Returns { transaction, registrationNo, rows }.
 */
const buildRegistrationRows = ({ registrationNo, transactionId, userId, eventId, groups, rowFields }) =>
    groups.map((g) => ({
        event_id: eventId,
        player_id: userId,
        registration_no: registrationNo,
        categories: g.categories,
        amount_paid: g.fee,
        transaction_id: transactionId,
        team_id: g.teamId || null,
        ...rowFields,
    }));

// The player's dashboard is cached for 15 minutes. Without this the person
// who just paid — and every partner/team-mate they entered — keeps seeing
// "No events found" until the TTL lapses, while the admin screen already
// shows the registration.
const invalidateDashboardsFor = async (userId, groups) => {
    const teamIds = [...new Set(groups.map((g) => g.teamId).filter(Boolean))];
    await Promise.allSettled([
        invalidateDashboardForRegistration({ userId }),
        ...teamIds.map((teamId) => invalidateDashboardForRegistration({ userId, teamId })),
    ]);
};

const insertRegistrationRows = async ({ transaction, userId, eventId, groups, rowFields }) => {
    const registrationNo = `REG-${Date.now()}`;
    const rows = buildRegistrationRows({ registrationNo, transactionId: transaction.id, userId, eventId, groups, rowFields });

    const { error: regError } = await supabaseAdmin.from("event_registrations").insert(rows);
    if (regError) {
        const { error: cleanupError } = await supabaseAdmin.from("transactions").delete().eq("id", transaction.id);
        if (cleanupError) {
            // Without this the orphan stays in the payment reports with no trace of why.
            console.error(`[insertRegistrationRows] orphaned transaction ${transaction.id} (${transaction.order_id}) could not be removed:`, cleanupError);
        }
        throw regError;
    }

    await invalidateDashboardsFor(userId, groups);

    return { transaction, registrationNo, rows };
};

// Insert transaction + verified registration rows as one unit.
const recordVerifiedRegistration = async ({ orderId, paymentId, userId, eventId, amount, groups }) => {
    const { data: transaction, error: txError } = await supabaseAdmin.from("transactions").insert({
        order_id: orderId,
        payment_id: paymentId,
        payment_mode: "razorpay",
        amount,
        currency: "INR",
        user_id: userId,
    }).select().maybeSingle();

    if (txError || !transaction) throw txError || new Error("Tx Insert Failed");

    return insertRegistrationRows({
        transaction,
        userId,
        eventId,
        groups: allocateAmount(groups, amount),
        rowFields: { status: "verified" },
    });
};

const allCategoriesOf = (groups) => groups.flatMap((g) => g.categories || []);

// Email + WhatsApp + team notifications — fire-and-forget, never blocks the response.
const dispatchRegistrationSideEffects = ({ userId, eventId, registrationNo, amount, groups, paymentId, paymentMode = "razorpay", status = "Confirmed" }) => {
    const categories = allCategoriesOf(groups);
    (async () => {
        try {
            const { data: user } = await supabaseAdmin.from("users").select("email, first_name, mobile").eq("id", userId).single();
            const { data: event } = await supabaseAdmin.from("events").select("name").eq("id", eventId).single();
            const details = {
                playerName: user?.first_name, eventName: event?.name, registrationNo,
                amount, category: categories, date: new Date(), status,
                paymentId, paymentMode,
            };

            // Payments awaiting admin approval get a "pending" notice only — the
            // receipt is sent by notifyRegistrationApproved once it is verified.
            const awaitingApproval = !isReceiptEligible(status);

            // The email builds its own PDF; WhatsApp needs one Meta can fetch.
            const receipt = (user?.mobile && !awaitingApproval) ? await publishReceiptPdf(details) : null;

            await Promise.allSettled([
                user?.email ? sendRegistrationEmail(user.email, details) : Promise.resolve(),
                user?.mobile
                    ? (awaitingApproval
                        ? sendRegistrationWhatsApp(user.mobile, details)
                        : sendRegistrationReceiptWhatsApp(user.mobile, details, receipt || {}))
                    : Promise.resolve(),
            ]);
        } catch (e) { console.error("Email/WhatsApp Error:", e); }
    })();

    // Each partner / squad is told which category they were entered in.
    for (const g of groups) {
        if (!g.teamId) continue;
        notifyTeamMembersOfRegistration(g.teamId, eventId, g.categories, status).catch(e =>
            console.error("Team registration notification error:", e)
        );
    }
};

const describeCategories = (categories) =>
    (categories || [])
        .map((c) => (c && typeof c === "object" ? `${c.name}${c.gender ? ` (${c.gender})` : ""}${c.matchType ? ` ${c.matchType}` : ""}` : String(c)))
        .filter(Boolean)
        .join(", ");

/**
 * Batch-resolve team member UUIDs and notify them of event registration.
 * Uses a single prefetch query instead of sequential per-member lookups,
 * and Promise.allSettled for safe parallel notification delivery.
 */
async function notifyTeamMembersOfRegistration(teamId, eventId, categories = [], status = "Confirmed") {
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
        const categoryText = describeCategories(categories);
        const paymentText = isReceiptEligible(status)
            ? "The entry fee is paid."
            : "Payment is awaiting the organiser's verification.";

        // Batch-resolve all member UUIDs in a single query. Masked mobiles
        // ("XXXXXX4785", stored by the Player-ID lookup) are skipped — they can
        // never match and would only break the filter.
        const playerIds = [];
        const mobiles = [];
        const knownIds = [];
        for (const m of team.members) {
            if (m.id) knownIds.push(m.id);
            if (m.player_id) playerIds.push(m.player_id.toUpperCase());
            if (m.mobile && /^\d{10,15}$/.test(String(m.mobile))) mobiles.push(m.mobile);
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
                `${captainName} (captain) registered you with "${team.team_name}" for "${eventName}"${categoryText ? ` — ${categoryText}` : ''}. ${paymentText}`,
                'info',
                '/dashboard?tab=events'
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

/**
 * Load the paying player and run every registration rule for this request.
 * Shared by the validate endpoint, order creation and manual payment so the
 * player is told about a problem before paying, by the same rules that guard
 * the write. Throws statusCode-400 errors.
 */
const validateRequestForUser = async (event, userId, body) => {
    const { data: payingUser } = await supabaseAdmin
        .from("users").select("gender, dob, age, apartment, institute_name").eq("id", userId).maybeSingle();
    const result = await validateRegistrationEntries({
        event,
        userId,
        payingUser,
        entries: entriesFromRequest(body),
    });
    // Community-restricted events: checked before anything is paid, so a
    // player outside the allowed communities is never charged.
    await assertCommunityAllowed(event, payingUser);
    return result;
};

// POST /api/payment/check-teams  { eventId, categoryId }
// Which of the player's saved teams can be entered in this category, and why
// not for the rest — the full registration rules (each member's age/gender,
// pair/team size, nobody already entered in the category), run per team. Feeds
// the partner/team chooser so an ineligible saved team is greyed out with the
// reason before it is picked, not after Continue.
export const checkTeamsForCategory = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });
        if (isStaffRole(req.user.role)) return res.status(403).json({ message: "Admins cannot register." });
        const { eventId, categoryId } = req.body || {};
        if (!eventId || !categoryId) return res.status(400).json({ message: "eventId and categoryId are required" });

        const event = await resolveEventByIdentifier(eventId, "*");
        if (!event) return res.status(404).json({ message: "Event not found" });

        const [{ data: payingUser }, { data: teams, error: teamsErr }] = await Promise.all([
            supabaseAdmin.from("users").select("gender, dob, age").eq("id", userId).maybeSingle(),
            supabaseAdmin.from("player_teams").select("id").eq("captain_id", userId)
                .or("status.is.null,status.neq.deleted"),
        ]);
        if (teamsErr) throw teamsErr;

        const results = [];
        for (const team of teams || []) {
            try {
                await validateRegistrationEntries({
                    event, userId, payingUser,
                    entries: [{ categoryId: String(categoryId), teamId: team.id }],
                });
                results.push({ teamId: team.id, eligible: true });
            } catch (err) {
                if (err.statusCode !== 400) throw err;
                results.push({ teamId: team.id, eligible: false, reason: err.message, code: err.code || null });
            }
        }
        res.json({ success: true, teams: results });
    } catch (err) {
        console.error("Check Teams Error:", err);
        res.status(500).json({ message: "Could not check your teams" });
    }
};

// POST /api/payment/validate-registration
// Dry run of the checks order creation and manual payment will apply. The
// player app calls it on "Continue", which matters most for QR payments: there
// the player pays by UPI BEFORE submitting, so a rejection at submit time would
// come after the money has left their account.
export const validateRegistration = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });
        if (isStaffRole(req.user.role)) return res.status(403).json({ message: "Admins cannot register." });
        if (!req.body?.eventId) return res.status(400).json({ message: "eventId is required" });

        const event = await resolveEventByIdentifier(req.body.eventId, "*");
        if (!event) return res.status(404).json({ message: "Event not found" });

        const { fee, groups } = await validateRequestForUser(event, userId, req.body);
        res.json({
            success: true,
            fee,
            entries: groups.map((g) => ({ teamId: g.teamId, categoryIds: g.categories.map((c) => String(c.id)), fee: g.fee })),
        });
    } catch (err) {
        if (err.statusCode === 400) return res.status(400).json(badRequestBody(err));
        console.error("Validate Registration Error:", err);
        res.status(500).json({ message: "Could not validate registration" });
    }
};

// POST /api/payment/create-razorpay-order
export const createRazorpayOrder = async (req, res) => {
    try {
        const { eventId, amount } = req.body;
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });
        if (isStaffRole(req.user.role)) return res.status(403).json({ message: "Admins cannot register." });
        if (!eventId || entriesFromRequest(req.body).length === 0) {
            return res.status(400).json({ message: "Missing fields: eventId and categories are required" });
        }

        // "*" rather than a column list so this keeps working on a database
        // that has not had the community-restriction migration applied yet.
        const event = await resolveEventByIdentifier(eventId, "*");
        if (!event) return res.status(404).json({ message: "Event not found" });
        if (!acceptsRazorpay(event.payment_gateway)) {
            return res.status(400).json({ message: "This event does not accept Razorpay payments" });
        }

        // Every rule — closed categories, eligibility of the payer AND of each
        // partner/team member, captaincy, team size, duplicate entries,
        // community — runs before the order exists, so a rejected request is
        // never charged. The server-computed fee is authoritative; the
        // client-sent amount is only compared so a stale or tampered UI fails
        // loudly instead of mischarging.
        const { fee, groups } = await validateRequestForUser(event, userId, req.body);
        if (amount !== undefined && Math.round(Number(amount) * 100) !== Math.round(fee * 100)) {
            return res.status(400).json({ message: "Amount mismatch — please refresh the page and try again" });
        }

        // Razorpay rejects orders below ₹1, so a free (₹0) selection cannot go
        // through checkout. Fail here with a clear message rather than letting
        // the SDK throw something opaque. Free registration needs its own
        // no-payment path: registerFree below.
        if (!(fee > 0)) {
            return res.status(400).json({
                message: "This selection totals ₹0. Free registration is not supported yet — contact the organiser.",
                code: "ZERO_AMOUNT_ORDER",
            });
        }

        const razorpay = getRazorpayInstance();
        const order = await razorpay.orders.create({
            amount: Math.round(fee * 100), // paise
            currency: "INR",
            receipt: `rec_${Date.now()}`,
            notes: {
                // Consumed by verify (ownership/event checks) and by the webhook
                // and reconcile fallbacks to rebuild the registration if the
                // browser callback dies. Each category travels with the team it
                // was entered with ("catId:teamId", packed across e0..e9 —
                // Razorpay caps a note value at 256 chars).
                userId,
                eventId: String(event.id),
                ...packEntriesIntoNotes(groups),
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
        // `code` / `categoryId` ride along when the thrower set them, so the
        // client can react to the specific cause rather than parse the message.
        if (err.statusCode === 400) return res.status(400).json(badRequestBody(err));
        console.error("Razorpay Order Error:", err);
        res.status(500).json({ message: "Failed to create payment order" });
    }
};

// POST /api/payment/verify-razorpay-payment
export const verifyRazorpayPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, eventId, categories, teamId } = req.body;
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });
        if (isStaffRole(req.user.role)) return res.status(403).json({ message: "Admins cannot register." });
        // `categories` / `entries` are optional here: what was bought is read
        // from the order notes. A body selection is only a last-resort fallback
        // for orders whose notes carry none.
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !eventId) {
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

        // What was bought — each category with the team it was entered with —
        // comes from the order notes written at creation, never from the body.
        const groups = await rebuildGroupsFromNotes(orderNotes, Array.isArray(categories) ? { categories, teamId } : null);

        const { registrationNo } = await recordVerifiedRegistration({
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id,
            userId,
            eventId: resolvedEventId,
            amount: paidAmount,
            groups,
        });

        dispatchRegistrationSideEffects({
            userId, eventId: resolvedEventId, registrationNo, amount: paidAmount, groups,
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
        const groups = await rebuildGroupsFromNotes(notes);

        let registrationNo;
        try {
            ({ registrationNo } = await recordVerifiedRegistration({
                orderId, paymentId, userId, eventId: resolvedEventId, amount, groups,
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
            userId, eventId: resolvedEventId, registrationNo, amount, groups, paymentId,
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
                const groups = await rebuildGroupsFromNotes(notes);

                const { registrationNo } = await recordVerifiedRegistration({
                    orderId,
                    paymentId,
                    userId: notes.userId,
                    eventId: notes.eventId,
                    amount,
                    groups,
                });
                console.log("Webhook fallback: registration created", registrationNo);

                dispatchRegistrationSideEffects({
                    userId: notes.userId,
                    eventId: notes.eventId,
                    registrationNo,
                    amount,
                    groups,
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
        const { eventId, amount, transactionId, screenshot, document } = req.body;
        const userId = req.user?.id;

        if (!userId) return res.status(401).json({ message: "Unauthorized" });
        // `amount` is no longer required: the stored amount is computed here.
        if (!eventId || entriesFromRequest(req.body).length === 0 || !screenshot) return res.status(400).json({ message: "Missing fields" });
        if (isStaffRole(req.user.role)) return res.status(403).json({ message: "Admins cannot register." });

        const eventForEligibility = await resolveEventByIdentifier(eventId, "*");
        if (!eventForEligibility) return res.status(404).json({ message: "Event not found" });
        const resolvedEventId = eventForEligibility.id;
        if (!acceptsManual(eventForEligibility.payment_gateway)) {
            return res.status(400).json({ message: "This event only accepts online payment" });
        }

        // Same rules as the Razorpay path — manual payments must not be a way
        // around them (eligibility of payer and members, captaincy, team size,
        // duplicates, closed categories, community). The player app runs the
        // same checks via /validate-registration BEFORE showing the QR, so a
        // rejection here only happens if something changed in between. The fee
        // computed here is also what gets stored: the amount the browser sends
        // used to be saved as-is, so an edited request could record any figure
        // as paid and skew the payment reports.
        let fee;
        let groups;
        try {
            ({ fee, groups } = await validateRequestForUser(eventForEligibility, userId, req.body));
        } catch (eligErr) {
            if (eligErr.statusCode === 400) return res.status(400).json(badRequestBody(eligErr));
            throw eligErr;
        }

        if (!(fee > 0)) {
            return res.status(400).json({
                message: "This selection totals ₹0. Free registration is not supported yet — contact the organiser.",
                code: "ZERO_AMOUNT_ORDER",
            });
        }
        if (amount !== undefined && Math.round(Number(amount) * 100) !== Math.round(fee * 100)) {
            // Not rejected: the player has already paid by UPI before submitting,
            // and the admin checks the screenshot against the stored amount.
            console.warn(`[submitManualPayment] client amount ${amount} != server fee ${fee} (user ${userId}, event ${resolvedEventId})`);
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
            amount: fee,
            currency: "INR",
            user_id: userId,
        }).select().maybeSingle();

        if (txError || !transaction) throw txError || new Error("Tx Insert Failed");

        // 2. Create the registration rows — one per Doubles/Team entry, one for
        //    the singles — all sharing this transaction and registration number.
        //    The helper also drops the payer's and every team-mate's cached
        //    dashboard.
        const { registrationNo } = await insertRegistrationRows({
            transaction,
            userId,
            eventId: resolvedEventId,
            groups,
            rowFields: {
                screenshot_url: screenshotUrl,
                manual_transaction_id: transactionId || null,
                document_url: documentUrl,
                status: "pending_verification",
            },
        });

        // 3. Email + WhatsApp + team notifications (Async)
        dispatchRegistrationSideEffects({
            userId,
            eventId: resolvedEventId,
            registrationNo,
            amount: fee,
            groups,
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

// user+event pairs with a free registration in progress on this server. A
// double-click or client retry arriving while the first request is still
// validating / writing would otherwise pass the duplicate check too, as nothing
// is saved yet. Per process only: a unique constraint is the cross-instance fix.
const freeRegistrationsInFlight = new Set();

// POST /api/payment/register-free
// Registration for a selection that totals ₹0. No payment is taken and there is
// nothing for an admin to verify, so the rows go in as `verified` straight away
// (which also releases the receipt). Runs the same rules as the paid paths, and
// refuses any selection with a non-zero fee, so this can never be used to skip
// paying for a paid category.
export const registerFree = async (req, res) => {
    let inFlightKey = null;
    try {
        const { eventId, document } = req.body;
        const userId = req.user?.id;

        if (!userId) return res.status(401).json({ message: "Unauthorized" });
        if (!eventId || entriesFromRequest(req.body).length === 0) return res.status(400).json({ message: "Missing fields" });
        if (isStaffRole(req.user.role)) return res.status(403).json({ message: "Admins cannot register." });

        const event = await resolveEventByIdentifier(eventId, "*");
        if (!event) return res.status(404).json({ message: "Event not found" });
        const resolvedEventId = event.id;

        inFlightKey = `${userId}:${resolvedEventId}`;
        if (freeRegistrationsInFlight.has(inFlightKey)) {
            inFlightKey = null; // not ours to release
            return res.status(409).json({
                message: "Your registration is already being processed. Please wait a moment.",
                code: "REGISTRATION_IN_PROGRESS",
            });
        }
        freeRegistrationsInFlight.add(inFlightKey);

        let fee;
        let groups;
        try {
            ({ fee, groups } = await validateRequestForUser(event, userId, req.body));
        } catch (eligErr) {
            // A known rule failure (400 today; any 4xx later) is the player's to fix, not a server error.
            if (eligErr.statusCode >= 400 && eligErr.statusCode < 500) return res.status(eligErr.statusCode).json(badRequestBody(eligErr));
            throw eligErr;
        }

        if (fee !== 0) {
            return res.status(400).json({
                message: "This selection is not free. Please pay to register.",
                code: "PAYMENT_REQUIRED",
            });
        }

        // The document is optional; a supplied one that fails to upload is an
        // error, not a silently missing file.
        let documentUrl = null;
        if (document) {
            documentUrl = await uploadBase64(document, "event-documents", "user-docs");
            if (!documentUrl) return res.status(500).json({ message: "Failed to upload document" });
        }

        // transactions.payment_mode is kept to the values already in use
        // ("manual" / "razorpay"); the FREE_ prefix marks this as a no-payment
        // entry. The reference is unique per registration, so nothing keyed on
        // manual_transaction_id (a unique index, reports) can collide.
        const freeRef = `FREE_${crypto.randomUUID()}`;
        const transactionPayload = {
            order_id: freeRef,
            manual_transaction_id: freeRef,
            payment_mode: "manual",
            amount: 0,
            currency: "INR",
            user_id: userId,
        };
        const rowFields = { manual_transaction_id: freeRef, document_url: documentUrl, status: "verified" };

        // Preferred: one database function writes the transaction and every
        // registration row together, so a failure leaves nothing behind
        // (scripts/add_register_free_entry_fn.sql). Until that is applied the
        // function does not exist, and the two-step write below is used instead.
        let transaction;
        let registrationNo;
        const registrationNoForRpc = `REG-${Date.now()}`;
        const { data: rpcTransaction, error: rpcError } = await supabaseAdmin.rpc("register_free_entry", {
            p_transaction: transactionPayload,
            p_rows: buildRegistrationRows({ registrationNo: registrationNoForRpc, transactionId: null, userId, eventId: resolvedEventId, groups, rowFields }),
        });

        if (!rpcError && rpcTransaction) {
            transaction = rpcTransaction;
            registrationNo = registrationNoForRpc;
            await invalidateDashboardsFor(userId, groups);
        } else if (rpcError?.code === "P0001" && /ALREADY_REGISTERED/.test(rpcError.message || "")) {
            // Lost a race with another request for the same player and category.
            return res.status(400).json({
                message: "You are already registered in this category.",
                code: "ALREADY_REGISTERED",
            });
        } else if (rpcError && (rpcError.code === "PGRST202" || rpcError.code === "42883")) {
            // Function not installed yet. The two-step write below cannot be made
            // atomic: a crash between its writes can leave a transactions row behind.
            // Set REQUIRE_ATOMIC_FREE_REGISTRATION=true once the SQL is applied to
            // refuse it, rather than silently falling back.
            if (process.env.REQUIRE_ATOMIC_FREE_REGISTRATION === "true") {
                console.error("register_free_entry() is not installed; refusing the non-atomic fallback.");
                return res.status(503).json({ message: "Free registration is temporarily unavailable. Please try again later." });
            }
            const { data: tx, error: txError } = await supabaseAdmin.from("transactions").insert(transactionPayload).select().maybeSingle();
            if (txError || !tx) throw txError || new Error("Tx Insert Failed");
            transaction = tx;
            ({ registrationNo } = await insertRegistrationRows({ transaction, userId, eventId: resolvedEventId, groups, rowFields }));
        } else {
            // The function ran and failed: it rolled back, so nothing was written.
            throw rpcError || new Error("Free registration failed");
        }

        // The registration is already saved; a notification problem must not
        // turn it into an error response (the player would retry and hit "already registered").
        // dispatchRegistrationSideEffects is not async: its email / WhatsApp work
        // runs in an inner IIFE with its own try/catch, so nothing here can become
        // an unhandled rejection. This catch covers only a synchronous throw.
        try {
            dispatchRegistrationSideEffects({
                userId,
                eventId: resolvedEventId,
                registrationNo,
                amount: 0,
                groups,
                paymentId: null,
                paymentMode: "manual",
                status: "Confirmed",
            });
        } catch (sideEffectError) {
            console.error("Free registration side effects failed:", sideEffectError);
        }

        res.json({ success: true, message: "Registered", transactionId: transaction.id, registrationNo });
    } catch (err) {
        console.error("Free registration error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    } finally {
        if (inFlightKey) freeRegistrationsInFlight.delete(inFlightKey);
    }
};

/**
 * The caller's registration by number, merged across its rows. One payment
 * writes a row per Doubles/Team entry plus one for the singles, all under the
 * same number; admin approval moves them together, so they normally share a
 * status. Should they ever differ, the one still needing attention wins
 * (pending/rejected over verified), so a receipt is never released early.
 * Returns null when the caller owns no row with that number.
 */
const loadOwnedRegistration = async (registrationNo, userId, fields) => {
    const { data: rows, error } = await supabaseAdmin
        .from("event_registrations")
        .select(fields)
        .eq("registration_no", registrationNo)
        .eq("player_id", userId)
        .order("created_at", { ascending: true });
    if (error) throw error;
    if (!rows || rows.length === 0) return null;

    const unsettled = rows.find((r) => !isReceiptEligible(r.status));
    return {
        ...rows[0],
        status: (unsettled || rows[0]).status,
        amount_paid: rows.reduce((sum, r) => sum + (Number(r.amount_paid) || 0), 0),
        categories: rows.flatMap((r) => (Array.isArray(r.categories) ? r.categories : (r.categories ? [r.categories] : []))),
        screenshot_url: rows.find((r) => r.screenshot_url)?.screenshot_url || null,
    };
};

// Raw registration status → the wording players see on the receipt.
const RECEIPT_STATUS_LABELS = {
    verified: "Confirmed",
    confirmed: "Confirmed",
    approved: "Confirmed",
    paid: "Confirmed",
    pending_verification: "Pending Verification",
    payment_pending: "Payment Pending",
    registered: "Submitted",
    rejected: "Rejected",
    cancelled: "Cancelled",
};

/**
 * GET /api/payment/registration-status/:registrationNo
 *
 * Lightweight owner-only status lookup so the success screen can flip from
 * "Pending Verification" to "Approved" without a reload.
 */
export const getRegistrationStatus = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });

        const registration = await loadOwnedRegistration(
            req.params.registrationNo, userId, "registration_no, player_id, status, screenshot_url"
        );
        if (!registration) {
            return res.status(404).json({ message: "Registration not found" });
        }

        res.json({
            success: true,
            status: registration.status,
            label: RECEIPT_STATUS_LABELS[registration.status] || registration.status,
            receiptReady: isReceiptEligible(registration.status),
            screenshotUrl: registration.screenshot_url || null,
        });
    } catch (err) {
        console.error("Registration status error:", err);
        res.status(500).json({ message: "Could not fetch status" });
    }
};

/**
 * GET /api/payment/receipt/:registrationNo
 *
 * Serves the same PDF the confirmation email attaches and WhatsApp delivers, so
 * the copy downloaded from the dashboard is byte-identical to the ones the
 * player was already sent. The player app previously rebuilt the receipt in the
 * browser as raw HTML, which both drifted from these and mis-rendered ₹ on
 * mobile (no charset declared on the downloaded file).
 */
export const downloadRegistrationReceipt = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { registrationNo } = req.params;

        if (!userId) return res.status(401).json({ message: "Unauthorized" });
        if (!registrationNo) return res.status(400).json({ message: "Missing registration number" });

        // All rows of the payment (one per Doubles/Team entry plus singles)
        // make one receipt: every category, the total amount.
        const registration = await loadOwnedRegistration(
            registrationNo, userId,
            "registration_no, player_id, event_id, categories, amount_paid, status, created_at, transaction_id, manual_transaction_id"
        );

        // 404 rather than 403 for someone else's registration: registration
        // numbers are `REG-<timestamp>`, so a distinguishable response would
        // make them enumerable.
        if (!registration) {
            return res.status(404).json({ message: "Receipt not found" });
        }

        // The receipt is released only after admin approval.
        if (!isReceiptEligible(registration.status)) {
            return res.status(403).json({
                message: "Receipt will be available once your registration is approved",
                code: "RECEIPT_NOT_READY",
                status: registration.status,
            });
        }

        const [{ data: user }, { data: event }, { data: transaction }] = await Promise.all([
            supabaseAdmin.from("users").select("first_name").eq("id", userId).maybeSingle(),
            supabaseAdmin.from("events").select("name").eq("id", registration.event_id).maybeSingle(),
            registration.transaction_id
                ? supabaseAdmin
                    .from("transactions")
                    .select("payment_id, payment_mode, manual_transaction_id")
                    .eq("id", registration.transaction_id)
                    .maybeSingle()
                : Promise.resolve({ data: null }),
        ]);

        const pdf = await generateReceiptPdf({
            playerName: user?.first_name,
            eventName: event?.name,
            registrationNo: registration.registration_no,
            amount: registration.amount_paid,
            category: registration.categories,
            date: registration.created_at,
            status: RECEIPT_STATUS_LABELS[registration.status] || registration.status || "Confirmed",
            paymentId: transaction?.payment_id
                || transaction?.manual_transaction_id
                || registration.manual_transaction_id
                || null,
            paymentMode: transaction?.payment_mode
                || (registration.manual_transaction_id ? "manual" : "razorpay"),
        });

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${receiptFilename(registration.registration_no)}"`);
        res.setHeader("Content-Length", pdf.length);
        res.send(pdf);
    } catch (err) {
        console.error("Receipt download error:", err);
        res.status(500).json({ message: "Could not generate receipt" });
    }
};
