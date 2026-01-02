import axios from "axios";
import crypto from "crypto";
import express from "express";
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { sendRegistrationSuccessEmail } from "../utils/mailer.js";
// import bcrypt from "bcrypt"; // REMOVED per user request

const router = express.Router();

// --------------------------------------------------------------------------
/* ================= SECURITY VERIFICATION (PROFILE UPDATE / PASSWORD CHANGE) ================= */
// --------------------------------------------------------------------------

router.post("/send-verification-otp", async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ message: "No token provided" });
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;

        const { method } = req.body; // 'email' or 'mobile'

        // Fetch User to get current Mobile/Email (SECURITY: Use stored values, not input)
        const { data: user, error } = await supabaseAdmin
            .from("users")
            .select("email, mobile")
            .eq("id", userId)
            .single();

        if (error || !user) return res.status(404).json({ message: "User not found" });

        if (method === 'mobile') {
            // EXISTING MOBILE LOGIC (2Factor)
            if (!user.mobile) return res.status(400).json({ message: "No mobile number registered" });

            const apiKey = process.env.TWO_FACTOR_API_KEY;
            const otp = Math.floor(100000 + Math.random() * 900000);
            const url = `https://2factor.in/API/V1/${apiKey}/SMS/${user.mobile}/${otp}`;

            console.log(`Sending Mobile Verification OTP to ${user.mobile}`);
            const response = await axios.get(url);
            if (response.data && response.data.Status === "Success") {
                res.json({ success: true, method: 'mobile', sessionId: response.data.Details });
            } else {
                console.error("2Factor Error:", response.data);
                throw new Error("Failed to send SMS OTP");
            }

        } else if (method === 'email') {
            // SUPABASE EMAIL LOGIC
            if (!user.email) return res.status(400).json({ message: "No email registered" });

            console.log(`Sending Email Verification OTP to ${user.email} via Supabase `);
            // Use Supabase Auth for Email OTP
            const { error: otpError } = await supabaseAdmin.auth.signInWithOtp({
                email: user.email,
                // options: { shouldCreateUser: false } // REMOVED: Allow "Shadow" user creation for OTP delivery
            });

            if (otpError) {
                console.error("Supabase Auth Error:", otpError);
                throw otpError;
            }

            res.json({ success: true, method: 'email' });
        } else {
            res.status(400).json({ message: "Invalid verification method" });
        }

    } catch (err) {
        console.error("SEND VERIFICATION OTP ERROR:", err.message);
        res.status(500).json({ message: "Failed to send verification OTP" });
    }
});

router.post("/verify-verification-otp", async (req, res) => {
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
            .single();

        let verified = false;

        if (method === 'mobile') {
            if (!sessionId || !otp) return res.status(400).json({ message: "Missing OTP details" });
            const apiKey = process.env.TWO_FACTOR_API_KEY;
            const url = `https://2factor.in/API/V1/${apiKey}/SMS/VERIFY/${sessionId}/${otp}`;

            const response = await axios.get(url);
            if (response.data && response.data.Status === "Success") {
                verified = true;
            }
        } else if (method === 'email') {
            if (!otp) return res.status(400).json({ message: "Missing OTP" });

            // Verify with Supabase Auth
            const { data: verifyData, error: verifyError } = await supabaseAdmin.auth.verifyOtp({
                email: user.email,
                token: otp,
                type: 'magiclink'
            });

            if (!verifyError && verifyData.session) {
                verified = true;
            } else {
                console.error("Supabase Verify Error:", verifyError);
            }
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
});

/* ================= HELPER: UPLOAD BASE64 TO SUPABASE ================= */
async function uploadImageToSupabase(base64Data) {
    try {
        if (!base64Data || typeof base64Data !== 'string') {

            return null;
        }



        const matches = base64Data.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) {

            return null;
        }

        const extension = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const rawBase64 = matches[2];
        const buffer = Buffer.from(rawBase64, 'base64');
        const filename = `user_${Date.now()}_${Math.floor(Math.random() * 10000)}.${extension}`;

        const { data, error: uploadError } = await supabaseAdmin
            .storage
            .from('player-photos')
            .upload(filename, buffer, {
                contentType: `image/${extension}`,
                upsert: true
            });

        if (uploadError) {
            console.error("❌ UploadImage: Supabase Upload Error:", uploadError);
            throw uploadError;
        }

        const { data: urlData } = supabaseAdmin
            .storage
            .from('player-photos')
            .getPublicUrl(filename);


        return urlData.publicUrl;

    } catch (error) {
        console.error("❌ UPLOAD EXCEPTION:", error.message);
        return null;
    }
}

