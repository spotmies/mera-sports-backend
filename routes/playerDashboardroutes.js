import express from "express";
// import bcrypt from "bcrypt"; // REMOVED
import { supabaseAdmin } from "../config/supabaseClient.js";
import { verifyPlayer } from "../middleware/rbacMiddleware.js";

const router = express.Router();

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
        // Fetch Event Registrations
        const { data: registrations, error: regError } = await supabaseAdmin
            .from("event_registrations")
            .select(`*, events ( id, name, sport, start_date, location )`)
            .eq("player_id", userId)
            .order('created_at', { ascending: false });

        if (regError) {
            console.error("Error fetching registrations:", regError);
        }

        // Fetch Transactions (Manual Merge to avoid FK issues)
        const { data: transactions, error: txError } = await supabaseAdmin
            .from("transactions")
            .select("*")
            .eq("user_id", userId);

        // Merge Data
        const detailedRegistrations = (registrations || []).map(reg => {
            // Try matching by transaction_id first, then fallback to event_id
            const txn = (transactions || []).find(t =>
                (reg.transaction_id && t.id === reg.transaction_id) ||
                (t.event_id === reg.event_id)
            );
            return {
                ...reg,
                transactions: txn || null
            };
        });

        res.json({ success: true, player, registrations: detailedRegistrations });

    } catch (err) {
        console.error("DASHBOARD ERROR:", err);
        res.status(500).json({ message: "Failed to load dashboard" });
    }
});

// --------------------------------------------------------------------------
// UPDATE PLAYER PROFILE
// Used by: Player App -> Edit Profile
// --------------------------------------------------------------------------
router.put("/update-profile", verifyPlayer, async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            email, // Added Email
            mobile,
            apartment,
            street,
            city,
            state,
            pincode,
            country
        } = req.body;

        const { data: updatedPlayer, error } = await supabaseAdmin
            .from("users")
            .update({
                email, // Added Email
                mobile,
                apartment,
                street,
                city,
                state,
                pincode,
                country
            })
            .eq("id", userId)
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, player: updatedPlayer, message: "Profile updated successfully" });

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
        console.error("PASSWORD UPDATE ERROR:", err);
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

export default router;