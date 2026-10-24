import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { calculateAge, isHeadManaged, MINOR_AGE_LIMIT, resolveAge } from "../utils/age.js";
import { createNotification } from "../services/notificationService.js";
import {
    mobileOtpSessionMatches,
    sendEmailOtp,
    sendMobileOtp,
    verifyEmailOtp,
    verifyMobileOtp
} from "../services/otpService.js";
import { sendRegistrationSuccessEmail } from "../utils/mailer.js";
import { normalizeWhatsAppNumber, sendWelcomeWhatsApp } from "../utils/whatsapp.js";
import { getNextPlayerId } from "../utils/playerIdHelper.js";
import { uploadBase64 } from "../utils/uploadHelper.js";
import { cleanFlatBuildingWing, cleanTshirtSize, normalizeGender } from "../utils/playerProfileFields.js";
import { invalidateDashboardCache } from "../utils/dashboardCache.js";

/* ================= FORGOT PASSWORD ================= */

/**
 * Player forgot-password: step 1 of 3.
 *
 * Unlike /auth/send-otp and /auth/send-mobile-otp (registration OTP senders,
 * which must accept ANY address/number since the person isn't registered
 * yet), this checks the identifier belongs to an existing account BEFORE
 * sending anything. The forgot-password screen used to call those
 * registration endpoints directly, so entering an unregistered mobile number
 * still fired a real WhatsApp OTP — wasted API spend, and no other step in
 * the flow would have refused it either (verify is keyed by session id, and
 * resetPassword's own "user not found" check only runs after OTP verify).
 *
 * Mirrors sendInstituteForgotPasswordOtp below, which solved the same
 * problem for institute accounts; this covers both player OTP channels.
 */
export const sendForgotPasswordOtp = async (req, res) => {
    try {
        const { method, value, userId } = req.body;
        if (!method || !value) {
            return res.status(400).json({ success: false, message: "Method and value are required" });
        }

        if (method === 'mobile') {
            // Same normalization resetPassword uses: registration stores mobile as
            // a bare 10-digit string, but a "+91" prefix or leading 0 is a normal
            // thing to type here.
            const normalized = normalizeWhatsAppNumber(value);
            const bareMobile = normalized ? normalized.slice(2) : String(value).trim();

            // Family accounts share one mobile number (parent + children), so this
            // can legitimately match several rows. .maybeSingle() errors on >1 row,
            // which surfaced as "No account is registered". resetPassword picks the
            // parent account out of the same set.
            const { data: mobileUsers, error: lookupError } = await supabaseAdmin.from("users").select("*").eq("mobile", bareMobile).eq("role", "player");
            if (lookupError) throw lookupError;
            if (!mobileUsers || mobileUsers.length === 0) {
                return res.status(404).json({ success: false, message: "No account is registered with this mobile number." });
            }

            // Shared number: ask which account BEFORE spending an OTP. Nothing is
            // verified yet, so the list is deliberately minimal (name, relation,
            // age) - no player id, photo or contact details.
            if (mobileUsers.length > 1) {
                if (!userId) {
                    const profiles = await withFamilyRelations(mobileUsers);
                    return res.json({
                        success: true,
                        requiresAccountSelection: true,
                        profiles: profiles.map(p => {
                            const summary = toProfileSummary(p);
                            return { id: p.id, name: summary.name, age: summary.age, relation: p.__relation };
                        }),
                    });
                }
                if (!mobileUsers.some(u => u.id === userId)) {
                    return res.status(400).json({ success: false, message: "That account does not use this mobile number." });
                }
            }

            const result = await sendMobileOtp(value);
            return res.json({ success: true, sessionId: result.sessionId, message: "OTP sent to your registered WhatsApp number" });
        }

        if (method === 'email') {
            const email = String(value).trim();
            const { data: user } = await supabaseAdmin.from("users").select("id").eq("email", email).maybeSingle();
            if (!user) {
                return res.status(404).json({ success: false, message: "No account is registered with this email." });
            }

            await sendEmailOtp(email);
            return res.json({ success: true, message: "OTP sent to your registered email" });
        }

        return res.status(400).json({ success: false, message: "Invalid method" });
    } catch (err) {
        console.error("SEND FORGOT PASSWORD OTP ERROR:", err.message);
        res.status(500).json({ success: false, message: "Failed to send OTP. Please try again." });
    }
};

// Verifies a forgot-password OTP and issues a short-lived reset token.
// This is what binds the reset to a proven OTP — resetPassword below refuses
// to run without a valid token, so the reset can never be called directly.
// Labels each account on a shared number as Head or by its family relation, adults first.
const withFamilyRelations = async (users) => {
    const { data: rels } = await supabaseAdmin
        .from("family_relations")
        .select("of_player_id, relation")
        .in("of_player_id", users.map(u => u.id));
    const relById = new Map((rels || []).map(r => [r.of_player_id, r.relation]));
    return users
        .map(u => ({ ...u, __relation: relById.get(u.id) || 'Head' }))
        .sort((x, y) => (resolveAge(y) ?? 0) - (resolveAge(x) ?? 0));
};

export const verifyForgotPasswordOtp = async (req, res) => {
    try {
        const { method, value, otp, sessionId, userId } = req.body;
        if (!method || !value || !otp) {
            return res.status(400).json({ message: "Missing verification data" });
        }

        let verified = false;
        if (method === 'mobile') {
            if (!sessionId) return res.status(400).json({ message: "Missing session. Please resend the OTP." });
            verified = await verifyMobileOtp(sessionId, otp);
        } else if (method === 'email') {
            verified = await verifyEmailOtp(value, otp);
        } else {
            return res.status(400).json({ message: "Invalid method" });
        }

        if (!verified) {
            return res.status(400).json({ success: false, message: "Invalid OTP or session expired" });
        }

        // A mobile number can belong to several accounts (a parent and their
        // children). The OTP only proves control of the number, so the person
        // then chooses which account to reset; the token pins the allowed set so
        // resetPassword cannot be pointed at an unrelated user id.
        let profiles = [];
        if (method === 'mobile') {
            const normalized = normalizeWhatsAppNumber(value);
            const bareMobile = normalized ? normalized.slice(2) : String(value).trim();
            const { data: sharing, error: sharingError } = await supabaseAdmin
                .from("users")
                .select("*")
                .eq("mobile", bareMobile)
                .eq("role", "player");
            if (sharingError) throw sharingError;
            if ((sharing || []).length > 1) {
                const preChosen = userId && sharing.find(u => u.id === userId);
                // Already chosen before the OTP was sent: pin the token to that
                // account only. Otherwise fall back to choosing after verification.
                profiles = preChosen ? [preChosen] : await withFamilyRelations(sharing);
            }
        }

        // Reset token is bound to this exact method+value and expires in 10 minutes
        const resetToken = jwt.sign(
            { type: 'password_reset', method, value, ...(profiles.length > 0 ? { ids: profiles.map(p => p.id) } : {}) },
            process.env.JWT_SECRET,
            { expiresIn: "10m" }
        );

        res.json({
            success: true,
            resetToken,
            ...(profiles.length > 1 ? { requiresAccountSelection: true, profiles: profiles.map(toProfileSummary) } : {}),
        });
    } catch (err) {
        console.error("FORGOT PASSWORD VERIFY OTP ERROR:", err.message);
        res.status(500).json({ success: false, message: "Verification failed" });
    }
};

