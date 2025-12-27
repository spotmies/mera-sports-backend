import express from "express";
// import bcrypt from "bcrypt"; // REMOVED
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { verifyPlayer } from "../middleware/rbacMiddleware.js";

const router = express.Router();

/* ================= HELPER: UPLOAD BASE64 TO SUPABASE ================= */
async function uploadImageToSupabase(base64Data) {
    try {
        if (!base64Data || typeof base64Data !== 'string') {
            return null;
        }

        // If it's already a URL, return it
        if (base64Data.startsWith('http')) {
            return base64Data;
        }

        const matches = base64Data.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) {
            console.log("❌ UploadImage: Regex match failed.");
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

// --------------------------------------------------------------------------
// GET PLAYER PROFILE
// Used by: Player App -> Dashboard
// --------------------------------------------------------------------------
router.get("/dashboard", verifyPlayer, async (req, res) => {
    try {
        const userId = req.user.id;

        const { data: player, error } = await supabaseAdmin
            .from("users") // Changed from 'players' to 'users'
            .select("*")
            .eq("id", userId)
            .single();

        if (error) throw error;
        if (!player) return res.status(404).json({ message: "Player not found" });

        // Fetch School Details (if available)
        const { data: schoolDetails } = await supabaseAdmin
            .from("player_school_details")
            .select("*")
            .eq("player_id", userId)
            .maybeSingle();

        if (schoolDetails) {
            player.schoolDetails = schoolDetails;
        }

        // Fetch Event Registrations with Details
        // Fetch Event Registrations with Details (Individual + Team Based)

        // 1. Get User Details needed for matching team members
        const { data: userDetails } = await supabaseAdmin
            .from("users")
            .select("mobile, player_id")
            .eq("id", userId)
            .single();

        const userMobile = userDetails?.mobile;
        const userPlayerId = userDetails?.player_id; // Human readable ID

        console.log("DEBUG DASHBOARD 1: User Identity", { userId, userMobile, userPlayerId });

        // 2. Find IDs of teams where user is Captain OR Member
        let relevantTeamIds = [];

        // 2a. Teams where Captain
        const { data: captainTeams } = await supabaseAdmin
            .from("player_teams")
            .select("id")
            .eq("captain_id", userId);

        if (captainTeams) relevantTeamIds.push(...captainTeams.map(t => t.id));

        // 2b. Teams where Member (if mobile or player_id matches in JSONB)
        if (userMobile) {
            const { data: memberTeamsMobile } = await supabaseAdmin
                .from("player_teams")
                .select("id")
                .contains("members", [{ mobile: userMobile }]); // Assuming members array has objects with mobile
            if (memberTeamsMobile) relevantTeamIds.push(...memberTeamsMobile.map(t => t.id));
        }

        if (userPlayerId) {
            // FALLBACK: Fetch all teams and filter in JS (to avoid JSON type errors)
            const { data: allTeams, error: teamsError } = await supabaseAdmin
                .from("player_teams")
                .select("id, members");

            if (teamsError) {

            } else if (allTeams) {
                // Filter in Memory
                const joinedTeams = allTeams.filter(team => {
                    const members = team.members;
                    if (Array.isArray(members)) {
                        return members.some(m => m.player_id === userPlayerId);
                    }
                    return false;
                });

                if (joinedTeams.length > 0) {
                    relevantTeamIds.push(...joinedTeams.map(t => t.id));
                }
            }
        }
        // Deduplicate Team IDs
        relevantTeamIds = [...new Set(relevantTeamIds)];

        // 3. Fetch Registrations (User's OR User's Teams)
        let query = supabaseAdmin
            .from("event_registrations")
            .select(`*, events ( id, name, sport, start_date, location )`)
            .order('created_at', { ascending: false });

        if (relevantTeamIds.length > 0) {
            // OR logic: player_id == userId OR team_id IN relevantTeamIds
            // Supabase .or() syntax: "player_id.eq.UID,team_id.in.(TID1,TID2)"
            const teamIdsString = relevantTeamIds.join(',');
            query = query.or(`player_id.eq.${userId},team_id.in.(${teamIdsString})`);
        } else {
            query = query.eq("player_id", userId);
        }

        const { data: registrations, error: regError } = await query;
        console.log("🔍 Debug Dashboard Teams:", {
            userId,
            userMobile,
            userPlayerId,
            relevantTeamIds,
            regCount: registrations?.length,
            regError
        });

        // Fetch Transactions (Manual Merge to avoid FK issues) - Fetch for User AND Teams potentially?
        // Transactions are usually user-linked. Team exams might be paid by captain. 
        // If I am a member, I might not see the transaction if I didn't pay. 
        // But I should see the key 'registered' status.
        // For now, keep transaction fetch limited to user_id to avoid leaking captain's transaction data to member?
        // Or fetch if related to the registration?
        // Let's stick to user_id for transactions for now. Team members just need to see they are registered.

        const { data: transactions, error: txError } = await supabaseAdmin
            .from("transactions")
            .select("*")
            .eq("user_id", userId);

        // Fetch Family Members
        const { data: familyMembers, error: familyError } = await supabaseAdmin
            .from("family_members")
            .select("*")
            .eq("user_id", userId);

        if (familyError) {
            console.error("Error fetching family members:", familyError);
        }

        // Merge Data
        const detailedRegistrations = await Promise.all((registrations || []).map(async (reg) => {
            // Try matching by transaction_id first, then fallback to event_id
            const txn = (transactions || []).find(t =>
                (reg.transaction_id && t.id === reg.transaction_id) ||
                (t.event_id === reg.event_id)
            );

            // Fetch Team Details if team_id exists
            let teamDetails = null;
            if (reg.team_id) {
                const { data: team } = await supabaseAdmin
                    .from("player_teams")
                    .select("*")
                    .eq("id", reg.team_id)
                    .single();
                if (team) {
                    teamDetails = team;
                }
            }

            return {
                ...reg,
                transactions: txn || null,
                team_details: teamDetails // Attach detailed team info
            };
        }));

        res.json({ success: true, player, registrations: detailedRegistrations, familyMembers: familyMembers || [] });

    } catch (err) {
        console.error("DASHBOARD ERROR:", err);
        res.status(500).json({ message: "Failed to load dashboard" });
    }
});

// --------------------------------------------------------------------------
// CHECK CONFLICT (Pre-verification)
// --------------------------------------------------------------------------
router.post("/check-conflict", verifyPlayer, async (req, res) => {
    try {
        const userId = req.user.id;
        const { email, mobile } = req.body;

        if (email) {
            const { data: conflictEmail } = await supabaseAdmin
                .from("users")
                .select("id")
                .eq("email", email)
                .neq("id", userId)
                .maybeSingle(); // Changed to maybeSingle to handle no rows gracefully
            if (conflictEmail) return res.status(409).json({ conflict: true, field: 'email', message: "Email already taken" });
        }

        if (mobile) {
            const { data: conflictMobile } = await supabaseAdmin
                .from("users")
                .select("id")
                .eq("mobile", mobile)
                .neq("id", userId)
                .maybeSingle();
            if (conflictMobile) return res.status(409).json({ conflict: true, field: 'mobile', message: "Mobile already taken" });
        }

        res.json({ conflict: false });
    } catch (err) {
        console.error("CHECK CONFLICT ERROR:", err);
        res.status(500).json({ message: "Server error" });
    }
});

// --------------------------------------------------------------------------
// CHECK PASSWORD (Pre-verification)
// --------------------------------------------------------------------------
router.post("/check-password", verifyPlayer, async (req, res) => {
    try {
        const userId = req.user.id;
        const { currentPassword } = req.body;

        if (!currentPassword) return res.status(400).json({ message: "Password required" });

        const { data: user } = await supabaseAdmin
            .from("users")
            .select("password")
            .eq("id", userId)
            .single();

        if (!user || user.password !== currentPassword) {
            return res.status(401).json({ correct: false, message: "Incorrect password" });
        }

        res.json({ correct: true });
    } catch (err) {
        console.error("CHECK PASSWORD ERROR:", err);
        res.status(500).json({ message: "Server error" });
    }
});

// ... inside route ...
router.put("/update-profile", verifyPlayer, async (req, res) => {
    try {
        const userId = req.user.id;

        const {
            email,
            mobile,
            photos,
            apartment,
            street,
            city,
            state,
            pincode,
            country
        } = req.body;

        // --- SECURITY: Require Verification Token if Email or Mobile is changing ---
        // 1. Fetch current data (ALL fields) to ensure safe UPSERT later
        const { data: currentUser, error: userError } = await supabaseAdmin
            .from("users")
            .select("*")
            .eq("id", userId)
            .single();

        if (userError || !currentUser) return res.status(404).json({ message: "User not found" });

        const isSensitiveChange = (email && email.toLowerCase().trim() !== currentUser.email.toLowerCase().trim()) || (mobile && mobile !== currentUser.mobile);

        if (isSensitiveChange) {
            const verificationToken = req.headers['x-verification-token'];
            if (!verificationToken) {
                return res.status(403).json({
                    message: "Verification required for updating Email or Mobile.",
                    requiresVerification: true
                });
            }
            try {
                // Verify the SHORT-LIVED token
                const decoded = jwt.verify(verificationToken, process.env.JWT_SECRET);
                if (decoded.id !== userId || decoded.type !== 'verification') {
                    throw new Error("Invalid token type");
                }
            } catch (tokenErr) {
                return res.status(403).json({ message: "Invalid or expired verification token." });
            }
        }
        // --------------------------------------------------------------------------

        // --- CONFLICT CHECK: Ensure Email/Mobile is unique ---
        // (Same logic as before)
        if (email && email.toLowerCase().trim() !== currentUser.email.toLowerCase().trim()) {
            const { data: conflictEmail } = await supabaseAdmin
                .from("users")
                .select("id")
                .eq("email", email)
                .neq("id", userId)
                .maybeSingle();

            if (conflictEmail) return res.status(409).json({ message: "Email is already in use." });
        }

        if (mobile && mobile !== currentUser.mobile) {
            const { data: conflictMobile } = await supabaseAdmin
                .from("users")
                .select("id")
                .eq("mobile", mobile)
                .neq("id", userId)
                .maybeSingle();

            if (conflictMobile) return res.status(409).json({ message: "Mobile number is already in use." });
        }
        // -----------------------------------------------------

        // Handle Photo Upload
        let finalPhotoUrl = photos;
        if (photos && photos.startsWith('data:image')) {
            const uploadedUrl = await uploadImageToSupabase(photos);
            if (uploadedUrl) finalPhotoUrl = uploadedUrl;
        }

        // --- ORCHESTRATION: Update Supabase Auth if Email Changes ---
        // REMOVED: Custom Auth architecture does not sync with Supabase Auth users.
        // OTPs will handle "shadow" user creation if needed.
        // -------------------------------------------------------------

        // STRICT UPDATE STRATEGY
        // Only include fields that are actually allowed to be updated.
        const updatePayload = {
            email: email || currentUser.email,
            mobile: mobile || currentUser.mobile,
            apartment: apartment !== undefined ? apartment : currentUser.apartment,
            street: street !== undefined ? street : currentUser.street,
            city: city !== undefined ? city : currentUser.city,
            state: state !== undefined ? state : currentUser.state,
            pincode: pincode !== undefined ? pincode : currentUser.pincode,
            country: country !== undefined ? country : currentUser.country,
            photos: finalPhotoUrl || currentUser.photos
        };

        console.log("🛠️ DEBUG: Update Profile Payload:", updatePayload);

        // Check if user exists before update (Debug RLS/Existence)
        const { data: checkUser, error: checkError } = await supabaseAdmin
            .from("users")
            .select("id, email")
            .eq("id", userId);

        console.log("🔎 Debug Fetch User:", checkUser ? `Found ${checkUser.length}` : "Not Found", checkError || "");

        // Perform Update
        const { data: updatedPlayer, error } = await supabaseAdmin
            .from("users")
            .update(updatePayload)
            .eq("id", userId)
            .select();

        if (error) {
            console.error("❌ Update Error Details:", error);
            throw error;
        }

        console.log("🛠️ DEBUG Update Result:", updatedPlayer ? updatedPlayer.length : "null");

        // If no rows returned, it means either:
        // 1. User not found (unlikely as we checked)
        // 2. No fields actually changed (Supabase/Postgres might return empty)
        // In this case, we return the currentUser merged with updates.
        let playerObj = (updatedPlayer && updatedPlayer.length > 0) ? updatedPlayer[0] : { ...currentUser, ...updatePayload };

        if (!updatedPlayer || updatedPlayer.length === 0) {
            console.warn("⚠️ Warning: Update returned 0 rows. This might mean no values changed or RLS/Trigger blocked it.");
        }

        res.json({ success: true, player: playerObj, message: "Profile updated successfully" });

    } catch (err) {
        console.error("UPDATE ERROR:", err);
        res.status(500).json({ message: "Failed to update profile" });
    }
});

// --------------------------------------------------------------------------
// CHANGE PASSWORD
// Used by: Player App -> Change Password
// --------------------------------------------------------------------------
router.put("/change-password", verifyPlayer, async (req, res) => {
    try {
        const userId = req.user.id;
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: "All fields are required" });
        }

        // --- SECURITY: Require Verification Token ALWAYS for Password Change ---
        const verificationToken = req.headers['x-verification-token'];
        if (!verificationToken) {
            return res.status(403).json({
                message: "Verification required for changing password.",
                requiresVerification: true
            });
        }
        try {
            const decoded = jwt.verify(verificationToken, process.env.JWT_SECRET);
            if (decoded.id !== userId || decoded.type !== 'verification') {
                throw new Error("Invalid token type");
            }
        } catch (tokenErr) {
            return res.status(403).json({ message: "Invalid or expired verification token." });
        }
        // -----------------------------------------------------------------------

        // 1. Fetch current password
        const { data: player, error: fetchError } = await supabaseAdmin
            .from("users")
            .select("password")
            .eq("id", userId)
            .single();

        if (fetchError || !player) {
            return res.status(404).json({ message: "User not found" });
        }

        // 2. Verify Old Password (PLAINTEXT)
        // const match = await bcrypt.compare(currentPassword, player.password);
        if (player.password !== currentPassword) {
            return res.status(401).json({ message: "Incorrect current password" });
        }

        // 3. Hash New Password --> PLAINTEXT
        // const hashedNewPassword = await bcrypt.hash(newPassword, 10);
        const newPasswordPlain = newPassword;

        // 4. Update
        const { error: updateError } = await supabaseAdmin
            .from("users")
            .update({ password: newPasswordPlain })
            .eq("id", userId);

        if (updateError) throw updateError;

        res.json({ success: true, message: "Password updated successfully" });

    } catch (err) {

        res.status(500).json({ message: "Failed to update password" });
    }
});