/* ================= OTP ROUTES (2FACTOR) ================= */
router.post("/send-otp", async (req, res) => {
    try {
        const { mobile } = req.body;
        if (!mobile) return res.status(400).json({ message: "Mobile number is required" });

        const apiKey = process.env.TWO_FACTOR_API_KEY;
        if (!apiKey) {
            console.error("Missing TWO_FACTOR_API_KEY in env");
            return res.status(500).json({ message: "Server configuration error" });
        }

        // Generate 6-digit OTP manually to enforce SMS channel (AUTOGEN sometimes defaults to voice)
        const otp = Math.floor(100000 + Math.random() * 900000);

        // Use the manual OTP endpoint: .../SMS/{mobile}/{otp}
        // This sends the specific OTP via SMS and returns a session ID for verification
        const url = `https://2factor.in/API/V1/${apiKey}/SMS/${mobile}/${otp}`;
        console.log(`Sending Manual OTP ${otp} to ${mobile}`);

        const response = await axios.get(url);

        if (response.data && response.data.Status === "Success") {
            res.json({ success: true, sessionId: response.data.Details });
        } else {
            console.error("2Factor API Error:", response.data);
            res.status(400).json({ success: false, message: "Failed to send OTP" });
        }
    } catch (err) {
        console.error("SEND OTP ERROR:", err.message);
        res.status(500).json({ success: false, message: "Failed to send OTP" });
    }
});

router.post("/verify-otp", async (req, res) => {
    try {
        const { sessionId, otp } = req.body;
        if (!sessionId || !otp) return res.status(400).json({ message: "Session ID and OTP are required" });

        const apiKey = process.env.TWO_FACTOR_API_KEY;
        const url = `https://2factor.in/API/V1/${apiKey}/SMS/VERIFY/${sessionId}/${otp}`;

        const response = await axios.get(url);

        if (response.data && response.data.Status === "Success") {
            res.json({ success: true, message: "OTP Verified Successfully" });
        } else {
            res.status(400).json({ success: false, message: "Invalid OTP" });
        }
    } catch (err) {
        console.error("VERIFY OTP ERROR:", err.message);
        res.status(400).json({ success: false, message: "Invalid OTP or Session Expired" });
    }
});

/* ================= CHECK CONFLICT (PRE-OTP) ================= */
router.post("/check-conflict", async (req, res) => {
    try {
        const { mobile, email, aadhaar } = req.body;
        if (!mobile || !email) {
            return res.status(400).json({ message: "Mobile and Email are required for check." });
        }

        let query = supabaseAdmin
            .from("users")
            .select("id")
            .or(`mobile.eq.${mobile},email.eq.${email}`);

        if (aadhaar) {
            query = supabaseAdmin
                .from("users")
                .select("id")
                .or(`mobile.eq.${mobile},email.eq.${email},aadhaar.eq.${aadhaar}`);
        }

        const { data: existing, error } = await query.maybeSingle();

        if (error) throw error;

        if (existing) {
            return res.json({ conflict: true, message: "User with this Mobile, Email, or Aadhaar already exists." });
        }

        res.json({ conflict: false });

    } catch (err) {
        console.error("CHECK CONFLICT ERROR:", err);
        res.status(500).json({ message: "Server error checking conflicts" });
    }
});