/**
 * Institute forgot-password: step 1 of 3.
 *
 * Institutes sign in with their email, so this flow is email-only — there is no
 * mobile branch to mirror the player flow's WhatsApp option.
 *
 * Why this exists instead of reusing /auth/send-otp: that endpoint mails an OTP
 * to ANY address without checking it belongs to an account. An institute who
 * mistyped their email would get a code, enter it successfully, and only then
 * hit "User not found" at the reset step — after burning an OTP and two minutes.
 * Checking here fails fast, at the point where the mistake was made.
 *
 * Steps 2 and 3 deliberately reuse the shared /auth/forgot-password/verify-otp
 * and /reset endpoints: users.email is UNIQUE, so resolving by email hits
 * exactly one row. Since an OTP is only ever issued here for an institutehead
 * account, a token from this flow cannot be turned against a player or admin.
 *
 * This reports "no institute account" plainly rather than returning a generic
 * success. loginInstitute already answers the same question to anyone who asks
 * ("This account is not registered as an institute."), so masking it here would
 * cost real usability and buy no secrecy that the login form does not already
 * give away.
 */
export const sendInstituteForgotPasswordOtp = async (req, res) => {
    try {
        // Trim only — deliberately NOT lowercased. Postgres `.eq` is case-sensitive
        // and loginInstitute matches the email exactly as typed, so normalising
        // case here would break password reset for any account registered with a
        // capital letter while its login kept working. The OTP store, the verify
        // step and the reset all key off this same string, so they stay in sync.
        const email = String(req.body?.email || "").trim();
        if (!email) {
            return res.status(400).json({ success: false, message: "Email is required" });
        }

        const { data: user, error } = await supabaseAdmin
            .from("users")
            .select("id, role, verification")
            .eq("email", email)
            .maybeSingle();

        if (error) throw error;

        if (!user || user.role !== "institutehead") {
            return res.status(404).json({
                success: false,
                message: "No institute account is registered with this email."
            });
        }

        // A rejected institute cannot log in even with the correct password, so
        // letting them set a new one would just hand them a working credential
        // for a door that stays shut. Pending accounts are allowed through —
        // they are awaiting approval, not refused.
        if (user.verification === "rejected") {
            return res.status(403).json({
                success: false,
                code: "INSTITUTE_REJECTED",
                message: "Your institute application was rejected. Please contact admin."
            });
        }

        await sendEmailOtp(email);
        res.json({ success: true, message: "OTP sent to your registered email" });

    } catch (err) {
        console.error("INSTITUTE FORGOT PASSWORD OTP ERROR:", err.message);
        res.status(500).json({ success: false, message: "Failed to send OTP. Please try again." });
    }
};

export const resetPassword = async (req, res) => {
    try {
        const { method, value, newPassword, resetToken, userId } = req.body;
        if (!method || !value || !newPassword || !resetToken) {
            return res.status(400).json({ message: "Missing reset data" });
        }
        if (String(newPassword).length < 6) {
            return res.status(400).json({ message: "Password must be at least 6 characters" });
        }

        // Require a valid, unexpired reset token issued by verifyForgotPasswordOtp,
        // bound to the same method+value. Without this the endpoint would let anyone
        // reset any account's password just by knowing its email/mobile.
        let decoded;
        try {
            decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
        } catch {
            return res.status(401).json({ message: "Reset session expired. Please verify OTP again." });
        }
        if (decoded.type !== 'password_reset' || decoded.method !== method || decoded.value !== value) {
            return res.status(401).json({ message: "Invalid reset session. Please verify OTP again." });
        }

        let user = null;

        if (method === 'mobile') {
            // Registration stores mobile as a bare 10-digit string (Register.tsx
            // strips it to exactly that), but nothing stops someone from typing
            // "+91..." or a leading 0 into the forgot-password box — OTP send and
            // verify both tolerate that (WhatsApp delivery normalizes it, and
            // verification is keyed by sessionId, not the number), so the user
            // sails through the whole flow only to hit "User not found" here on a
            // raw string mismatch. Normalize the same way before the lookup.
            const normalized = normalizeWhatsAppNumber(value);
            const bareMobile = normalized ? normalized.slice(2) : value;

            // Shared number: the user chose an account after the OTP step, and the
            // token lists which ones were on offer.
            if (Array.isArray(decoded.ids) && decoded.ids.length > 0) {
                if (!userId || !decoded.ids.includes(userId)) {
                    return res.status(400).json({ message: "Please choose which account to reset." });
                }
                const { data: chosen } = await supabaseAdmin.from("users").select("id").eq("id", userId).maybeSingle();
                if (!chosen) return res.status(404).json({ message: "User not found" });
                user = chosen;
            }

            const { data: mobileUsers } = await supabaseAdmin.from("users").select("id").eq('mobile', bareMobile);
            if (!user) {
            if (!mobileUsers || mobileUsers.length === 0) return res.status(404).json({ message: "User not found" });

            const { data: familyRels } = await supabaseAdmin
                .from("family_relations")
                .select("of_player_id")
                .in("of_player_id", mobileUsers.map(u => u.id));

            const familyMemberIds = new Set((familyRels || []).map(r => r.of_player_id));
            user = mobileUsers.find(u => !familyMemberIds.has(u.id)) || mobileUsers[0];
            }

        } else if (method === 'email') {
            const { data } = await supabaseAdmin.from("users").select("id").eq('email', value).maybeSingle();
            if (!data) return res.status(404).json({ message: "User not found" });
            user = data;
        } else {
            return res.status(400).json({ message: "Invalid method" });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 12);

        const { error } = await supabaseAdmin
            .from("users")
            .update({ password: hashedPassword })
            .eq("id", user.id);

        if (error) throw error;

        res.json({ success: true, message: "Password updated successfully" });

    } catch (err) {
        console.error("RESET PASSWORD ERROR:", err);
        res.status(500).json({ message: "Failed to reset password" });
    }
};

/* ================= SECURITY VERIFICATION (PROFILE UPDATE / PASSWORD CHANGE) ================= */

// Partly hidden address for "OTP sent to ..." copy: ma******@gmail.com / XXXXXX3210.
const maskOtpDestination = (method, value) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (method === "email") {
        const [local, domain] = raw.split("@");
        if (!domain) return raw;
        const shown = local.slice(0, Math.min(2, local.length));
        return `${shown}${"*".repeat(Math.max(local.length - shown.length, 3))}@${domain}`;
    }
    const digits = raw.replace(/\D/g, "");
    if (digits.length <= 4) return digits;
    return "X".repeat(digits.length - 4) + digits.slice(-4);
};

export const sendVerificationOtp = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ message: "No token provided" });
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;

        const { method } = req.body; // 'email' or 'mobile'

        const { data: user, error } = await supabaseAdmin
            .from("users")
            .select("email, mobile")
            .eq("id", userId)
            .maybeSingle();

        if (error || !user) return res.status(404).json({ message: "User not found" });

        if (method === 'mobile') {
            if (!user.mobile) return res.status(400).json({ message: "No mobile number registered" });

            const result = await sendMobileOtp(user.mobile);
            res.json({ success: true, method: 'mobile', sessionId: result.sessionId, sentTo: maskOtpDestination('mobile', user.mobile) });

        } else if (method === 'email') {
            if (!user.email) return res.status(400).json({ message: "No email registered" });

            // Use Supabase Auth logic directly for existing users or our service
            // The service tries to Create, which might not be needed here if they already exist,
            // but signInWithOtp works for existing users too.
            // Let's use the service but wrap error handling if specialized.
            await sendEmailOtp(user.email);
            res.json({ success: true, method: 'email', sentTo: maskOtpDestination('email', user.email) });
        } else {
            res.status(400).json({ message: "Invalid verification method" });
        }

    } catch (err) {
        console.error("SEND VERIFICATION OTP ERROR:", err.message);
        res.status(500).json({ message: "Failed to send verification OTP" });
    }
};