// --------------------------------------------------------------------------
// DELETE ACCOUNT
// Used by: Player App -> Delete Account
// --------------------------------------------------------------------------
router.delete("/delete-account", verifyPlayer, async (req, res) => {
    try {
        const userId = req.user.id;
        console.log(`⚠️ User ${userId} requested account deletion`);

        // 1. Delete School Details
        const { error: schoolError } = await supabaseAdmin
            .from("player_school_details")
            .delete()
            .eq("player_id", userId);

        if (schoolError) {
            console.error("Error deleting school details:", schoolError);
            return res.status(500).json({ message: "Failed to clean up profile data" });
        }

        // 2. Delete Transactions (Must be done before registrations or independent?)
        // Actually, logic is: Registrations might point to Transactions.
        // If we delete registrations first, transactions are safe to delete.
        // Let's delete Registrations first as per previous plan.

        // 2a. Delete Event Registrations
        const { error: regError } = await supabaseAdmin
            .from("event_registrations")
            .delete()
            .eq("player_id", userId);

        if (regError) {
            console.error("Error deleting registrations:", regError);
            return res.status(500).json({ message: "Failed to delete event registrations" });
        }

        // 2b. Delete Transactions
        const { error: txError } = await supabaseAdmin
            .from("transactions")
            .delete()
            .eq("user_id", userId);

        if (txError) {
            console.error("Error deleting transactions:", txError);
            return res.status(500).json({ message: "Failed to delete transactions" });
        }

        // 2c. Delete Teams (where user is captain)
        const { error: teamError } = await supabaseAdmin
            .from("player_teams")
            .delete()
            .eq("captain_id", userId);

        if (teamError) {
            console.error("Error deleting teams:", teamError);
            return res.status(500).json({ message: "Failed to delete created teams" });
        }

        // 3. Delete User Record
        const { error: userError } = await supabaseAdmin
            .from("users")
            .delete()
            .eq("id", userId);

        if (userError) {
            console.error("Error deleting user:", userError);
            return res.status(500).json({ message: "Failed to delete user account" });
        }

        console.log(`✅ User ${userId} deleted successfully`);
        res.json({ success: true, message: "Account deleted permanently" });

    } catch (err) {
        console.error("DELETE ACCOUNT ERROR:", err);
        res.status(500).json({ message: "Failed to delete account" });
    }
});

