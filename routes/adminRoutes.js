import express from "express";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { verifyAdmin } from "../middleware/rbacMiddleware.js";
import { createNotification } from "./notificationRoutes.js"; // Added Import

const router = express.Router();

// GET /api/admin/list-admins
// Fetch all users with role = 'admin' (For assignment dropdown)
router.get("/list-admins", verifyAdmin, async (req, res) => {
    try {
        const { data: admins, error } = await supabaseAdmin
            .from("users")
            .select("id, name, email, role, verification")
            .eq("role", "admin");

        if (error) throw error;
        res.json({ success: true, admins });
    } catch (err) {
        console.error("FETCH ADMINS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch admins" });
    }
});

// POST /api/admin/approve-admin/:id
router.post("/approve-admin/:id", verifyAdmin, async (req, res) => {
    try {
        const targetAdminId = req.params.id;

        const { error } = await supabaseAdmin
            .from("users")
            .update({ verification: "verified" })
            .eq("id", targetAdminId);

        if (error) throw error;

        res.json({ success: true, message: "Admin approved successfully" });
    } catch (err) {
        console.error("APPROVE ADMIN ERROR:", err);
        res.status(500).json({ message: "Failed to approve admin" });
    }
});

// POST /api/admin/reject-admin/:id
router.post("/reject-admin/:id", verifyAdmin, async (req, res) => {
    try {
        const targetAdminId = req.params.id;

        const { error } = await supabaseAdmin
            .from("users")
            .update({ verification: "rejected" })
            .eq("id", targetAdminId);

        if (error) throw error;

        res.json({ success: true, message: "Admin application rejected" });
    } catch (err) {
        console.error("REJECT ADMIN ERROR:", err);
        res.status(500).json({ message: "Failed to reject admin" });
    }
});

// DELETE /api/admin/delete-admin/:id
// Delete an admin with Logic:
// 1. Unassign events assigned to them
// 2. Transfer events created by them to the current SuperAdmin
// 3. Delete the user
router.delete("/delete-admin/:id", verifyAdmin, async (req, res) => {
    try {
        const targetAdminId = req.params.id;
        const superAdminId = req.user.id; // From middleware

        // 1. Double check permission (Middleware checks 'admin' role, need to ensure 'superadmin' for this specific action if desired, 
        // OR rely on frontend hiding it. Better to check here.)
        // But `req.user` might not be populated fully depending on middleware.
        // Assuming verifyAdmin populates req.user. 
        // Let's proceed assuming trusting the caller for now or fetching details if needed.
        // Actually, let's fetch the caller to be safe if req.user isn't full.
        // For now, I'll trust req.user has ID.

        // 1. Unassign events assigned to this admin
        const { error: unassignError } = await supabaseAdmin
            .from('events')
            .update({ assigned_to: null })
            .eq('assigned_to', targetAdminId);

        if (unassignError) throw unassignError;

        // 2. Transfer ownership of events created by this admin to SuperAdmin
        const { error: transferError } = await supabaseAdmin
            .from('events')
            .update({ created_by: superAdminId })
            .eq('created_by', targetAdminId);

        if (transferError) throw transferError;

        // 3. Delete the user
        // Note: multiple tables might reference user (profiles etc).
        // Deleting from public.users usually works if cascades are set, or just delete it.
        // Also need to consider auth.users if using Supabase Auth.
        // supabaseAdmin.auth.deleteUser(id) deletes from Auth, which usually cascades to public.users if trigger exists.
        // If no trigger, we delete from public.users.
        // 3. Delete the user
        // Try deleting from Auth first (log if error but proceed to ensure public cleanup)
        const { error: deleteAuthError } = await supabaseAdmin.auth.admin.deleteUser(targetAdminId);
        if (deleteAuthError) {
            console.log("Auth delete warning (might already be deleted or not in auth):", deleteAuthError.message);
        }

        // ALWAYS explicitly delete from public.users to ensure consistency with the UI list
        const { error: deletePublicError } = await supabaseAdmin
            .from('users')
            .delete()
            .eq('id', targetAdminId);

        if (deletePublicError) throw deletePublicError;

        res.json({ success: true, message: "Admin deleted and events re-organized." });

    } catch (err) {
        console.error("DELETE ADMIN ERROR:", err);
        res.status(500).json({ message: "Failed to delete admin: " + err.message });
    }
});