export const verifyVerificationOtp = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ message: "No token provided" });
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;

        const { method, otp, sessionId } = req.body;

        const { data: user } = await supabaseAdmin
            .from("users")
            .select("email")
            .eq("id", userId)
            .maybeSingle();

        let verified = false;

        if (method === 'mobile') {
            verified = await verifyMobileOtp(sessionId, otp);
        } else if (method === 'email') {
            verified = await verifyEmailOtp(user.email, otp);
        }

        if (verified) {
            // Generate SHORT-LIVED Verification Token (5 Minutes)
            const verificationToken = jwt.sign(
                { id: userId, type: 'verification' },
                process.env.JWT_SECRET,
                { expiresIn: "5m" }
            );
            res.json({ success: true, verificationToken });
        } else {
            res.status(400).json({ message: "Invalid OTP" });
        }

    } catch (err) {
        console.error("VERIFY VERIFICATION OTP ERROR:", err);
        res.status(500).json({ message: "Verification failed" });
    }
};

/* ================= OTP ROUTES (REGISTRATION) ================= */

const EMAIL_FORMAT_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const sendRegistrationOtp = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ message: "Email is required" });
        if (typeof email !== "string" || !EMAIL_FORMAT_REGEX.test(email.trim())) {
            return res.status(400).json({ message: "Invalid email address format" });
        }

        await sendEmailOtp(email);
        res.json({ success: true, message: "OTP sent to email" });

    } catch (err) {
        console.error("SEND OTP ERROR:", err.message);
        res.status(500).json({ success: false, message: "Failed to send OTP: " + err.message });
    }
};

export const verifyRegistrationOtp = async (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) return res.status(400).json({ message: "Email and OTP are required" });

        const verified = await verifyEmailOtp(email, otp);

        if (verified) {
            res.json({ success: true, message: "OTP Verified Successfully" });
        } else {
            res.status(400).json({ success: false, message: "Invalid OTP or Session Expired" });
        }
    } catch (err) {
        console.error("VERIFY OTP ERROR:", err.message);
        res.status(500).json({ success: false, message: "Server error during verification" });
    }
};

export const sendMobileRegistrationOtp = async (req, res) => {
    try {
        const { mobile } = req.body;
        const result = await sendMobileOtp(mobile);
        res.json({ success: true, sessionId: result.sessionId, message: "OTP sent to mobile" });
    } catch (err) {
        console.error("SEND MOBILE OTP ERROR:", err.message);
        res.status(500).json({ success: false, message: "Failed to send Mobile OTP" });
    }
};

export const verifyMobileRegistrationOtp = async (req, res) => {
    try {
        const { mobile, otp, sessionId } = req.body;
        // The session must belong to the number being registered — otherwise an
        // OTP from your own phone could "verify" someone else's family number.
        if (!mobileOtpSessionMatches(sessionId, mobile)) {
            return res.status(400).json({ success: false, message: "This OTP was not sent to that mobile number. Please request a new OTP." });
        }
        const verified = await verifyMobileOtp(sessionId, otp);

        if (verified) {
            // Proof for register-player, which requires it to join a number that
            // is already in use.
            const mobileVerificationToken = jwt.sign(
                { type: "mobile_verified", mobile: bareMobileOf(mobile) },
                process.env.JWT_SECRET,
                { expiresIn: "30m" }
            );
            res.json({ success: true, message: "Mobile OTP Verified Successfully", mobileVerificationToken });
        } else {
            res.status(400).json({ success: false, message: "Invalid Mobile OTP" });
        }
    } catch (err) {
        console.error("VERIFY MOBILE OTP ERROR:", err.message);
        res.status(500).json({ success: false, message: "Verification failed" });
    }
};

/* ================= CHECK CONFLICT ================= */

export const checkUserConflict = async (req, res) => {
    try {
        const { mobile, email, aadhaar, dob } = req.body;
        if (!mobile) {
            return res.status(400).json({ message: "Mobile is required for check." });
        }

        // Email is optional for minors, so it only joins the lookup when given.
        // Concatenating an empty value into the filter would produce
        // `email.eq.` and PostgREST rejects the entire `or`, which silently
        // turned every conflict check for an email-less minor into "no
        // conflicts" — including a genuinely duplicate aadhaar.
        const normalizedEmail = email ? email.trim() : null;
        const filters = [`mobile.eq.${mobile}`];
        if (normalizedEmail) filters.push(`email.eq.${normalizedEmail}`);
        if (aadhaar) filters.push(`aadhaar.eq.${aadhaar}`);

        const { data: existingUsers, error } = await supabaseAdmin
            .from("users")
            .select("id, mobile, email, aadhaar, age, dob, role")
            .or(filters.join(','));
        if (error) throw error;

        // A number already in use is not a conflict: anyone may join it, at any
        // age, after a WhatsApp OTP to it, and becomes part of that family.
        // The form uses sharedMobile to insist on the WhatsApp OTP.
        const sharedMobile = (existingUsers || []).some(u => u.mobile == mobile && u.role === 'player');

        if (existingUsers && existingUsers.length > 0) {
            const conflicts = new Set();
            const messages = [];
            existingUsers.forEach(user => {
                if (normalizedEmail && user.email == normalizedEmail) conflicts.add("Email");
                if (aadhaar && user.aadhaar == aadhaar) conflicts.add("Aadhaar");
            });
            for (const field of ["Email", "Aadhaar"]) {
                if (conflicts.has(field)) messages.push(`${field} is already registered.`);
            }

            if (conflicts.size > 0) {
                const conflictList = Array.from(conflicts);
                const fieldStr = conflictList.join(' / ');
                return res.json({
                    conflict: true,
                    conflicts: conflictList,
                    messages,
                    message: `${fieldStr} already exists.`
                });
            }
        }

        res.json({ conflict: false, sharedMobile });

    } catch (err) {
        console.error("CHECK CONFLICT ERROR:", err);
        res.status(500).json({ message: "Server error checking conflicts" });
    }
};

/* ================= SHARED NUMBER = FAMILY ================= */

// Registration stores mobile as a bare 10-digit string.
const bareMobileOf = (value) => {
    const normalized = normalizeWhatsAppNumber(value);
    return normalized ? normalized.slice(2) : String(value || "").trim();
};

// The token verifyMobileRegistrationOtp issues, for this exact number.
const hasVerifiedMobile = (token, mobile) => {
    if (!token) return false;
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        return decoded.type === "mobile_verified" && decoded.mobile === bareMobileOf(mobile);
    } catch {
        return false;
    }
};

// Oldest first; unknown ages last; ties keep the earliest registered.
const oldestFirst = (a, b) =>
    (resolveAge(b) ?? -1) - (resolveAge(a) ?? -1)
    || new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();

// A head's label for a member, guessed from ages: children are 15 or under or
// 15+ years younger, parents 15+ years older, anyone else is "Other" (shown as
// Family). The head can't be asked at signup — they aren't the one signing up.
const guessRelation = (head, member) => {
    const headAge = resolveAge(head);
    const memberAge = resolveAge(member);
    if (memberAge !== null && memberAge <= MINOR_AGE_LIMIT) return "Child";
    if (headAge !== null && memberAge !== null) {
        if (headAge - memberAge >= 15) return "Child";
        if (memberAge - headAge >= 15) return "Parent";
    }
    return "Other";
};