/* ================= REGISTER PLAYER ================= */
router.post("/register-player", async (req, res) => {
    try {
        const {
            firstName,
            lastName,
            mobile,
            email, // Added email
            dob,
            apartment,
            street,
            city,
            state,
            pincode,
            country,
            aadhaar,
            schoolDetails,
            photos,
            isVerified,
            gender // Added Gender field
        } = req.body;

        if (!firstName || !lastName || !mobile || !dob || !email) {
            return res.status(400).json({ message: "Missing required fields" });
        }

        // 1. Calculate Age
        const calculateAge = (dob) => {
            const birth = new Date(dob);
            const today = new Date();
            let age = today.getFullYear() - birth.getFullYear();
            const m = today.getMonth() - birth.getMonth();
            if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) {
                age--;
            }
            return age;
        };
        const age = calculateAge(dob);

        // 2. Generate Password (DDMMYYYY) - PLAINTEXT
        const [year, month, day] = dob.split("-");
        const password = `${day}${month}${year}`;
        // const hashedPassword = await bcrypt.hash(plainPassword, 10); // REMOVED

        // 3. Duplicate Check (Mobile OR Aadhaar OR Email)
        const { data: existing } = await supabaseAdmin
            .from("users")
            .select("id")
            .or(`mobile.eq.${mobile},aadhaar.eq.${aadhaar},email.eq.${email}`)
            .maybeSingle();

        if (existing) {
            return res.status(400).json({ message: "User with this Mobile, Email, or Aadhaar already exists." });
        }

        // 4. Upload Image
        let photoUrl = await uploadImageToSupabase(photos);

        // 5. Generate Player ID (Explicitly from Backend)
        // We call the database function we just created to get the next ID safely.

        const { data: newPlayerId, error: idError } = await supabaseAdmin
            .rpc('get_next_player_id');

        if (idError || !newPlayerId) {
            console.error("RPC Error:", idError);
            throw new Error("Failed to generate Player ID. Ensure 'get_next_player_id' function exists in DB.");
        }


        // 6. Insert into USERS table
        const newUserId = crypto.randomUUID();

        const { data: user, error } = await supabaseAdmin
            .from("users")
            .insert({
                id: newUserId, // Explicitly provide UUID
                player_id: newPlayerId, // P10000X (Explicitly set)
                first_name: firstName,
                last_name: lastName,
                name: `${firstName} ${lastName}`.trim(),
                email, // Use provided email
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
                password: password, // PLAINTEXT
                role: 'player',
                verification: isVerified ? 'verified' : 'pending', // Set based on OTP status
                gender: gender || null // Save gender
            })
            .select()
            .single();

        if (error) throw error;




        // 7. Insert School Details (optional)
        if (schoolDetails) {

            const { error: schoolError } = await supabaseAdmin
                .from("player_school_details")
                .insert({
                    player_id: user.id,
                    school_name: schoolDetails.name,
                    school_address: schoolDetails.address,
                    school_city: schoolDetails.city,
                    school_pincode: schoolDetails.pincode,
                });

            if (schoolError) {
                console.error("SCHOOL DETAILS ERROR:", schoolError);
            }
        }

        // 8. Insert Family Members (Optional)
        const familyMembers = req.body.familyMembers;
        if (familyMembers && Array.isArray(familyMembers) && familyMembers.length > 0) {

            const familyData = familyMembers.map(member => ({
                user_id: user.id,
                name: member.name,
                relation: member.relation || 'Child',
                // dob: member.dob, // REMOVED: Column does not exist
                gender: member.gender,
                // Calculate age from DOB if not provided, or rely on frontend? Better to store DOB primarily.
                // Assuming schema has age column, we can calculate it or just store DOB.
                // Schema has 'age' (int) and 'dob' (date). Let's calculate age.
                age: member.dob ? Math.floor((new Date() - new Date(member.dob)) / 31557600000) : null
            }));

            const { error: familyError } = await supabaseAdmin
                .from("family_members")
                .insert(familyData);

            if (familyError) {
                console.error("FAMILY MEMBERS INSERT ERROR:", familyError);
                // Non-critical, so we log but don't fail registration
            }
        }

        // 9. Generate Token
        const token = jwt.sign(
            { id: user.id, role: 'player' },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        // SEND WELCOME EMAIL
        await sendRegistrationSuccessEmail(user.email, {
            name: user.name,
            playerId: user.player_id,
            password: password
        });

        res.json({
            success: true,
            token,
            playerId: user.player_id, // Return the Linear ID
            user: {
                id: user.id,
                firstName: user.first_name,
                lastName: user.last_name,
                role: 'player',
                photos: user.photos,
                age: user.age // Added Age
            },
        });
    } catch (err) {
        console.error("REGISTER ERROR:", err);
        res.status(400).json({ message: err.message });
    }
});