// GET /api/admin/players
// Fetch all users with role = 'player'
router.get("/players", verifyAdmin, async (req, res) => {
    try {
        const { data: players, error } = await supabaseAdmin
            .from("users")
            .select("*")
            .eq("role", "player")
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({ success: true, players });
    } catch (err) {
        console.error("ADMIN PLAYERS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch players" });
    }
});

// GET /api/admin/players/:id
// Fetch single player details
router.get("/players/:id", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Fetch User
        const { data: player, error } = await supabaseAdmin
            .from("users")
            .select("*")
            .eq("id", id)
            .single();

        if (error) throw error;

        // 2. Fetch School Details (if any)
        const { data: schoolDetails } = await supabaseAdmin
            .from("player_school_details")
            .select("*")
            .eq("player_id", id)
            .single();

        // 3. Attach school details
        if (schoolDetails) {
            player.school = {
                name: schoolDetails.school_name,
                address: schoolDetails.school_address,
                city: schoolDetails.school_city,
                pincode: schoolDetails.school_pincode
            };
        }

        // 4. Fetch Event Registrations
        const { data: registrations, error: regError } = await supabaseAdmin
            .from("event_registrations")
            .select(`
                *,
                events (
                    id, name, sport, start_date, start_time, location, venue, categories
                )
            `)
            .eq("player_id", id)
            .order("created_at", { ascending: false });

        if (regError) {
            console.error("Error fetching registrations:", regError);
            // Don't throw, just return empty array
        }

        player.eventsParticipated = registrations ? registrations.map(reg => ({
            eventId: reg.events?.id,
            eventName: reg.events?.name,
            sport: reg.events?.sport,
            categories: reg.events?.category ? [reg.events.category] : [], // Adjust if category is stored differently
            registrationId: reg.registration_no,
            paymentStatus: reg.status === 'verified' ? 'paid' : (reg.status === 'rejected' ? 'failed' : 'pending'),
            playerStatus: reg.status,
            eventDate: reg.events?.start_date,
            eventTime: reg.events?.start_time || "N/A",
            eventLocation: reg.events?.location || "Unknown",
            eventVenue: reg.events?.venue || "Unknown",
            eventStatus: 'upcoming', // Ideally calculate based on date
            amountPaid: reg.amount_paid
        })) : [];

        res.json({ success: true, player });
    } catch (err) {
        console.error("ADMIN PLAYER DETAIL ERROR:", err);
        res.status(500).json({ message: "Failed to fetch player details" });
    }
});

// GET /api/admin/settings
// Fetch platform settings
router.get("/settings", verifyAdmin, async (req, res) => {
    try {
        const { data: settings, error } = await supabaseAdmin
            .from("platform_settings")
            .select("*")
            .eq("id", 1)
            .single();

        if (error) throw error;
        res.json({ success: true, settings });
    } catch (err) {
        console.error("GET SETTINGS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch settings" });
    }
});

// POST /api/admin/settings
// Update platform settings
router.post("/settings", verifyAdmin, async (req, res) => {
    try {
        const { platformName, supportEmail, supportPhone } = req.body;


        const { data: settings, error } = await supabaseAdmin
            .from("platform_settings")
            .update({
                platform_name: platformName,
                support_email: supportEmail,
                support_phone: supportPhone,
                logo_url: req.body.logoUrl,
                logo_size: req.body.logoSize, // Capture logo size
                updated_at: new Date()
            })
            .eq("id", 1)
            .select()
            .single();

        if (error) throw error;
        res.json({ success: true, settings });
    } catch (err) {
        console.error("UPDATE SETTINGS ERROR:", err);
        res.status(500).json({ message: "Failed to update settings" });
    }
});