// Family joins on one number run one after another (per server process).
// PostgREST gives no transaction across these writes, so this is what stops
// two simultaneous signups on a number from interleaving their merges.
const mobileJoinQueue = new Map();
const withMobileLock = async (mobile, fn) => {
    const key = bareMobileOf(mobile);
    const previous = mobileJoinQueue.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    mobileJoinQueue.set(key, run);
    try {
        return await run;
    } finally {
        if (mobileJoinQueue.get(key) === run) mobileJoinQueue.delete(key);
    }
};

/**
 * Link a newly registered account into the family of the number it shares.
 *
 * One number = one family, headed by the OLDEST person on it. Every "root" on
 * the number — an existing head, or an account in no family yet — is merged
 * into that family: when someone older than the current head is on the number
 * (a parent signing up after their children, or a parent the children added)
 * they become head and the rest move under them. Members keep their label
 * unless they move to a new head, when it is re-guessed from ages.
 *
 * Adding someone in the Family tab does NOT re-head the family: the person
 * adding stays head, so they can go on adding (a member can't add). The next
 * signup on the number applies the oldest-is-head rule.
 *
 * A head's extra powers (opening members from login, editing, removing) reach
 * only members aged 15 or under; adults in a family manage themselves.
 */
const joinMobileFamily = async (newcomer, onNumber) => {
    const others = onNumber.filter(u => u.id !== newcomer.id);
    if (others.length === 0) return;
    const ids = others.map(u => u.id);

    const { data: memberRels, error: memberRelsError } = await supabaseAdmin
        .from("family_relations")
        .select("head_player_id, of_player_id")
        .in("of_player_id", ids);
    if (memberRelsError) throw memberRelsError;

    const memberIds = new Set((memberRels || []).map(r => r.of_player_id));
    const rootIds = new Set([
        ...(memberRels || []).map(r => r.head_player_id),
        ...others.filter(u => !memberIds.has(u.id)).map(u => u.id),
    ]);
    rootIds.delete(newcomer.id);

    const users = new Map(others.map(u => [u.id, u]));
    const missing = [...rootIds].filter(id => !users.has(id));
    if (missing.length > 0) {
        const { data, error } = await supabaseAdmin.from("users").select("id, age, dob, created_at").in("id", missing);
        if (error) throw error;
        for (const u of data || []) users.set(u.id, u);
    }

    const roots = [...rootIds].map(id => users.get(id)).filter(Boolean);
    // The oldest person on the number, members included: a father a child
    // added in the Family tab still outranks a mother signing up later.
    const head = [newcomer, ...roots, ...others].sort(oldestFirst)[0];
    const touched = new Set([head.id]);

    for (const root of [newcomer, ...roots]) {
        touched.add(root.id);
        if (root.id === head.id) continue;

        // A root that headed a family hands its members over to the new head.
        const { data: moving, error: movingError } = await supabaseAdmin
            .from("family_relations")
            .select("id, of_player_id")
            .eq("head_player_id", root.id);
        if (movingError) throw movingError;
        if ((moving || []).length > 0) {
            const { data: movingUsers, error: movingUsersError } = await supabaseAdmin
                .from("users").select("id, age, dob").in("id", moving.map(r => r.of_player_id));
            if (movingUsersError) throw movingUsersError;
            const byId = new Map((movingUsers || []).map(u => [u.id, u]));
            for (const rel of moving) {
                touched.add(rel.of_player_id);
                // The new head may itself have been this root's member (a
                // signup merged by a concurrent one): drop that row rather
                // than make them their own member.
                const { error } = rel.of_player_id === head.id
                    ? await supabaseAdmin.from("family_relations").delete().eq("id", rel.id)
                    : await supabaseAdmin
                        .from("family_relations")
                        .update({ head_player_id: head.id, relation: guessRelation(head, byId.get(rel.of_player_id)) })
                        .eq("id", rel.id);
                if (error) throw error;
            }
        }

        const { error } = await supabaseAdmin
            .from("family_relations")
            .upsert(
                { head_player_id: head.id, of_player_id: root.id, relation: guessRelation(head, root) },
                { onConflict: "head_player_id,of_player_id" }
            );
        if (error) throw error;
    }

    // Everyone whose Family tab changed. Members already under an unchanged
    // head see the newcomer too, so clear theirs as well.
    const { data: family } = await supabaseAdmin.from("family_relations").select("of_player_id").eq("head_player_id", head.id);
    for (const r of family || []) touched.add(r.of_player_id);
    await Promise.all([...touched].map(id => invalidateDashboardCache(id)));
};

/* ================= REGISTER PLAYER ================= */

