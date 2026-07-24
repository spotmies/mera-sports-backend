import axios from "axios";
import crypto from "crypto";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { sendOtpEmail } from "../utils/mailer.js";
import { sendOtpWhatsApp } from "../utils/whatsapp.js";

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

// In-memory fallback — used only when the `otp_sessions` table is unavailable
// (e.g. before the migration is run). A single Supabase-backed store keeps OTPs
// valid across backend restarts and multiple instances.
const memStore = new Map();

const TWO_FACTOR_API_KEY = process.env.TWO_FACTOR_API_KEY || "e6b3f27c-da5e-11f0-a6b2-0200cd936042";

/**
 * Persist an OTP for a given channel + key (sessionId for mobile, email for email).
 * Writes to Supabase; falls back to an in-memory Map if the DB is unreachable.
 */
async function storeOtp(channel, key, otp) {
    const now = Date.now();
    try {
        const { error } = await supabaseAdmin
            .from("otp_sessions")
            .upsert(
                {
                    channel,
                    session_key: key,
                    otp: String(otp),
                    expires_at: new Date(now + OTP_TTL_MS).toISOString(),
                },
                { onConflict: "channel,session_key" }
            );
        if (error) throw error;
    } catch (err) {
        console.warn(`OTP store: DB unavailable, using in-memory fallback (${err.message})`);
        memStore.set(`${channel}:${key}`, { otp: String(otp), expiresAt: now + OTP_TTL_MS });
    }
}

/**
 * Verify an OTP for a channel + key. Consumes (deletes) the record on success or
 * expiry so it can't be reused; leaves it in place on a wrong guess for retries.
 * @returns {Promise<boolean>}
 */
async function consumeOtp(channel, key, otp) {
    try {
        const { data, error } = await supabaseAdmin
            .from("otp_sessions")
            .select("id, otp, expires_at")
            .eq("channel", channel)
            .eq("session_key", key)
            .maybeSingle();
        if (error) throw error;

        if (data) {
            const expired = new Date(data.expires_at).getTime() < Date.now();
            const match = data.otp === String(otp);
            if (expired || match) {
                await supabaseAdmin.from("otp_sessions").delete().eq("id", data.id);
            }
            return !expired && match;
        }
        // Not found in DB — fall through to the in-memory fallback
    } catch (err) {
        console.warn(`OTP verify: DB error, checking in-memory fallback (${err.message})`);
    }

    const memKey = `${channel}:${key}`;
    const record = memStore.get(memKey);
    if (!record) return false;
    if (Date.now() > record.expiresAt) {
        memStore.delete(memKey);
        return false;
    }
    if (record.otp === String(otp)) {
        memStore.delete(memKey);
        return true;
    }
    return false;
}

/**
 * Sends a Mobile OTP — WhatsApp first, 2Factor.in SMS as fallback
 * @param {string} mobile - Mobile number
 * @returns {Promise<{success: boolean, sessionId?: string, message?: string}>}
 */
export async function sendMobileOtp(mobile) {
    if (!mobile) throw new Error("Mobile number is required");

    const otp = Math.floor(100000 + Math.random() * 900000);

    // Primary channel: WhatsApp (self-generated OTP, verified against our store)
    try {
        const sent = await sendOtpWhatsApp(mobile, otp);
        if (sent) {
            const sessionId = `wa_${crypto.randomUUID()}`;
            await storeOtp("mobile", sessionId, otp);
            return { success: true, sessionId };
        }
    } catch (waErr) {
        console.error("Service: sendMobileOtp WhatsApp Error:", waErr.message);
    }

    // Fallback channel: 2Factor.in SMS
    try {
        const url = `https://2factor.in/API/V1/${TWO_FACTOR_API_KEY}/SMS/${mobile}/${otp}`;

        const response = await axios.get(url);

        if (response.data && response.data.Status === "Success") {
            return { success: true, sessionId: response.data.Details };
        } else {
            console.error("2Factor Error:", response.data);
            throw new Error("Failed to send SMS OTP via Provider");
        }
    } catch (err) {
        console.error("Service: sendMobileOtp Error:", err.message);
        throw err;
    }
}

/**
 * Verifies a Mobile OTP — shared store for WhatsApp sessions, 2Factor.in for SMS sessions
 * @param {string} sessionId - Session ID from send step
 * @param {string} otp - OTP entered by user
 * @returns {Promise<boolean>}
 */
export async function verifyMobileOtp(sessionId, otp) {
    if (!sessionId || !otp) throw new Error("Session ID and OTP are required");

    // WhatsApp OTP session — verify against our shared store
    if (sessionId.startsWith("wa_")) {
        return consumeOtp("mobile", sessionId, otp);
    }

    // 2Factor.in SMS session
    try {
        const url = `https://2factor.in/API/V1/${TWO_FACTOR_API_KEY}/SMS/VERIFY/${sessionId}/${otp}`;
        const response = await axios.get(url);

        if (response.data && response.data.Status === "Success") {
            return true;
        }
        return false;
    } catch (err) {
        console.error("Service: verifyMobileOtp Error:", err.message);
        return false;
    }
}

/**
 * Sends an Email OTP using Custom NodeMailer to avoid rate limits
 * @param {string} email
 */
export async function sendEmailOtp(email) {
    if (!email) throw new Error("Email is required");

    try {
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        await storeOtp("email", email, otp);

        const success = await sendOtpEmail(email, otp);
        if (!success) {
            throw new Error("Failed to deliver OTP email");
        }

        return { success: true, message: "OTP sent successfully" };
    } catch (err) {
        console.error("Service: sendEmailOtp Error:", err.message);
        throw new Error("Failed to send OTP email: " + err.message);
    }
}

/**
 * Verifies Custom Email OTP
 * @param {string} email
 * @param {string} otp
 */
export async function verifyEmailOtp(email, otp) {
    if (!email || !otp) throw new Error("Email and OTP required");

    try {
        return await consumeOtp("email", email, otp);
    } catch (err) {
        console.error("Service: verifyEmailOtp Error:", err.message);
        return false;
    }
}