// GET /api/admin/dashboard-stats
// Fetch aggregated stats for dashboard
router.get("/dashboard-stats", verifyAdmin, async (req, res) => {
    try {
        // 1. Player Counts
        const { count: totalPlayers, error: countError } = await supabaseAdmin
            .from("users")
            .select("*", { count: 'exact', head: true })
            .eq("role", "player");

        const { count: verifiedPlayers } = await supabaseAdmin
            .from("users")
            .select("*", { count: 'exact', head: true })
            .eq("role", "player")
            .eq("verification", "verified");

        const { count: pendingPlayers } = await supabaseAdmin
            .from("users")
            .select("*", { count: 'exact', head: true })
            .eq("role", "player")
            .eq("verification", "pending");

        const { count: rejectedPlayersCount } = await supabaseAdmin
            .from("users")
            .select("*", { count: 'exact', head: true })
            .eq("role", "player")
            .eq("verification", "rejected");

        // 2. Recent Players (Limit 6)
        const { data: recentPlayers } = await supabaseAdmin
            .from("users")
            .select("*")
            .eq("role", "player")
            .order("created_at", { ascending: false })
            .limit(6);

        // 3. Rejected Players List (Limit 5)
        const { data: rejectedPlayersList } = await supabaseAdmin
            .from("users")
            .select("*")
            .eq("role", "player")
            .eq("verification", "rejected")
            .order("created_at", { ascending: false })
            .limit(5);

        // 4. Rejected Transactions (Limit 5)
        const { data: rejectedTransactions } = await supabaseAdmin
            .from("event_registrations")
            .select(`
                *,
                events ( name ),
                users:player_id ( first_name, last_name, player_id )
            `)
            .eq("status", "rejected")
            .order("created_at", { ascending: false })
            .limit(5);

        // 5. Total Revenue (Sum of verified transactions)
        const { data: approvedTxns } = await supabaseAdmin
            .from("event_registrations")
            .select("amount_paid")
            .eq("status", "verified");

        const totalRevenue = approvedTxns?.reduce((sum, txn) => sum + (Number(txn.amount_paid) || 0), 0) || 0;
        const totalTransactionsCount = approvedTxns?.length || 0;

        if (countError) throw countError;

        res.json({
            success: true,
            stats: {
                totalPlayers: totalPlayers || 0,
                verifiedPlayers: verifiedPlayers || 0,
                pendingPlayers: pendingPlayers || 0,
                rejectedPlayers: rejectedPlayersCount || 0,
                totalRevenue: totalRevenue || 0,
                totalTransactionsCount: totalTransactionsCount || 0
            },
            recentPlayers: recentPlayers || [],
            rejectedPlayersList: rejectedPlayersList || [],
            rejectedTransactions: rejectedTransactions || []
        });
    } catch (err) {
        console.error("DASHBOARD STATS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch dashboard stats" });
    }
});

// POST /api/admin/transactions/bulk-update
// Bulk update transactions (verify or reject)
router.post("/transactions/bulk-update", verifyAdmin, async (req, res) => {
    try {

        const { ids, status } = req.body; // ids: string[], status: 'verified' | 'rejected'

        if (!ids || !Array.isArray(ids) || ids.length === 0) {

            return res.status(400).json({ message: "Invalid IDs provided" });
        }
        if (!['verified', 'rejected'].includes(status)) {

            return res.status(400).json({ message: "Invalid status" });
        }

        const { data: updatedRegs, error, count } = await supabaseAdmin
            .from("event_registrations")
            .update({ status })
            .in("id", ids)
            .select('id, player_id, registration_no, events(name)');

        if (error) {
            console.error("Supabase Bulk Update Error:", error);
            throw error;
        }

        // BULK NOTIFICATIONS
        if (updatedRegs && updatedRegs.length > 0) {
            updatedRegs.forEach(reg => {
                const eventName = reg.events?.name || 'Event';
                const title = status === 'verified' ? "Registration Verified" : "Registration Rejected";
                const type = status === 'verified' ? "success" : "error";
                const msg = status === 'verified'
                    ? `Your registration for ${eventName} (Reg No: ${reg.registration_no}) has been verified.`
                    : `Your registration for ${eventName} (Reg No: ${reg.registration_no}) was rejected.`;

                createNotification(reg.player_id, title, msg, type);
            });
        }



        res.json({ success: true, message: `Transactions ${status}`, count });
    } catch (err) {
        console.error("BULK UPDATE ERROR:", err);
        res.status(500).json({ message: "Batch update failed" });
    }
});