export const registerPlayer = async (req, res) => {
    try {
        const {
            firstName, lastName, mobile, email, dob,
            apartment, street, flatBuildingWing, tshirtSize, city, state, pincode, country,
            aadhaar, schoolDetails, photos, isVerified, gender
        } = req.body;

        const missing = [];
        if (!firstName) missing.push("First Name");
        if (!lastName) missing.push("Last Name");
        if (!mobile) missing.push("Mobile");
        if (!dob) missing.push("Date of Birth");
        if (!gender) missing.push("Gender");

        if (missing.length > 0) {
            return res.status(400).json({ message: `Missing required fields: ${missing.join(', ')}` });
        }
        // The signup form offers Male / Female; category eligibility matches on it.
        const normalizedGender = normalizeGender(gender);
        if (!normalizedGender) {
            return res.status(400).json({ message: "Gender must be Male or Female" });
        }

        // 1. Calculate Age
        const calculateAge = (dob) => {
            const birth = new Date(dob);
            const today = new Date();
            let age = today.getFullYear() - birth.getFullYear();
            const m = today.getMonth() - birth.getMonth();
            if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
            return age;
        };
        const age = calculateAge(dob);

        // Email is optional at every age: people joining a family's shared
        // number (parents signing up on their children's phone, say) often
        // have no inbox. When given it must still be unique (checked below).
        const normalizedEmail = email ? email.trim() : null;

        // 2. Generate Password (DDMMYYYY) and hash with bcrypt
        const [year, month, day] = dob.split("-");
        const plainPassword = `${day}${month}${year}`;
        let password;
        try {
            password = await bcrypt.hash(plainPassword, 12);
        } catch (hashErr) {
            console.error("PASSWORD HASH ERROR:", hashErr.message);
            return res.status(500).json({ message: "Failed to secure password. Please try again." });
        }

        // 3. Duplicate Check (email/aadhaar are unique; a mobile already in use
        //    can be joined — any age — with a WhatsApp OTP, and makes family)
        //    Built as a list so an absent email doesn't emit `email.eq.` — an
        //    empty operand makes PostgREST reject the whole filter, which would
        //    skip duplicate detection entirely for every email-less minor.
        const duplicateFilters = [`mobile.eq.${mobile}`];
        if (normalizedEmail) duplicateFilters.push(`email.eq.${normalizedEmail}`);
        if (aadhaar) duplicateFilters.push(`aadhaar.eq.${aadhaar}`);

        const { data: duplicates } = await supabaseAdmin
            .from("users")
            .select("id, mobile, email, aadhaar, age, dob, role, created_at")
            .or(duplicateFilters.join(','));

        // Accounts already on this number; the new account joins their family (6b).
        let mobileMatches = [];

        if (duplicates && duplicates.length > 0) {
            // Email and aadhaar are always unique
            const emailDup = normalizedEmail ? duplicates.find(u => u.email === normalizedEmail) : null;
            const aadhaarDup = aadhaar ? duplicates.find(u => u.aadhaar === aadhaar) : null;
            if (emailDup || aadhaarDup) {
                return res.status(400).json({ message: "User with this Email or Aadhaar already exists." });
            }

            // Mobile already in use: no age limit, but the WhatsApp OTP to that
            // number is mandatory — it is what proves the family let them in.
            mobileMatches = duplicates.filter(u => u.mobile === mobile && u.role === 'player');
            if (mobileMatches.length > 0 && !hasVerifiedMobile(req.body.mobileVerificationToken, mobile)) {
                return res.status(403).json({
                    code: "MOBILE_OTP_REQUIRED",
                    message: "This mobile number is already registered. Verify it with the WhatsApp OTP to join that family.",
                });
            }
        }

        // 4. Upload Image (Using Unified Helper)
        let photoUrl = await uploadBase64(photos, 'player-photos', 'profiles');

        // 5. Generate Player ID
        let newPlayerId;
        try {
            newPlayerId = await getNextPlayerId();
        } catch (idError) {
            console.error("Player ID Generation Error:", idError);
            throw new Error("Failed to generate Player ID.");
        }

        // 6. Insert into USERS table
        const newUserId = crypto.randomUUID();
        const { data: user, error } = await supabaseAdmin
            .from("users")
            .insert({
                id: newUserId,
                player_id: newPlayerId,
                first_name: firstName,
                last_name: lastName,
                name: `${firstName} ${lastName}`.trim(),
                email: normalizedEmail,
                mobile,
                dob,
                age,
                apartment,
                street,
                city,
                state,
                country,
                pincode,
                aadhaar,
                photos: photoUrl,
                password: password,
                role: 'player',
                verification: isVerified ? 'verified' : 'pending',
                gender: normalizedGender,
                // Only sent when filled in, so a database that has not yet run
                // add_flat_building_wing_and_tshirt_size.sql keeps registering
                // players who leave these optional fields blank.
                ...(cleanFlatBuildingWing(flatBuildingWing)
                    ? { flat_building_wing: cleanFlatBuildingWing(flatBuildingWing) }
                    : {}),
                ...(cleanTshirtSize(tshirtSize)
                    ? { tshirt_size: cleanTshirtSize(tshirtSize) }
                    : {})
            })
            .select()
            .maybeSingle();

        if (error) throw error;

        // 6b. Sharing a number makes family. The account is already created, so
        //     a failure here is logged rather than failing the registration.
        if (mobileMatches.length > 0) {
            try {
                // One join per number at a time, reading the number's accounts
                // inside the lock: two people signing up on it at once must not
                // each see a stale list and build two families.
                await withMobileLock(mobile, async () => {
                    const { data: onNumber, error: onNumberError } = await supabaseAdmin
                        .from("users")
                        .select("id, age, dob, role, created_at")
                        .eq("mobile", mobile)
                        .eq("role", "player");
                    if (onNumberError) throw onNumberError;
                    await joinMobileFamily(user, onNumber || []);
                });
            } catch (relationError) {
                console.error("AUTO FAMILY RELATION ERROR:", relationError);
            }
        }

        // 7. Insert School Details
        if (schoolDetails) {
            try {
                // supabase-js reports failures through `error`, not by throwing —
                // without this check a failed insert was silently lost.
                const { error: schoolError } = await supabaseAdmin.from("player_school_details").insert({
                    player_id: user.id,
                    school_name: schoolDetails.name,
                    school_address: schoolDetails.address,
                    school_city: schoolDetails.city,
                    school_pincode: schoolDetails.pincode,
                });
                if (schoolError) console.error("School Details Error:", schoolError);
            } catch (schoolEx) { console.error("School Details Error:", schoolEx); }
        }

        // 8. Generate Token
        const token = jwt.sign(
            { id: user.id, role: 'player' },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        // 10. Send Welcome Email (send the plain-text password, not the hash).
        //     Minors may have no email at all — the WhatsApp message below is
        //     their only delivery of the Player ID and password, and it goes to
        //     the parent's number, which is the intended recipient anyway.
        if (user.email) {
            try {
                await sendRegistrationSuccessEmail(user.email, {
                    name: user.name,
                    playerId: user.player_id,
                    password: plainPassword
                });
            } catch (emailErr) { console.error("Welcome Email Error:", emailErr.message); }
        }

        // 10b. Send Welcome WhatsApp (alongside email, non-blocking)
        try {
            await sendWelcomeWhatsApp(user.mobile, {
                name: user.name,
                playerId: user.player_id,
                password: plainPassword
            });
        } catch (waErr) { console.error("Welcome WhatsApp Error:", waErr.message); }

        res.json({
            success: true,
            token,
            playerId: user.player_id,
            user: {
                id: user.id,
                firstName: user.first_name,
                lastName: user.last_name,
                role: 'player',
                photos: user.photos,
                // dob + gender are needed for category eligibility. Without them
                // the client fell back to the stale `age` column and computed a
                // different birth year than the pages that read the dashboard,
                // so the same player showed Eligible on one screen and Not
                // Eligible on another. Age is derived from dob here.
                dob: user.dob,
                gender: user.gender,
                age: resolveAge(user)
            },
        });
    } catch (err) {
        console.error("REGISTER ERROR:", err);
        res.status(400).json({ message: err.message });
    }
};

/* ================= LOGIN PLAYER ================= */

// A profile-selection token is only good for the few seconds it takes to tap a
// face, and on its own it grants access to nothing.
const PROFILE_SELECTION_TTL = "5m";

const playerTokenExpiresIn = () => {
    const raw = process.env.PLAYER_JWT_EXPIRES_IN;
    // Accept only simple duration strings: digits followed by s/m/h/d/w (e.g. 7d, 30m)
    if (raw && /^\d+[smhdw]$/.test(raw)) return raw;
    if (raw) console.warn(`[playerLogin] PLAYER_JWT_EXPIRES_IN "${raw}" is not a valid duration — falling back to "7d"`);
    return "7d";
};

// The signed-in payload. Shared by password login, profile selection and the
// in-app profile switch so the entry points can never drift apart.
//
// `familyRoot` is the head whose password opened this session, set only when
// the session belongs to someone else (a parent who picked or switched to a
// child). It is what lets the parent switch back; a child who signs in with
// their own password never carries it, so they can only ever be themselves.
const buildPlayerSession = (user, familyRoot = null) => ({
    success: true,
    token: jwt.sign(
        {
            id: user.id,
            role: 'player',
            ...(familyRoot && familyRoot !== user.id ? { family_root: familyRoot } : {}),
        },
        process.env.JWT_SECRET,
        { expiresIn: playerTokenExpiresIn() }
    ),
    user: {
        id: user.id,
        // The client stores this as the session's playerId; it was missing,
        // so pages reading it showed "Unknown" until the dashboard loaded.
        playerId: user.player_id,
        firstName: user.first_name,
        lastName: user.last_name,
        role: 'player',
        photos: user.photos,
        // dob + gender are needed for category eligibility. Without them
        // the client fell back to the stale `age` column and computed a
        // different birth year than the pages that read the dashboard,
        // so the same player showed Eligible on one screen and Not
        // Eligible on another. Age is derived from dob here.
        dob: user.dob,
        gender: user.gender,
        age: resolveAge(user)
    },
});

// Only what the chooser needs to draw a card. Deliberately no email, aadhaar or
// address — this list is rendered before anyone has said who they are.
const toProfileSummary = (user) => ({
    id: user.id,
    player_id: user.player_id,
    name: user.name || `${user.first_name || ""} ${user.last_name || ""}`.trim(),
    photos: user.photos,
    age: resolveAge(user),
    // "Other" is stored for adults who joined by sharing the number.
    relation: user.__relation === 'Other' ? 'Family' : (user.__relation || 'Head'),
});

// Given the accounts a password opened, add the minors linked under any of them
// so a parent sees the whole household in one chooser.
const expandFamilyProfiles = async (matched) => {
    const headIds = matched.map(u => u.id);
    const heads = matched.map(u => ({ ...u, __relation: 'Head' }));

    const { data: relations, error } = await supabaseAdmin
        .from("family_relations")
        .select("of_player_id, relation")
        .in("head_player_id", headIds);

    // This error must not be swallowed. Falling through to `relations || []`
    // collapses the chooser down to the parent alone, which is indistinguishable
    // from "this parent has no children" — the exact failure the feature exists
    // to prevent. Fail loudly so the client retries instead of hiding the kids.
    if (error) throw error;

    const memberIds = [...new Set(
        (relations || []).map(r => r.of_player_id).filter(id => id && !headIds.includes(id))
    )];
    if (memberIds.length === 0) return heads;

    const { data: members, error: membersError } = await supabaseAdmin
        .from("users")
        .select("*")
        .in("id", memberIds);
    if (membersError) throw membersError;

    const relationById = new Map((relations || []).map(r => [r.of_player_id, r.relation]));
    // Only members the head manages open with the head's password. Adults who
    // joined by sharing the number keep their own login (see isHeadManaged).
    const linked = (members || [])
        .filter(m => m.role === 'player' && isHeadManaged(m))
        .map(m => ({ ...m, __relation: relationById.get(m.id) || 'Child' }))
        .sort((a, b) => (resolveAge(b) ?? 0) - (resolveAge(a) ?? 0));

    return [...heads, ...linked];
};

export const loginPlayer = async (req, res) => {
    try {
        const { playerIdOrAadhaar, password } = req.body;
        if (!playerIdOrAadhaar || !password) return res.status(400).json({ message: "Missing credentials" });

        const input = playerIdOrAadhaar.toString().trim();

        // Candidates are every account this identifier could refer to. Only a
        // mobile number can resolve to more than one (a parent and their minors
        // share it) — Player ID, email and aadhaar are unique, so those always
        // yield exactly one account and never raise a profile chooser.
        let candidates = [];
        let resolvedByMobile = false;

        if (input.toUpperCase().startsWith('P')) {
            const { data } = await supabaseAdmin.from("users").select("*").eq('player_id', input).maybeSingle();
            if (data) candidates = [data];
        } else if (input.includes('@')) {
            const { data } = await supabaseAdmin.from("users").select("*").eq('email', input).maybeSingle();
            if (data) candidates = [data];
        } else if (!isNaN(input)) {
            // Could be mobile or aadhaar — aadhaar is unique, so try it first.
            const { data: aadhaarUser } = await supabaseAdmin.from("users").select("*").eq('aadhaar', input).maybeSingle();
            if (aadhaarUser) {
                candidates = [aadhaarUser];
            } else {
                const { data: mobileUsers } = await supabaseAdmin.from("users").select("*").eq('mobile', input);
                if (mobileUsers && mobileUsers.length > 0) {
                    resolvedByMobile = true;
                    candidates = mobileUsers;
                }
            }
        } else {
            // Fallback: case-insensitive player_id (e.g. p1139 vs P1139) or aadhaar
            const { data } = await supabaseAdmin.from("users").select("*").or(`player_id.ilike.${input},aadhaar.eq.${input}`).maybeSingle();
            if (data) candidates = [data];
        }

        if (candidates.length === 0) return res.status(401).json({ message: "Invalid credentials" });

        const playerCandidates = candidates.filter(u => u.role === 'player');
        if (playerCandidates.length === 0) return res.status(403).json({ message: "This account is for Admins." });

        // Match the supplied password against every candidate. Each account
        // carries its own password (default: that person's DOB as DDMMYYYY), so
        // this is what decides *which* person on a shared number is signing in.
        const matched = [];
        for (const candidate of playerCandidates) {
            let isMatch = false;
            try {
                isMatch = await bcrypt.compare(password, candidate.password || "");
            } catch (compareErr) {
                // Log only the error code/type — never the message (could contain hash fragments)
                console.error("PASSWORD COMPARE ERROR [player]:", compareErr?.code || compareErr?.name || "unexpected error");
                return res.status(500).json({ message: "Login failed. Please try again." });
            }
            if (isMatch) matched.push(candidate);
        }

        if (matched.length === 0) return res.status(401).json({ message: "Invalid credentials" });

        // The profile chooser, for mobile logins only. Signing in as the head of
        // a family also unlocks the minors linked under them, so one parent
        // password reaches every child. The reverse is deliberately NOT true: a
        // minor's password only ever opens the minor's own account, otherwise a
        // child who knows their own DOB could walk into the parent's profile.
        let profiles = matched;
        if (resolvedByMobile) {
            profiles = await expandFamilyProfiles(matched);
        }

        if (profiles.length > 1) {
            // Nothing is authenticated yet beyond "this password opened one of
            // these accounts", so the token pins the exact set — otherwise
            // /login/select-profile could be pointed at any user id at all.
            // `heads` are the accounts the password itself matched; anyone else
            // in `ids` was reached through one of them (see selectLoginProfile).
            const selectionToken = jwt.sign(
                { type: 'profile_selection', ids: profiles.map(p => p.id), heads: matched.map(m => m.id) },
                process.env.JWT_SECRET,
                { expiresIn: PROFILE_SELECTION_TTL }
            );
            return res.json({
                success: true,
                requiresProfileSelection: true,
                selectionToken,
                profiles: profiles.map(toProfileSummary),
            });
        }

        return res.json(buildPlayerSession(profiles[0]));
    } catch (err) {
        console.error("LOGIN ERROR:", err);
        res.status(500).json({ message: err.message });
    }
};

/* ================= LOGIN — PROFILE SELECTION ================= */

// Second half of a shared-mobile login: the password already proved which
// household is signing in, this picks which member of it.
export const selectLoginProfile = async (req, res) => {
    try {
        const { selectionToken, userId } = req.body;
        if (!selectionToken || !userId) {
            return res.status(400).json({ message: "Missing profile selection" });
        }

        let decoded;
        try {
            decoded = jwt.verify(selectionToken, process.env.JWT_SECRET);
        } catch {
            return res.status(401).json({ message: "Profile selection expired. Please log in again." });
        }
        if (decoded.type !== 'profile_selection' || !Array.isArray(decoded.ids)) {
            return res.status(401).json({ message: "Invalid profile selection. Please log in again." });
        }

        // The token is the ONLY proof of authentication at this point, so the
        // chosen id has to be one the password actually unlocked. Without this
        // check the endpoint would mint a session for any user id on request.
        if (!decoded.ids.includes(userId)) {
            return res.status(403).json({ message: "That profile is not available on this login." });
        }

        const { data: user } = await supabaseAdmin.from("users").select("*").eq("id", userId).maybeSingle();
        if (!user) return res.status(404).json({ message: "Profile not found" });
        if (user.role !== 'player') return res.status(403).json({ message: "This account is for Admins." });

        // Picking a child from the chooser opens the child's session, but the
        // password belonged to the head — record which one, so the profile
        // switcher can take the parent back. Tokens minted before `heads`
        // existed simply produce a session without a way back.
        let familyRoot = null;
        const heads = Array.isArray(decoded.heads) ? decoded.heads : [];
        if (heads.length > 0 && !heads.includes(userId)) {
            const { data: link, error: linkError } = await supabaseAdmin
                .from("family_relations")
                .select("head_player_id")
                .eq("of_player_id", userId)
                .in("head_player_id", heads)
                .maybeSingle();
            if (linkError) throw linkError;
            familyRoot = link?.head_player_id || null;
        }

        res.json(buildPlayerSession(user, familyRoot));
    } catch (err) {
        console.error("PROFILE SELECT ERROR:", err);
        res.status(500).json({ message: "Failed to open profile" });
    }
};

/* ================= FAMILY PROFILE SWITCH ================= */

// Every profile this session may switch to: the head who signed in, plus the
// members that head manages — exactly the set the login chooser would offer
// them (expandFamilyProfiles). Recomputed on every call, never trusted from the
// client, so removing a member or a child gaining their own email takes effect
// at once. Resolves to [] when the head's account is gone.
const loadSwitchableProfiles = async (sessionUser) => {
    const rootId = sessionUser.family_root || sessionUser.id;
    const { data: root, error } = await supabaseAdmin.from("users").select("*").eq("id", rootId).maybeSingle();
    if (error) throw error;
    if (!root || root.role !== 'player') return { rootId, profiles: [] };
    return { rootId, profiles: await expandFamilyProfiles([root]) };
};

// GET /api/auth/family-profiles
export const getSwitchableProfiles = async (req, res) => {
    try {
        const { profiles } = await loadSwitchableProfiles(req.user);
        res.json({
            success: true,
            currentId: req.user.id,
            profiles: profiles.map(toProfileSummary),
        });
    } catch (err) {
        console.error("FAMILY PROFILES ERROR:", err);
        res.status(500).json({ message: "Failed to load family profiles" });
    }
};

// POST /api/auth/switch-profile  { userId }
export const switchProfile = async (req, res) => {
    try {
        const { userId } = req.body || {};
        if (!userId) return res.status(400).json({ message: "Missing profile" });

        const { rootId, profiles } = await loadSwitchableProfiles(req.user);
        const target = profiles.find(p => p.id === userId);
        if (!target) {
            return res.status(403).json({ message: "That profile is not available to switch to." });
        }

        res.json(buildPlayerSession(target, rootId));
    } catch (err) {
        console.error("PROFILE SWITCH ERROR:", err);
        res.status(500).json({ message: "Failed to switch profile" });
    }
};

/* ================= ADMIN AUTH ================= */

export const registerAdmin = async (req, res) => {
    try {
        const { name, email, mobile, password } = req.body;
        if (!name || !email || !password) return res.status(400).json({ message: "Missing required fields" });

        const { data: existing } = await supabaseAdmin.from("users").select("id").eq("email", email).maybeSingle();
        if (existing) return res.status(400).json({ message: "Admin already exists." });

        const newUserId = crypto.randomUUID();
        const hashedPassword = await bcrypt.hash(password, 12);
        const { error } = await supabaseAdmin.from("users").insert({
            id: newUserId,
            name,
            email,
            mobile,
            password: hashedPassword,
            role: 'admin',
            verification: 'pending'
        });

        if (error) throw error;
        res.json({ success: true, message: "Registration successful. Wait for approval." });

    } catch (err) {
        console.error("ADMIN REGISTER ERROR:", err);
        res.status(500).json({ message: "Registration failed: " + err.message });
    }
};

// Field ceilings mirrored from the register form. The users columns are `text`,
// so without these the API is the only thing between a scripted client and a
// megabyte-long institute name sitting in the database.
const INSTITUTE_LIMITS = {
    instituteName: 100,
    email: 254,
    contactNumber: 10,
    website: 200,
    address: 250,
    password: 64,
};
const PASSWORD_MIN_LENGTH = 6;

export const registerInstitute = async (req, res) => {
    try {
        const raw = req.body || {};

        // Trim before storing. loginInstitute resolves the account with an exact
        // `.eq("email", …)`, so an address saved with a stray leading space would
        // produce an account nobody can ever sign in to.
        const instituteName = String(raw.instituteName || "").trim();
        const email = String(raw.email || "").trim();
        const contactNumber = String(raw.contactNumber || "").replace(/\D/g, "");
        const website = String(raw.website || "").trim();
        const address = String(raw.address || "").trim();
        const password = String(raw.password || "");

        // Presence is checked against what was actually sent, not the stripped
        // number — otherwise a phone of "abcdefghij" strips to "" and gets
        // reported as a missing field instead of an invalid one.
        if (!instituteName || !email || !String(raw.contactNumber || "").trim() || !password) {
            return res.status(400).json({ message: "Missing required fields: Institute Name, Email, Contact Number, or Password" });
        }

        for (const [field, max] of Object.entries(INSTITUTE_LIMITS)) {
            const value = { instituteName, email, contactNumber, website, address, password }[field];
            if (value && value.length > max) {
                return res.status(400).json({ message: `${field} must be ${max} characters or fewer.` });
            }
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ message: "Please provide a valid email address." });
        }

        if (!/^\d{10}$/.test(contactNumber)) {
            return res.status(400).json({ message: "Contact number must be exactly 10 digits." });
        }

        // Was unchecked: registration accepted a 1-character password while
        // resetPassword demands 6, so an institute could create a credential it
        // was then forbidden from restoring.
        if (password.length < PASSWORD_MIN_LENGTH) {
            return res.status(400).json({ message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
        }

        // Check for existing user with that email
        const { data: existing, error: checkError } = await supabaseAdmin.from("users").select("id").eq("email", email).maybeSingle();

        // 503 — Supabase unreachable (outage or network issue)
        if (checkError) {
            const isNetworkError = checkError.message?.includes("fetch failed") || checkError.message?.includes("network") || checkError.code === '';
            if (isNetworkError) {
                console.error("🔴 [RegisterInstitute] Supabase connection error:", checkError.message);
                return res.status(503).json({ message: "Service temporarily unavailable. Please try again shortly." });
            }
        }

        if (existing) return res.status(400).json({ message: "An account already exists with this email." });

        let hashedPassword;
        try {
            hashedPassword = await bcrypt.hash(password, 12);
        } catch (hashErr) {
            console.error("PASSWORD HASH ERROR:", hashErr.message);
            return res.status(500).json({ message: "Failed to secure password. Please try again." });
        }
        const newUserId = crypto.randomUUID();

        // Insert new user into the database
        // Role: 'institutehead', verification: 'pending' — superadmin must approve
        const { error: insertError } = await supabaseAdmin.from("users").insert({
            id: newUserId,
            name: instituteName,
            institute_name: instituteName,
            email: email,
            mobile: contactNumber,
            website: website || null,
            password: hashedPassword,
            role: 'institutehead',
            verification: 'pending',
            apartment: address || null
        });

        if (insertError) {
            const isNetworkError = insertError.message?.includes("fetch failed") || insertError.message?.includes("network") || insertError.code === '';
            if (isNetworkError) {
                console.error("🔴 [RegisterInstitute] Supabase insert failed — connection error:", insertError.message);
                return res.status(503).json({ message: "Service temporarily unavailable. Please try again shortly." });
            }
            throw insertError;
        }

        res.json({ success: true, message: "Registration successful. Please wait for Superadmin approval." });

    } catch (err) {
        console.error("INSTITUTE REGISTER ERROR:", err);
        res.status(500).json({ message: "Registration failed: " + err.message });
    }
};


export const loginInstitute = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ message: "Missing credentials" });

        console.log("🔍 [LoginInstitute] Attempting login for email:", email);

        const { data: user, error } = await supabaseAdmin.from("users").select("*").eq("email", email).maybeSingle();

        // 503 — Supabase connection/network failure (not a user issue)
        if (error) {
            const isNetworkError = error.message?.includes("fetch failed") || error.message?.includes("network") || error.code === '';
            if (isNetworkError) {
                console.log("🔴 [LoginInstitute] SUPABASE CONNECTION ERROR — DB unreachable:", error.message);
                return res.status(503).json({ message: "Service temporarily unavailable. Please try again shortly." });
            }
            console.log("❌ [LoginInstitute] STEP 1 FAILED — DB query error:", error.message);
            return res.status(401).json({ message: "Invalid credentials" });
        }

        // 401 — email not found in DB
        if (!user) {
            console.log("❌ [LoginInstitute] STEP 1 FAILED — No user found with email:", email);
            return res.status(401).json({ message: "This account is not registered as an institute." });
        }

        console.log("✅ [LoginInstitute] STEP 1 PASSED — User found. role:", user.role, "| verification:", user.verification);

        // 401 — role mismatch (not an institute account)
        if (user.role !== 'institutehead') {
            console.log("❌ [LoginInstitute] STEP 2 FAILED — Role mismatch. DB role is:", user.role, "| Expected: institutehead");
            return res.status(401).json({ message: "This account is not registered as an institute." });
        }

        console.log("✅ [LoginInstitute] STEP 2 PASSED — Role is institutehead");

        // Bcrypt password comparison
        let isMatch;
        try {
            isMatch = await bcrypt.compare(password, user.password);
        } catch (compareErr) {
            // Log only the error code/type — never the message (could contain hash fragments)
            console.error("PASSWORD COMPARE ERROR [institute]:", compareErr?.code || compareErr?.name || "unexpected error");
            return res.status(500).json({ message: "Login failed. Please try again." });
        }
        if (!isMatch) {
            console.log("❌ [LoginInstitute] STEP 3 FAILED — Password mismatch");
            return res.status(401).json({ message: "Invalid credentials" });
        }

        console.log("✅ [LoginInstitute] STEP 3 PASSED — Password matched");

        // 403 — account has been rejected by superadmin
        if (user.verification === 'rejected') {
            return res.status(403).json({ success: false, code: 'INSTITUTE_REJECTED', message: "Your application has been rejected." });
        }

        // ✅ Always generate token for valid credentials (pending or verified)
        // Frontend will check the 'status' field to block dashboard access if pending
        const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "30d" });

        // Notify on verified login only
        if (user.verification === 'verified') {
            createNotification(user.id, "Welcome Back!", "Institute login successful.", "info");
        }

        console.log("✅ [LoginInstitute] LOGIN SUCCESS for:", email);

        return res.status(200).json({
            success: true,
            token,
            user: {
                id: user.id,
                instituteName: user.institute_name || user.name,
                email: user.email,
                mobile: user.mobile,
                website: user.website,
                apartment: user.apartment,
                role: user.role,
                status: user.verification   // 'pending' | 'verified' | 'rejected'
            },
        });

    } catch (err) {
        console.error("INSTITUTE LOGIN ERROR:", err);
        res.status(500).json({ message: "Server error during login" });
    }
};

