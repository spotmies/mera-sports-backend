import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { createNotification } from "../services/notificationService.js";
import {
    sendEmailOtp,
    sendMobileOtp,
    verifyEmailOtp,
    verifyMobileOtp
} from "../services/otpService.js";
import { sendRegistrationSuccessEmail } from "../utils/mailer.js";
import { getNextPlayerId } from "../utils/playerIdHelper.js";
import { uploadBase64 } from "../utils/uploadHelper.js";

/* ================= FORGOT PASSWORD ================= */

export const resetPassword = async (req, res) => {
    try {
        const { method, value, newPassword } = req.body;
        if (!method || !value || !newPassword) {
            return res.status(400).json({ message: "Missing reset data" });
        }

        // We assume the frontend verified the OTP right before this call. 
        // In a strictly secure environment, `verifyOtp` would issue a token. 
        // Since we are reusing registration OTPs which do not issue tokens, we will do a direct update.
        let user = null;

        if (method === 'mobile') {
            const { data: mobileUsers } = await supabaseAdmin.from("users").select("id").eq('mobile', value);
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

export const sendRegistrationOtp = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ message: "Email is required" });

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
        if (!mobile || !email) {
            return res.status(400).json({ message: "Mobile and Email are required for check." });
        }

        const calculateAge = (birthDate) => {
            if (!birthDate) return null;
            const birth = new Date(birthDate);
            if (Number.isNaN(birth.getTime())) return null;
            const today = new Date();
            let age = today.getFullYear() - birth.getFullYear();
            const monthDiff = today.getMonth() - birth.getMonth();
            if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) age--;
            return age;
        };

        const requestedAge = calculateAge(dob);
        const isMinorRequest = requestedAge !== null && requestedAge <= 15;

        let query;
        if (aadhaar) {
            query = supabaseAdmin
                .from("users")
                .select("id, mobile, email, aadhaar")
                .or(`mobile.eq.${mobile},email.eq.${email},aadhaar.eq.${aadhaar}`);
        } else {
            query = supabaseAdmin
                .from("users")
                .select("id, mobile, email, aadhaar")
                .or(`mobile.eq.${mobile},email.eq.${email}`);
        }

        const { data: existingUsers, error } = await query;
        if (error) throw error;

        if (existingUsers && existingUsers.length > 0) {
            const existingIds = existingUsers.filter(u => u.mobile == mobile).map(u => u.id);
            const mobileConflict = !isMinorRequest && existingIds.length > 0;

            const conflicts = new Set();
            if (mobileConflict) conflicts.add("Mobile");
            existingUsers.forEach(user => {
                if (user.email == email) conflicts.add("Email");
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
        if (!email) missing.push("Email");

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

        // 3. Duplicate Check (email/aadhaar are unique; mobile can be shared only for age <= 15)
        const { data: duplicates } = await supabaseAdmin
            .from("users")
            .select("id, mobile, email, aadhaar, age, created_at")
            .or(`email.eq.${email}${aadhaar ? `,aadhaar.eq.${aadhaar}` : ''},mobile.eq.${mobile}`);

        let selectedHeadPlayerId = null;

        if (duplicates && duplicates.length > 0) {
            // Email and aadhaar are always unique
            const emailDup = duplicates.find(u => u.email === email);
            const aadhaarDup = aadhaar ? duplicates.find(u => u.aadhaar === aadhaar) : null;
            if (emailDup || aadhaarDup) {
                return res.status(400).json({ message: "User with this Email or Aadhaar already exists." });
            }

            // Mobile: allow duplicate only when new registrant is <= 15
            const mobileMatches = duplicates.filter(u => u.mobile === mobile);
            if (mobileMatches.length > 0) {
                if (age > 15) {
                    return res.status(400).json({ message: "User with this Mobile already exists." });
                }

                const { data: familyRels } = await supabaseAdmin
                    .from("family_relations")
                    .select("head_player_id, of_player_id")
                    .in("of_player_id", mobileMatches.map(u => u.id));

                const familyMemberIds = new Set((familyRels || []).map(r => r.of_player_id));

                const directHeadCandidates = mobileMatches
                    .filter(u => !familyMemberIds.has(u.id) && (u.age == null || Number(u.age) >= 16))
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

                        const adultDerivedHeads = (derivedHeads || []).filter(h => h.age == null || Number(h.age) >= 16);
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
                email,
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
        if (age <= 15 && selectedHeadPlayerId && selectedHeadPlayerId !== newUserId) {
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

        // 10. Send Welcome Email (send the plain-text password, not the hash)
        try {
            await sendRegistrationSuccessEmail(user.email, {
                name: user.name,
                playerId: user.player_id,
                password: plainPassword
            });
        } catch (emailErr) { console.error("Welcome Email Error:", emailErr.message); }

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
                age: user.age
            },
        });
    } catch (err) {
        console.error("REGISTER ERROR:", err);
        res.status(400).json({ message: err.message });
    }
};

/* ================= LOGIN PLAYER ================= */

export const loginPlayer = async (req, res) => {
    try {
        const { playerIdOrAadhaar, password } = req.body;
        if (!playerIdOrAadhaar || !password) return res.status(400).json({ message: "Missing credentials" });

        const input = playerIdOrAadhaar.toString().trim();
        let user = null;
        let resolvedByMobile = false;

        if (input.toUpperCase().startsWith('P')) {
            // Player ID lookup (unique)
            const { data } = await supabaseAdmin.from("users").select("*").eq('player_id', input).maybeSingle();
            user = data;
        } else if (input.includes('@')) {
            // Email lookup (unique)
            const { data } = await supabaseAdmin.from("users").select("*").eq('email', input).maybeSingle();
            user = data;
        } else if (!isNaN(input)) {
            // Could be mobile, aadhaar — try aadhaar first (unique)
            const { data: aadhaarUser } = await supabaseAdmin.from("users").select("*").eq('aadhaar', input).maybeSingle();
            if (aadhaarUser) {
                user = aadhaarUser;
            } else {
                // Try mobile (may return multiple due to family sharing)
                const { data: mobileUsers } = await supabaseAdmin.from("users").select("*").eq('mobile', input);
                if (mobileUsers && mobileUsers.length === 1) {
                    resolvedByMobile = true;
                    const onlyUser = mobileUsers[0];

                    // Block mobile login for family member accounts
                    const { data: relAsMember } = await supabaseAdmin
                        .from("family_relations")
                        .select("id")
                        .eq("of_player_id", onlyUser.id)
                        .maybeSingle();

                    if (relAsMember) {
                        return res.status(403).json({
                            message: "For child/family accounts, login with Player ID or Email only."
                        });
                    }

                    user = onlyUser;
                } else if (mobileUsers && mobileUsers.length > 1) {
                    resolvedByMobile = true;
                    // Multiple users share this mobile — allow login only for head
                    const { data: familyRels } = await supabaseAdmin
                        .from("family_relations")
                        .select("head_player_id, of_player_id")
                        .or(`head_player_id.in.(${mobileUsers.map(u => u.id).join(',')}),of_player_id.in.(${mobileUsers.map(u => u.id).join(',')})`);

                    const headIds = new Set((familyRels || []).map(r => r.head_player_id));
                    const memberIds = new Set((familyRels || []).map(r => r.of_player_id));

                    // Prefer user who is a head and not a member (pure head). Fall back to non-member adult.
                    let headCandidate = mobileUsers.find(u => headIds.has(u.id) && !memberIds.has(u.id));
                    if (!headCandidate) {
                        headCandidate = mobileUsers.find(u => !memberIds.has(u.id) && (u.age == null || Number(u.age) >= 16));
                    }

                    if (!headCandidate) {
                        return res.status(403).json({
                            message: "For child/family accounts, login with Player ID or Email only."
                        });
                    }

                    user = headCandidate;
                }
            }
        } else {
            // Fallback: try player_id or aadhaar
            // Use ilike for case-insensitive matching of player_id (e.g. p1139 vs P1139)
            const { data } = await supabaseAdmin.from("users").select("*").or(`player_id.ilike.${input},aadhaar.eq.${input}`).maybeSingle();
            user = data;
        }

        if (!user) return res.status(401).json({ message: "Invalid credentials" });
        if (user.role !== 'player') return res.status(403).json({ message: "This account is for Admins." });

        // Safety guard: if this login resolved from mobile, never allow family-member account by mobile
        if (resolvedByMobile) {
            const { data: relAsMember } = await supabaseAdmin
                .from("family_relations")
                .select("id")
                .eq("of_player_id", user.id)
                .maybeSingle();

            if (relAsMember) {
                return res.status(403).json({
                    message: "For child/family accounts, login with Player ID or Email only."
                });
            }
        }

        // Bcrypt password comparison
        let isMatch;
        try {
            isMatch = await bcrypt.compare(password, user.password);
        } catch (compareErr) {
            // Log only the error code/type — never the message (could contain hash fragments)
            console.error("PASSWORD COMPARE ERROR [player]:", compareErr?.code || compareErr?.name || "unexpected error");
            return res.status(500).json({ message: "Login failed. Please try again." });
        }
        if (!isMatch) return res.status(401).json({ message: "Invalid credentials" });

        const playerTokenExpiresIn = (() => {
            const raw = process.env.PLAYER_JWT_EXPIRES_IN;
            // Accept only simple duration strings: digits followed by s/m/h/d/w (e.g. 7d, 30m)
            if (raw && /^\d+[smhdw]$/.test(raw)) return raw;
            if (raw) console.warn(`[playerLogin] PLAYER_JWT_EXPIRES_IN "${raw}" is not a valid duration — falling back to "7d"`);
            return "7d";
        })();
        const token = jwt.sign({ id: user.id, role: 'player' }, process.env.JWT_SECRET, { expiresIn: playerTokenExpiresIn });

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                firstName: user.first_name,
                lastName: user.last_name,
                role: 'player',
                photos: user.photos,
                age: user.age
            },
        });
    } catch (err) {
        console.error("LOGIN ERROR:", err);
        res.status(500).json({ message: err.message });
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

export const registerInstitute = async (req, res) => {
    try {
        const { instituteName, email, contactNumber, website, address, password } = req.body || {};

        // Basic validation
        if (!instituteName || !email || !contactNumber || !password) {
            return res.status(400).json({ message: "Missing required fields: Institute Name, Email, Contact Number, or Password" });
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

        if (error || !user) return res.status(401).json({ message: "Invalid credentials" });
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

        if (error || !user) return res.status(404).json({ message: "User not found" });

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
        const { data: { user: authUser }, error: authError } = await supabaseAdmin.auth.getUser(token);
        if (authError || !authUser) return res.status(401).json({ message: "Invalid Google Session" });

        const { data: user } = await supabaseAdmin.from("users").select("*").eq("email", authUser.email).maybeSingle();
        if (!user) return res.status(404).json({ message: "User not found" });

        if (user.verification !== 'rejected') return res.status(400).json({ message: "Account is not in rejected state." });

        await supabaseAdmin.from("users").update({ verification: 'pending' }).eq("id", user.id);
        res.json({ success: true, message: "Re-application submitted successfully." });
    } catch (err) {
        console.error("Re-apply Error:", err);
        res.status(500).json({ message: "Server error" });
    }
};


