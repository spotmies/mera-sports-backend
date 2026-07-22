import axios from "axios";
import crypto from "crypto";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { sendOtpEmail } from "../utils/mailer.js";
import { sendOtpWhatsApp } from "../utils/whatsapp.js";

// In-memory store for custom email OTPs
const emailOtpStore = new Map();

// In-memory store for WhatsApp mobile OTPs (sessionId -> { otp, expiresAt })
const mobileOtpStore = new Map();

const TWO_FACTOR_API_KEY = process.env.TWO_FACTOR_API_KEY || "e6b3f27c-da5e-11f0-a6b2-0200cd936042";

/**
 * Sends a Mobile OTP — WhatsApp first, 2Factor.in SMS as fallback
 * @param {string} mobile - Mobile number
 * @returns {Promise<{success: boolean, sessionId?: string, message?: string}>}
 */
export async function sendMobileOtp(mobile) {
    if (!mobile) throw new Error("Mobile number is required");

    const otp = Math.floor(100000 + Math.random() * 900000);

    // Primary channel: WhatsApp (self-generated OTP, verified locally)
    try {
        const sent = await sendOtpWhatsApp(mobile, otp);
        if (sent) {
            const sessionId = `wa_${crypto.randomUUID()}`;
            mobileOtpStore.set(sessionId, {
                otp: String(otp),
                expiresAt: Date.now() + 10 * 60 * 1000 // 10 mins expiry
            });
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
 * Verifies a Mobile OTP — local store for WhatsApp sessions, 2Factor.in for SMS sessions
 * @param {string} sessionId - Session ID from send step
 * @param {string} otp - OTP entered by user
 * @returns {Promise<boolean>}
 */
export async function verifyMobileOtp(sessionId, otp) {
    if (!sessionId || !otp) throw new Error("Session ID and OTP are required");

    // WhatsApp OTP session — verify against local store
    if (sessionId.startsWith("wa_")) {
        const record = mobileOtpStore.get(sessionId);
        if (!record) return false;

        if (Date.now() > record.expiresAt) {
            mobileOtpStore.delete(sessionId); // expired
            return false;
        }

        if (record.otp === String(otp)) {
            mobileOtpStore.delete(sessionId); // used successfully
            return true;
        }
        return false;
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
        
        emailOtpStore.set(email, {
            otp,
            expiresAt: Date.now() + 10 * 60 * 1000 // 10 mins expiry
        });

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
        const record = emailOtpStore.get(email);
        if (!record) return false;

        if (Date.now() > record.expiresAt) {
            emailOtpStore.delete(email); // expired
            return false;
        }

        if (record.otp === otp) {
            emailOtpStore.delete(email); // used successfully
            return true;
        }

        return false;
    } catch (err) {
        console.error("Service: verifyEmailOtp Error:", err.message);
        return false;
    }
}
