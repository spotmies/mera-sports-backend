import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { calculateAge, MINOR_AGE_LIMIT, resolveAge } from "../utils/age.js";
import { createNotification } from "../services/notificationService.js";
import {
    sendEmailOtp,
    sendMobileOtp,
    verifyEmailOtp,
    verifyMobileOtp
} from "../services/otpService.js";
import { sendRegistrationSuccessEmail } from "../utils/mailer.js";
import { normalizeWhatsAppNumber, sendWelcomeWhatsApp } from "../utils/whatsapp.js";
import { getNextPlayerId } from "../utils/playerIdHelper.js";
import { uploadBase64 } from "../utils/uploadHelper.js";

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
        const { method, value } = req.body;
        if (!method || !value) {
            return res.status(400).json({ success: false, message: "Method and value are required" });
        }

        if (method === 'mobile') {
            // Same normalization resetPassword uses: registration stores mobile as
            // a bare 10-digit string, but a "+91" prefix or leading 0 is a normal
            // thing to type here.
            const normalized = normalizeWhatsAppNumber(value);
            const bareMobile = normalized ? normalized.slice(2) : String(value).trim();

            const { data: user } = await supabaseAdmin.from("users").select("id").eq("mobile", bareMobile).maybeSingle();
            if (!user) {
                return res.status(404).json({ success: false, message: "No account is registered with this mobile number." });
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
export const verifyForgotPasswordOtp = async (req, res) => {
    try {
        const { method, value, otp, sessionId } = req.body;
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

        // Reset token is bound to this exact method+value and expires in 10 minutes
        const resetToken = jwt.sign(
            { type: 'password_reset', method, value },
            process.env.JWT_SECRET,
            { expiresIn: "10m" }
        );

        res.json({ success: true, resetToken });
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
        const { method, value, newPassword, resetToken } = req.body;
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

            const { data: mobileUsers } = await supabaseAdmin.from("users").select("id").eq('mobile', bareMobile);
            if (!mobileUsers || mobileUsers.length === 0) return res.status(404).json({ message: "User not found" });

            const { data: familyRels } = await supabaseAdmin
                .from("family_relations")
                .select("of_player_id")
                .in("of_player_id", mobileUsers.map(u => u.id));

            const familyMemberIds = new Set((familyRels || []).map(r => r.of_player_id));
            user = mobileUsers.find(u => !familyMemberIds.has(u.id)) || mobileUsers[0];

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
            res.json({ success: true, method: 'mobile', sessionId: result.sessionId });

        } else if (method === 'email') {
            if (!user.email) return res.status(400).json({ message: "No email registered" });

            // Use Supabase Auth logic directly for existing users or our service
            // The service tries to Create, which might not be needed here if they already exist,
            // but signInWithOtp works for existing users too.
            // Let's use the service but wrap error handling if specialized.
            await sendEmailOtp(user.email);
            res.json({ success: true, method: 'email' });
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
        const verified = await verifyMobileOtp(sessionId, otp);

        if (verified) {
            res.json({ success: true, message: "Mobile OTP Verified Successfully" });
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

        const requestedAge = calculateAge(dob);
        const isMinorRequest = requestedAge !== null && requestedAge <= MINOR_AGE_LIMIT;

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
            .select("id, mobile, email, aadhaar")
            .or(filters.join(','));
        if (error) throw error;

        if (existingUsers && existingUsers.length > 0) {
            const existingIds = existingUsers.filter(u => u.mobile == mobile).map(u => u.id);
            const mobileConflict = !isMinorRequest && existingIds.length > 0;

            const conflicts = new Set();
            if (mobileConflict) conflicts.add("Mobile");
            existingUsers.forEach(user => {
                if (normalizedEmail && user.email == normalizedEmail) conflicts.add("Email");
                if (aadhaar && user.aadhaar == aadhaar) conflicts.add("Aadhaar");
            });

            if (conflicts.size > 0) {
                const conflictList = Array.from(conflicts);
                const fieldStr = conflictList.join(' / ');
                return res.json({
                    conflict: true,
                    conflicts: conflictList,
                    message: `${fieldStr} already exists.`
                });
            }
        }

        res.json({ conflict: false });

    } catch (err) {
        console.error("CHECK CONFLICT ERROR:", err);
        res.status(500).json({ message: "Server error checking conflicts" });
    }
};

/* ================= REGISTER PLAYER ================= */

export const registerPlayer = async (req, res) => {
    try {
        const {
            firstName, lastName, mobile, email, dob,
            apartment, street, city, state, pincode, country,
            aadhaar, schoolDetails, photos, isVerified, gender
        } = req.body;

        const missing = [];
        if (!firstName) missing.push("First Name");
        if (!lastName) missing.push("Last Name");
        if (!mobile) missing.push("Mobile");
        if (!dob) missing.push("Date of Birth");

        if (missing.length > 0) {
            return res.status(400).json({ message: `Missing required fields: ${missing.join(', ')}` });
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

        // Email is the adult's identity anchor and the only channel we can reach
        // them on that isn't the shared family mobile, so it stays mandatory for
        // them. A minor riding on a parent's number rarely has an inbox at all —
        // requiring one would cap a household at a single child.
        const normalizedEmail = email ? email.trim() : null;
        if (!normalizedEmail && age > MINOR_AGE_LIMIT) {
            return res.status(400).json({ message: "Missing required fields: Email" });
        }

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

        // 3. Duplicate Check (email/aadhaar are unique; mobile is shareable by minors)
        //    Built as a list so an absent email doesn't emit `email.eq.` — an
        //    empty operand makes PostgREST reject the whole filter, which would
        //    skip duplicate detection entirely for every email-less minor.
        const duplicateFilters = [`mobile.eq.${mobile}`];
        if (normalizedEmail) duplicateFilters.push(`email.eq.${normalizedEmail}`);
        if (aadhaar) duplicateFilters.push(`aadhaar.eq.${aadhaar}`);

        const { data: duplicates } = await supabaseAdmin
            .from("users")
            .select("id, mobile, email, aadhaar, age, created_at")
            .or(duplicateFilters.join(','));

        let selectedHeadPlayerId = null;

        if (duplicates && duplicates.length > 0) {
            // Email and aadhaar are always unique
            const emailDup = normalizedEmail ? duplicates.find(u => u.email === normalizedEmail) : null;
            const aadhaarDup = aadhaar ? duplicates.find(u => u.aadhaar === aadhaar) : null;
            if (emailDup || aadhaarDup) {
                return res.status(400).json({ message: "User with this Email or Aadhaar already exists." });
            }

            // Mobile: allow duplicate only when the new registrant is a minor
            const mobileMatches = duplicates.filter(u => u.mobile === mobile);
            if (mobileMatches.length > 0) {
                if (age > MINOR_AGE_LIMIT) {
                    return res.status(400).json({ message: "User with this Mobile already exists." });
                }

                const { data: familyRels } = await supabaseAdmin
                    .from("family_relations")
                    .select("head_player_id, of_player_id")
                    .in("of_player_id", mobileMatches.map(u => u.id));

                const familyMemberIds = new Set((familyRels || []).map(r => r.of_player_id));

                const directHeadCandidates = mobileMatches
                    .filter(u => !familyMemberIds.has(u.id) && (u.age == null || Number(u.age) > MINOR_AGE_LIMIT))
                    .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime());

                if (directHeadCandidates.length > 0) {
                    selectedHeadPlayerId = directHeadCandidates[0].id;
                } else if ((familyRels || []).length > 0) {
                    const derivedHeadIds = [...new Set((familyRels || []).map(r => r.head_player_id).filter(Boolean))];
                    if (derivedHeadIds.length > 0) {
                        const { data: derivedHeads } = await supabaseAdmin
                            .from("users")
                            .select("id, age, created_at")
                            .in("id", derivedHeadIds)
                            .order("created_at", { ascending: true });

                        const adultDerivedHeads = (derivedHeads || []).filter(h => h.age == null || Number(h.age) > MINOR_AGE_LIMIT);
                        if (adultDerivedHeads.length > 0) {
                            selectedHeadPlayerId = adultDerivedHeads[0].id;
                        }
                    }
                }
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
                gender: gender || null
            })
            .select()
            .maybeSingle();

        if (error) throw error;

        // 6b. For minors sharing a mobile, auto-link under selected head as Child
        if (age <= MINOR_AGE_LIMIT && selectedHeadPlayerId && selectedHeadPlayerId !== newUserId) {
            const { error: relationError } = await supabaseAdmin
                .from("family_relations")
                .upsert(
                    {
                        head_player_id: selectedHeadPlayerId,
                        of_player_id: newUserId,
                        relation: "Child"
                    },
                    { onConflict: "head_player_id,of_player_id" }
                );

            if (relationError) {
                console.error("AUTO FAMILY RELATION ERROR:", relationError);
            }
        }

        // 7. Insert School Details
        if (schoolDetails) {
            try {
                await supabaseAdmin.from("player_school_details").insert({
                    player_id: user.id,
                    school_name: schoolDetails.name,
                    school_address: schoolDetails.address,
                    school_city: schoolDetails.city,
                    school_pincode: schoolDetails.pincode,
                });
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

// The signed-in payload. Shared by password login and profile selection so the
// two entry points can never drift apart.
const buildPlayerSession = (user) => ({
    success: true,
    token: jwt.sign({ id: user.id, role: 'player' }, process.env.JWT_SECRET, { expiresIn: playerTokenExpiresIn() }),
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

// Only what the chooser needs to draw a card. Deliberately no email, aadhaar or
// address — this list is rendered before anyone has said who they are.
const toProfileSummary = (user) => ({
    id: user.id,
    player_id: user.player_id,
    name: user.name || `${user.first_name || ""} ${user.last_name || ""}`.trim(),
    photos: user.photos,
    age: resolveAge(user),
    relation: user.__relation || 'Head',
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
    const linked = (members || [])
        .filter(m => m.role === 'player')
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
            const selectionToken = jwt.sign(
                { type: 'profile_selection', ids: profiles.map(p => p.id) },
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

        res.json(buildPlayerSession(user));
    } catch (err) {
        console.error("PROFILE SELECT ERROR:", err);
        res.status(500).json({ message: "Failed to open profile" });
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
        const { data: user, error } = await supabaseAdmin.from("users").select("id, name, email, role, photos, verification, last_login, previous_login").eq("id", decoded.id).maybeSingle();

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
                previous_login: user.previous_login
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