// --------------------------------------------------------------------------
// FAMILY MEMBER MANAGEMENT
// --------------------------------------------------------------------------

// Add Family Member
router.post("/add-family-member", verifyPlayer, async (req, res) => {
    try {
        const userId = req.user.id;
        const { name, relation, age, gender } = req.body;

        if (!name || !relation) {
            return res.status(400).json({ message: "Name and Relation are required" });
        }

        const { data, error } = await supabaseAdmin
            .from("family_members")
            .insert({
                user_id: userId,
                name,
                relation,
                age: age ? parseInt(age) : null,
                gender
            })
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, familyMember: data, message: "Family member added" });

    } catch (err) {
        console.error("ADD FAMILY ERROR:", err);
        res.status(500).json({ message: "Failed to add family member" });
    }
});

// Update Family Member
router.put("/update-family-member/:id", verifyPlayer, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, relation, age, gender } = req.body;

        const { data, error } = await supabaseAdmin
            .from("family_members")
            .update({
                name,
                relation,
                age: age ? parseInt(age) : null,
                gender
            })
            .eq("id", id)
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, familyMember: data, message: "Family member updated" });

    } catch (err) {
        console.error("UPDATE FAMILY ERROR:", err);
        res.status(500).json({ message: "Failed to update family member" });
    }
});

// Delete Family Member
router.delete("/delete-family-member/:id", verifyPlayer, async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from("family_members")
            .delete()
            .eq("id", id);

        if (error) throw error;

        res.json({ success: true, message: "Family member deleted" });

    } catch (err) {
        console.error("DELETE FAMILY ERROR:", err);
        res.status(500).json({ message: "Failed to delete family member" });
    }
});

export default router;