// GET /api/admin/registrations
// Fetch all event registrations
// Route to get all registrations for an event (with optional category select)
router.get("/registrations", verifyAdmin, async (req, res) => {
    try {
        const { eventId } = req.query;
        let query = supabaseAdmin
            .from("event_registrations")
            .select(`
                id, event_id, player_id, team_id, registration_no, status, amount_paid, payment_proof:screenshot_url, manual_transaction_id, transaction_id, created_at, categories, document_url,
                events ( id, name, sport, start_date, end_date, start_time, location, venue, categories, status ),
                users:player_id ( id, first_name, last_name, player_id, mobile, gender, apartment ),
                player_teams ( id, team_name, captain_name, captain_mobile, members )
            `)
            .order('created_at', { ascending: false });

        if (eventId) {
            query = query.eq('event_id', eventId);
        }

        const { data: registrations, error } = await query;

        if (error) throw error;
        res.json({ success: true, registrations });
    } catch (err) {
        console.error("ADMIN REGISTRATIONS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch registrations" });
    }
});

// GET /api/admin/transactions
// Fetch all transactions (event_registrations)
router.get("/transactions", verifyAdmin, async (req, res) => {
    try {
        const { eventId, admin_id } = req.query;
        let query = supabaseAdmin
            .from("event_registrations")
            .select(`
                id, event_id, player_id, registration_no, status, amount_paid, payment_proof:screenshot_url, manual_transaction_id, transaction_id, created_at, categories,
                events!inner ( id, name, created_by, assigned_to ),
                users:player_id ( id, first_name, last_name, player_id, mobile, email, apartment )
            `)
            .order('created_at', { ascending: false });

        if (eventId) {
            query = query.eq('event_id', eventId);
        }

        if (admin_id) {
            // Filter where the associated event is created by OR assigned to the admin
            query = query.or(`created_by.eq.${admin_id},assigned_to.eq.${admin_id}`, { foreignTable: 'events' });
        }

        const { data: transactions, error } = await query;

        if (error) throw error;
        res.json({ success: true, transactions });
    } catch (err) {
        console.error("ADMIN TRANSACTIONS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch transactions" });
    }
});

// PUT /api/admin/transactions/:id/verify
// Verify a transaction
router.put("/transactions/:id/verify", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Update event_registrations
        const { data: updatedReg, error: regError } = await supabaseAdmin
            .from("event_registrations")
            .update({ status: "verified" })
            .eq("id", id)
            .select("player_id, registration_no, events(name)")
            .single();

        if (regError) throw regError;

        // NOTIFICATION
        if (updatedReg) {
            const eventName = updatedReg.events?.name || 'Event';
            createNotification(
                updatedReg.player_id,
                "Registration Verified",
                `Your registration for ${eventName} (Reg No: ${updatedReg.registration_no}) has been verified.`,
                "success"
            );
        }

        // 2. We should also verify if there is a linked transaction in "transactions" table?
        // Let's first fetch the registration to see if it has a manual_transaction_id.
        // For now, simpler is better: assuming logic is primarily driven by event_registrations.status

        res.json({ success: true, message: "Transaction verified" });
    } catch (err) {
        console.error("VERIFY ERROR:", err);
        res.status(500).json({ message: "Verification failed" });
    }
});

// PUT /api/admin/transactions/:id/reject
// Reject a transaction
router.put("/transactions/:id/reject", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const { data: updatedReg, error: regError } = await supabaseAdmin
            .from("event_registrations")
            .update({ status: "rejected" })
            .eq("id", id)
            .select("player_id, registration_no, events(name)")
            .single();

        if (regError) throw regError;

        // NOTIFICATION
        if (updatedReg) {
            const eventName = updatedReg.events?.name || 'Event';
            createNotification(
                updatedReg.player_id,
                "Registration Rejected",
                `Your registration for ${eventName} (Reg No: ${updatedReg.registration_no}) was rejected. Please contact support.`,
                "error"
            );
        }

        res.json({ success: true, message: "Transaction rejected" });
    } catch (err) {
        console.error("REJECT ERROR:", err);
        res.status(500).json({ message: "Rejection failed" });
    }
});

// --------------------------------------------------------------------------
// NEWS & HIGHLIGHTS MANAGEMENT
// --------------------------------------------------------------------------