export const loginAdmin = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ message: "Missing credentials" });

        const { data: user, error } = await supabaseAdmin.from("users").select("*").eq("email", email).maybeSingle();

        // Reporting a DB outage as "Invalid credentials" sent admins chasing
        // their password while the real problem was an unreachable database.
        if (error) {
            console.error("ADMIN LOGIN DB ERROR:", error.message || error);
            return res.status(503).json({ message: "Database unavailable, please retry" });
        }
        if (!user) return res.status(401).json({ message: "Invalid credentials" });
        if (user.role !== 'admin' && user.role !== 'superadmin') return res.status(403).json({ message: "Access Denied." });

        // Compare password using bcrypt only.
        // If stored value is not a bcrypt hash (OAuth bootstrap account), enforce OAuth login.
        let adminPasswordMatch = false;
        try {
            adminPasswordMatch = await bcrypt.compare(password, user.password);
        } catch (compareErr) {
            console.error("ADMIN PASSWORD COMPARE ERROR:", compareErr?.message || compareErr);
            return res.status(401).json({
                message: "Password login unavailable for this account. Please sign in with Google."
            });
        }
        if (!adminPasswordMatch) return res.status(401).json({ message: "Invalid credentials" });

        // Verification Checks — block only rejected admins
        // Pending admins get a token so frontend can show PendingApproval page
        if (user.role === 'admin' && user.verification === 'rejected') {
            return res.status(403).json({ success: false, code: 'ADMIN_REJECTED', message: "Application rejected." });
        }

        // Admin tokens last 30 days for convenience (user can still logout manually)
        const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "30d" });

        // Notification & Tracking
        const previous_login = user.last_login || null;
        const last_login = new Date().toISOString();

        await supabaseAdmin.from("users").update({
            previous_login,
            last_login
        }).eq("id", user.id);

        createNotification(user.id, "Welcome Back!", "Administrator login successful.", "info");

        res.json({
            success: true,
            token,
            user: { 
                id: user.id, 
                name: user.name, 
                email: user.email, 
                role: user.role, 
                avatar: user.photos, 
                verification: user.verification,
                last_login,
                previous_login
            },
        });

    } catch (err) {
        console.error("ADMIN LOGIN ERROR:", err);
        res.status(500).json({ message: "Server error during login" });
    }
};

