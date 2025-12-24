import express from "express";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { authenticateUser as verifyToken } from "../middleware/authMiddleware.js";

const router = express.Router();

/* ================= HELPER: UPLOAD BASE64 TO SUPABASE ================= */
async function uploadBase64(base64Data, bucket, folder = 'misc') {
    if (!base64Data || typeof base64Data !== 'string' || !base64Data.startsWith('data:')) {
        return null;
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

/* ================= SUBMIT MANUAL PAYMENT ================= */
router.post("/submit-manual-payment", verifyToken, async (req, res) => {
    try {
        const { eventId, amount, categories, transactionId, screenshot, teamId } = req.body;
        console.log("DEBUG: Submit Payment Payload", { eventId, teamId, amount }); // DEBUG LOG
        const userId = req.user.id;

        // 1. Validation
        if (!eventId || !amount || !categories || !transactionId || !screenshot) {
            return res.status(400).json({ message: "All fields are required (Event, Amount, Categories, Transaction ID, Screenshot)" });
        }

        if (req.user.role === 'admin') {
            return res.status(403).json({ message: "Admins cannot register for events." });
        }

        // 2. Upload Screenshot
        let screenshotUrl = null;
        try {
            screenshotUrl = await uploadBase64(screenshot, 'event-assets', 'payment-proofs');
            if (!screenshotUrl) throw new Error("Screenshot upload failed");
        } catch (uploadError) {
            console.error("Screenshot Upload Error:", uploadError);
            return res.status(500).json({ message: "Failed to upload payment screenshot" });
        }

        // 3. Create Transaction Record (Pending Verification)
        const { data: transaction, error: txError } = await supabaseAdmin
            .from("transactions")
            .insert({
                order_id: `MANUAL_${Date.now()}`, // Placeholder since no external order
                manual_transaction_id: transactionId,
                payment_mode: 'manual',
                screenshot_url: screenshotUrl,
                amount: amount,
                currency: 'INR',
                status: "pending_verification", // Use 'pending' if you haven't updated constraints yet, but 'pending_verification' is better
                user_id: userId
            })
            .select()
            .single();

        if (txError) {
            console.error("Transaction Creation Error:", txError);
            return res.status(500).json({ message: "Failed to submit transaction details" });
        }

        // 4. Create Registration Record (Pending Verification)
        const { error: regError } = await supabaseAdmin
            .from("event_registrations")
            .insert({
                event_id: eventId,
                player_id: userId,
                registration_no: `REG-${Date.now()}`,
                categories: categories,
                amount_paid: amount,
                transaction_id: transaction.id, // Linking to the transaction record
                status: 'pending_verification',
                screenshot_url: screenshotUrl, // User requested storage here
                manual_transaction_id: transactionId, // User requested storage here
                team_id: teamId || null // Save team_id if provided
            });

        if (regError) {
            console.error("Registration Init Error:", regError);
            // Rollback transaction if possible, or just fail (manual cleanup needed)
            // Ideally we'd delete the just-created transaction here.
            await supabaseAdmin.from("transactions").delete().eq("id", transaction.id);
            return res.status(500).json({ message: "Failed to create registration record" });
        }

        res.json({
            success: true,
            message: "Payment submitted for verification",
            transactionId: transaction.id
        });

    } catch (err) {
        console.error("Manual Payment Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

export default router;