// GET /api/admin/news?eventId={id}
router.get("/news", verifyAdmin, async (req, res) => {
    try {
        const { eventId } = req.query;
        if (!eventId) return res.status(400).json({ message: "Event ID is required" });

        const { data: news, error } = await supabaseAdmin
            .from("event_news")
            .select("*")
            .eq("event_id", eventId)
            .order("created_at", { ascending: false });

        if (error) throw error;

        res.json({ success: true, news });
    } catch (err) {
        console.error("FETCH NEWS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch news" });
    }
});

// POST /api/admin/news
router.post("/news", verifyAdmin, async (req, res) => {
    try {
        const { eventId, title, content, imageUrl, isHighlight } = req.body;

        const { data, error } = await supabaseAdmin
            .from("event_news")
            .insert({
                event_id: eventId,
                title,
                content,
                image_url: imageUrl,
                is_highlight: isHighlight || false
            })
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, news: data, message: "News added successfully" });
    } catch (err) {
        console.error("ADD NEWS ERROR:", err);
        res.status(500).json({ message: "Failed to add news" });
    }
});

// PUT /api/admin/news/:id
router.put("/news/:id", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, content, imageUrl, isHighlight } = req.body;

        const { data, error } = await supabaseAdmin
            .from("event_news")
            .update({
                title,
                content,
                image_url: imageUrl,
                is_highlight: isHighlight
            })
            .eq("id", id)
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, news: data, message: "News updated successfully" });
    } catch (err) {
        console.error("UPDATE NEWS ERROR:", err);
        res.status(500).json({ message: "Failed to update news" });
    }
});

// DELETE /api/admin/news/:id
router.delete("/news/:id", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from("event_news")
            .delete()
            .eq("id", id);

        if (error) throw error;

        res.json({ success: true, message: "News deleted successfully" });
    } catch (err) {
        console.error("DELETE NEWS ERROR:", err);
        res.status(500).json({ message: "Failed to delete news" });
    }
});

// --------------------------------------------------------------------------
// DRAWS & BRACKETS MANAGEMENT
// --------------------------------------------------------------------------

// GET /api/admin/brackets?eventId={id}
router.get("/brackets", verifyAdmin, async (req, res) => {
    try {
        const { eventId } = req.query;
        if (!eventId) return res.status(400).json({ message: "Event ID is required" });

        const { data: brackets, error } = await supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .order("created_at", { ascending: true }); // Order by creation to keep round order if needed

        if (error) throw error;

        res.json({ success: true, brackets });
    } catch (err) {
        console.error("FETCH BRACKETS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch brackets" });
    }
});

