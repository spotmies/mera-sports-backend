import crypto from "crypto";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { redis, isRedisReady } from "../config/redisClient.js";
import { sendOtpEmail } from "../utils/mailer.js";
import { sendOtpWhatsApp } from "../utils/whatsapp.js";

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_TTL_S = Math.ceil(OTP_TTL_MS / 1000);

// In-memory fallback — used only when neither Redis nor the `otp_sessions` table
// is available. The Redis/DB stores keep OTPs valid across backend restarts and
// multiple instances.
const memStore = new Map();

const redisOtpKey = (channel, key) => `otp:${channel}:${key}`;

/**
 * Persist an OTP for a given channel + key (sessionId for mobile, email for email).
 * Storage precedence: Redis (native TTL) → Supabase → in-memory.
 */
async function storeOtp(channel, key, otp) {
    const now = Date.now();

    // 1. Redis — auto-expires via TTL (no cleanup job), shared across instances.
    if (isRedisReady()) {
        try {
            await redis.set(redisOtpKey(channel, key), String(otp), "EX", OTP_TTL_S);
            return;
        } catch (err) {
            console.warn(`OTP store: Redis failed, falling back to DB (${err.message})`);
        }
    }

    // 2. Supabase/Postgres fallback.
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
 * Verify an OTP for a channel + key. Consumes (deletes) the record on success so
 * it can't be reused; leaves it in place on a wrong guess for retries. Expiry is
 * handled by Redis TTL (a missing key = expired). Checks Redis → DB → in-memory.
 * @returns {Promise<boolean>}
 */
async function consumeOtp(channel, key, otp) {
    // 1. Redis first.
    if (isRedisReady()) {
        try {
            const stored = await redis.get(redisOtpKey(channel, key));
            if (stored !== null) {
                const match = stored === String(otp);
                if (match) await redis.del(redisOtpKey(channel, key)); // consume on success only
                return match;
            }
            // Not in Redis (expired, or stored before Redis was enabled) → fall through.
        } catch (err) {
            console.warn(`OTP verify: Redis error, checking DB (${err.message})`);
        }
    }

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
 * Sends a Mobile OTP via WhatsApp (self-generated OTP, verified against our store).
 * @param {string} mobile - Mobile number
 * @returns {Promise<{success: boolean, sessionId: string}>}
 * @throws if the WhatsApp send is not accepted
 */
export async function sendMobileOtp(mobile) {
    if (!mobile) throw new Error("Mobile number is required");

    // crypto.randomInt is cryptographically secure (unlike Math.random) → unpredictable OTPs
    const otp = crypto.randomInt(100000, 1000000);

    const sent = await sendOtpWhatsApp(mobile, otp);
    if (!sent) {
        throw new Error("Failed to send WhatsApp OTP. Make sure the number is registered on WhatsApp.");
    }

    const sessionId = `wa_${crypto.randomUUID()}`;
    await storeOtp("mobile", sessionId, otp);
    return { success: true, sessionId };
}

/**
 * Verifies a Mobile OTP against the shared store.
 * @param {string} sessionId - Session ID from send step
 * @param {string} otp - OTP entered by user
 * @returns {Promise<boolean>}
 */
export async function verifyMobileOtp(sessionId, otp) {
    if (!sessionId || !otp) throw new Error("Session ID and OTP are required");
    return consumeOtp("mobile", sessionId, otp);
}

/**
 * Sends an Email OTP using Custom NodeMailer to avoid rate limits
 * @param {string} email
 */
export async function sendEmailOtp(email) {
    if (!email) throw new Error("Email is required");

    try {
        const otp = String(crypto.randomInt(100000, 1000000));

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