/* ================= LOGIN PLAYER ================= */
router.post("/login", async (req, res) => {
    try {
        const { playerIdOrAadhaar, password } = req.body;

        if (!playerIdOrAadhaar || !password) {
            return res.status(400).json({ message: "Missing credentials" });
        }

        // 1. Find User by Mobile OR Aadhaar OR Player ID
        let query = supabaseAdmin
            .from("users")
            .select("*")
            .or(`mobile.eq.${playerIdOrAadhaar},aadhaar.eq.${playerIdOrAadhaar}`);

        // If input looks like a number, it might be a Player ID
        // Also check if it starts with 'P' for new format
        const input = playerIdOrAadhaar.toString().trim();
        if (input.toUpperCase().startsWith('P')) {
            query = supabaseAdmin
                .from("users")
                .select("*")
                .eq('player_id', input);
        } else if (!isNaN(input)) {
            query = supabaseAdmin
                .from("users")
                .select("*")
                .or(`mobile.eq.${input},aadhaar.eq.${input},player_id.eq.${input}`);
        }

        const { data: user, error } = await query.single();

        if (error || !user) {
            return res.status(401).json({ message: "Invalid credentials" });
        }

        // 2. Security Check: Strict Separation
        if (user.role !== 'player') {
            return res.status(403).json({
                message: "This account is an Administrator. Please use the Admin Dashboard."
            });
        }

        // 3. Compare Password - PLAINTEXT
        if (user.password !== password) {
            return res.status(401).json({ message: "Invalid credentials" });
        }

        // 4. Generate Token
        const token = jwt.sign(
            { id: user.id, role: 'player' },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                firstName: user.first_name,
                lastName: user.last_name,
                role: 'player',
                photos: user.photos,
                age: user.age // Added Age
            },
        });
    } catch (err) {
        console.error("LOGIN ERROR:", err);
        res.status(500).json({ message: err.message });
    }
});

/* ================= REGISTER ADMIN ================= */
router.post("/register-admin", async (req, res) => {
    try {
        const { name, email, mobile, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ message: "Missing required fields" });
        }

        // 1. Check Existing
        const { data: existing } = await supabaseAdmin
            .from("users")
            .select("id")
            .eq("email", email)
            .maybeSingle();

        if (existing) {
            return res.status(400).json({ message: "Admin with this email already exists." });
        }

        // 2. Insert User (Pending Approval)
        const newUserId = crypto.randomUUID();
        const { data: user, error } = await supabaseAdmin
            .from("users")
            .insert({
                id: newUserId,
                name,
                email,
                mobile,
                password, // Plaintext
                role: 'admin',
                verification: 'pending' // Pending SuperAdmin approval
            })
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, message: "Registration successful. Please wait for Super Admin approval." });

    } catch (err) {
        console.error("ADMIN REGISTER ERROR:", err);
        res.status(500).json({ message: "Registration failed: " + err.message });
    }
});