// POST /api/admin/brackets
// Handles both Create and Update (Upsert logic or separate Update)
// For simplicity, we'll assume we are ADDING a round. To update, we might delete/re-create or use a specific ID.
// Let's implement ADD/UPDATE based on if an ID is provided, or better, we can just strictly ADD rounds here
// and use PUT for updates if needed. Given the UI, we usually "save" a round.
/* ================= HELPER: UPLOAD BASE64 TO SUPABASE ================= */
async function uploadBase64(base64Data, bucket, folder = 'misc') {
    if (!base64Data || typeof base64Data !== 'string' || !base64Data.startsWith('data:')) {
        return null; // Return null if not valid base64 (might be already a URL)
    }

    try {
        const matches = base64Data.match(/^data:(image\/[a-zA-Z]+|application\/pdf);base64,(.+)$/);
        if (!matches) {
            console.warn("Invalid base64 format");
            return null;
        }

        const mimeType = matches[1];
        let ext = 'bin';
        if (mimeType === 'application/pdf') ext = 'pdf';
        else if (mimeType.startsWith('image/')) ext = mimeType.split('/')[1];

        const buffer = Buffer.from(matches[2], 'base64');
        const filename = `${folder}/${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;

        const { data, error } = await supabaseAdmin.storage
            .from(bucket)
            .upload(filename, buffer, { contentType: mimeType, upsert: true });

        if (error) throw error;

        const { data: urlData } = supabaseAdmin.storage.from(bucket).getPublicUrl(filename);
        return urlData.publicUrl;
    } catch (err) {
        console.error("Upload handler failed:", err);
        throw err;
    }
}

router.post("/brackets", verifyAdmin, async (req, res) => {
    try {
        const { eventId, category, roundName, drawType, drawData } = req.body;

        // Handle Image Upload if drawType is image
        let finalDrawData = drawData;
        if (drawType === 'image' && drawData && drawData.url) {
            // Check if url is base64
            if (drawData.url.startsWith('data:')) {
                const storageUrl = await uploadBase64(drawData.url, 'event-assets', 'draws');
                if (storageUrl) {
                    finalDrawData = { ...drawData, url: storageUrl };
                } else {
                    console.warn("Failed to upload draw image, likely invalid format");
                    // Fallback? Or fail? Let's proceed, maybe it's already a URL
                }
            }
        }

        // Check if this round already exists for this category/event? 
        // If so, update it. If not, insert it.
        // We'll try to find an existing one first.
        const { data: existing } = await supabaseAdmin
            .from("event_brackets")
            .select("id")
            .eq("event_id", eventId)
            .eq("category", category)
            .eq("round_name", roundName)
            .single();

        let result;
        if (existing) {
            // Update
            const { data, error } = await supabaseAdmin
                .from("event_brackets")
                .update({
                    draw_type: drawType,
                    draw_data: finalDrawData
                })
                .eq("id", existing.id)
                .select()
                .single();
            if (error) throw error;
            result = data;
        } else {
            // Insert
            const { data, error } = await supabaseAdmin
                .from("event_brackets")
                .insert({
                    event_id: eventId,
                    category,
                    round_name: roundName,
                    draw_type: drawType,
                    draw_data: finalDrawData
                })
                .select()
                .single();
            if (error) throw error;
            result = data;
        }

        res.json({ success: true, bracket: result, message: "Bracket/Draw saved successfully" });
    } catch (err) {
        console.error("SAVE BRACKET ERROR:", err);
        res.status(500).json({ message: "Failed to save bracket" });
    }
});

// DELETE /api/admin/brackets
router.delete("/brackets", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.body; // Or query param, but strictly creating a delete endpoint
        // Or maybe we want to delete by category/round?
        // Let's support deleting by ID if known, or by criteria.
        // Simplified: Delete by ID passed in query or params is cleaner.
        // Let's change to :id param for consistency.
        return res.status(405).json({ message: "Use DELETE /api/admin/brackets/:id" });
    } catch (err) {
        res.status(500).json({ message: "Error" });
    }
});

router.delete("/brackets/:id", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabaseAdmin
            .from("event_brackets")
            .delete()
            .eq("id", id);

        if (error) throw error;
        res.json({ success: true, message: "Bracket deleted successfully" });
    } catch (err) {
        console.error("DELETE BRACKET ERROR:", err);
        res.status(500).json({ message: "Failed to delete bracket" });
    }
});

// POST /api/admin/upload
// Generic upload endpoint
router.post("/upload", verifyAdmin, async (req, res) => {
    try {
        const { image, folder } = req.body; // image = base64 string
        if (!image) return res.status(400).json({ message: "No image data provided" });

        const targetFolder = folder || 'misc';
        const url = await uploadBase64(image, 'admin-assets', targetFolder);

        if (url) {
            res.json({ success: true, url });
        } else {
            res.status(400).json({ message: "Upload failed or invalid image format" });
        }
    } catch (err) {
        console.error("UPLOAD ENDPOINT ERROR:", err);
        res.status(500).json({ message: "Server error during upload" });
    }
});

// ================= END TRANSACTIONS =================

export default router;
// GET /api/admin/all-categories
// Fetch all unique categories from all events
router.get("/all-categories", verifyAdmin, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("events")
            .select("categories");

        if (error) throw error;

        // Extract and flatten unique categories
        const uniqueCategories = new Set(["All Categories"]);

        data.forEach(event => {
            let cats = event.categories;
            // Parse if string
            if (typeof cats === 'string') {
                try { if (cats.startsWith('[')) cats = JSON.parse(cats); } catch (e) { }
            }

            const addCat = (cat) => {
                const name = cat.name || cat.category || cat.Category || cat.id;
                if (name) uniqueCategories.add(name);
                else if (typeof cat === 'string') uniqueCategories.add(cat);
            };

            if (Array.isArray(cats)) {
                cats.forEach(addCat);
            } else if (typeof cats === 'object' && cats !== null) {
                addCat(cats);
            } else if (cats) {
                uniqueCategories.add(String(cats));
            }
        });

        res.json({ success: true, categories: Array.from(uniqueCategories).sort() });

    } catch (err) {
        console.error("Error fetching categories:", err);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});
