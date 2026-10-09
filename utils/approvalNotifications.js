import { supabaseAdmin } from "../config/supabaseClient.js";
import { publishReceiptPdf } from "./receiptDelivery.js";
import { sendRegistrationEmail } from "./mailer.js";
import { sendRegistrationReceiptWhatsApp } from "./whatsapp.js";

/**
 * Registration statuses that entitle the player to a receipt. A manual (UPI)
 * registration starts as `pending_verification` and only gets one after an
 * admin verifies the payment screenshot.
 */
const RECEIPT_ELIGIBLE_STATUSES = new Set(["verified", "confirmed", "approved", "paid"]);
export const isReceiptEligible = (status) => RECEIPT_ELIGIBLE_STATUSES.has(String(status || "").toLowerCase());

/**
 * Deliver the confirmation + receipt PDF (email and WhatsApp) once an admin has
 * approved a registration. Fire-and-forget: never blocks or fails the admin's
 * request.
 */
export const notifyRegistrationApproved = (registrationId) => {
    (async () => {
        try {
            const { data: reg } = await supabaseAdmin
                .from("event_registrations")
                .select("registration_no, player_id, event_id, categories, amount_paid, created_at, transaction_id, manual_transaction_id")
                .eq("id", registrationId)
                .maybeSingle();
            if (!reg) return;

            const [{ data: user }, { data: event }, { data: tx }] = await Promise.all([
                supabaseAdmin.from("users").select("email, first_name, mobile").eq("id", reg.player_id).maybeSingle(),
                supabaseAdmin.from("events").select("name").eq("id", reg.event_id).maybeSingle(),
                reg.transaction_id
                    ? supabaseAdmin.from("transactions").select("payment_id, payment_mode, manual_transaction_id").eq("id", reg.transaction_id).maybeSingle()
                    : Promise.resolve({ data: null }),
            ]);

            const details = {
                playerName: user?.first_name,
                eventName: event?.name,
                registrationNo: reg.registration_no,
                amount: reg.amount_paid,
                category: reg.categories,
                date: reg.created_at,
                status: "Confirmed",
                paymentId: tx?.payment_id || tx?.manual_transaction_id || reg.manual_transaction_id || null,
                paymentMode: tx?.payment_mode || (reg.manual_transaction_id ? "manual" : "razorpay"),
            };

            const receipt = user?.mobile ? await publishReceiptPdf(details) : null;
            await Promise.allSettled([
                user?.email ? sendRegistrationEmail(user.email, details) : Promise.resolve(),
                user?.mobile ? sendRegistrationReceiptWhatsApp(user.mobile, details, receipt || {}) : Promise.resolve(),
            ]);
        } catch (e) {
            console.error("Approval notification error:", e.message);
        }
    })();
};