/* ================= LOGIN ADMIN ================= */
router.post("/login-admin", async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: "Missing credentials" });
        }

        // 1. Find User by Email
        const { data: user, error } = await supabaseAdmin
            .from("users")
            .select("*")
            .eq("email", email)
            .single();

        if (error || !user) {
            return res.status(401).json({ message: "Invalid credentials" });
        }

        // 2. Role Check: Must be Admin or Superadmin
        if (user.role !== 'admin' && user.role !== 'superadmin') {
            return res.status(403).json({
                message: "Access Denied. This login is for Administrators only."
            });
        }

        // 3. Compare Password (PLAINTEXT as per current pattern)
        if (user.password !== password) {
            return res.status(401).json({ message: "Invalid credentials" });
        }

        // 4. Verification Check
        if (user.role === 'admin' && user.verification !== 'verified') {
            if (user.verification === 'rejected') {
                return res.status(403).json({
                    success: false,
                    code: 'ADMIN_REJECTED',
                    message: "Your admin application has been rejected."
                });
            }
            return res.status(403).json({
                success: false,
                code: 'ADMIN_PENDING',
                message: "Account pending approval from Super Admin."
            });
        }

        // 4. Approval Check - REMOVED to allow "Pending Page" access
        // logic moved to frontend AdminLayout

        // 5. Generate Token
        const token = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: "12h" } // 12 hour session for admins
        );

        res.json({
            success: true,
            token,
            user: {
                role: user.role,
                avatar: user.photos,
                verification: user.verification // Added verification
            },
        });

        // NOTIFICATION: Admin Logged In
        createNotification(user.id, "Welcome Back!", "Administrator login successful.", "info");

    } catch (err) {
        console.error("ADMIN LOGIN ERROR:", err);
        res.status(500).json({ message: "Server error during login" });
    }
});

/* ================= GET CURRENT USER (SESSION RESTORE) ================= */
router.get("/me", async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ message: "No token provided" });

        const token = authHeader.split(" ")[1];
        if (!token) return res.status(401).json({ message: "No token provided" });

        // Verify Token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Fetch User
        const { data: user, error } = await supabaseAdmin
            .from("users")
            .select("id, name, email, role, photos, verification")
            .eq("id", decoded.id)
            .single();

        if (error || !user) return res.status(404).json({ message: "User not found" });

        res.json({
            success: true,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                avatar: user.photos,
                verification: user.verification
            }
        });

    } catch (err) {
        console.error("SESSION RESTORE ERROR:", err.message);
        res.status(401).json({ message: "Invalid or expired token" });
    }
});

// POST /api/auth/reapply-google-admin
router.post("/reapply-google-admin", async (req, res) => {
    const { token } = req.body;

    if (!token) return res.status(400).json({ message: "No token provided" });

    try {
        // 1. Verify Google Token via Supabase
        const { data: { user: authUser }, error: authError } = await supabaseAdmin.auth.getUser(token);

        if (authError || !authUser) {
            return res.status(401).json({ message: "Invalid Google Session" });
        }

        const email = authUser.email;

        // 2. Find User in DB
        const { data: user, error } = await supabaseAdmin
            .from("users")
            .select("*")
            .eq("email", email)
            .single();

        if (error || !user) {
            return res.status(404).json({ message: "User not found" });
        }

        // 3. Check Eligibility (Must be rejected)
        if (user.verification !== 'rejected') {
            return res.status(400).json({ message: "Account is not in rejected state." });
        }

        // 4. Update Status to Pending
        const { error: updateError } = await supabaseAdmin
            .from("users")
            .update({ verification: 'pending' })
            .eq("id", user.id);

        if (updateError) throw updateError;

        res.json({ success: true, message: "Re-application submitted successfully." });

    } catch (err) {
        console.error("Re-apply Error:", err);
        res.status(500).json({ message: "Server error during re-application" });
    }
});

export default router;