export const getCurrentUser = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ message: "No token provided" });
        const token = authHeader.split(" ")[1];
        if (!token) return res.status(401).json({ message: "No token provided" }); // Double check

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const { data: user, error } = await supabaseAdmin.from("users").select("id, name, email, role, photos, verification, last_login, previous_login, created_at").eq("id", decoded.id).maybeSingle();

        // A database failure is NOT "this user does not exist". Returning 404
        // here told the admin client the account was gone, so it wiped the
        // stored token — which is why an unreachable DB logged you out on every
        // refresh locally while QA and prod, whose DB is up, stayed signed in.
        // 503 is transient: the client keeps the session and retries.
        if (error) {
            console.error("SESSION RESTORE DB ERROR:", error.message || error);
            return res.status(503).json({ message: "Database unavailable, please retry" });
        }
        if (!user) return res.status(404).json({ message: "User not found" });

        res.json({
            success: true,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                avatar: user.photos,
                verification: user.verification,
                last_login: user.last_login,
                previous_login: user.previous_login,
                created_at: user.created_at
            }
        });
    } catch (err) {
        console.error("SESSION RESTORE ERROR:", err.message);
        res.status(401).json({ message: "Invalid or expired token" });
    }
};

export const reapplyGoogleAdmin = async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: "No token provided" });

    try {
        // Verify the Google ID token directly (Supabase Auth removed)
        let payload;
        try {
            const { verifyGoogleIdToken } = await import("../routes/googleSyncRoutes.js");
            payload = await verifyGoogleIdToken(token);
        } catch {
            return res.status(401).json({ message: "Invalid Google Session" });
        }
        if (!payload?.email) return res.status(401).json({ message: "Invalid Google Session" });

        const { data: user } = await supabaseAdmin.from("users").select("*").eq("email", payload.email).maybeSingle();
        if (!user) return res.status(404).json({ message: "User not found" });

        if (user.verification !== 'rejected') return res.status(400).json({ message: "Account is not in rejected state." });

        await supabaseAdmin.from("users").update({ verification: 'pending' }).eq("id", user.id);
        res.json({ success: true, message: "Re-application submitted successfully." });
    } catch (err) {
        console.error("Re-apply Error:", err);
        res.status(500).json({ message: "Server error" });
    }
};


