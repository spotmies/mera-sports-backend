import express from "express";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { verifyAdmin } from "../middleware/rbacMiddleware.js";

const router = express.Router();

/* ================= HELPER: UPLOAD BASE64 TO SUPABASE ================= */
async function uploadBase64(base64Data, bucket, folder = 'ads') {
    if (!base64Data || typeof base64Data !== 'string' || !base64Data.startsWith('data:')) {
        return base64Data;
    }

    try {
        const matches = base64Data.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
        if (!matches) {
            console.warn("Invalid base64 format.");
            return null;
        }

        const mimeType = matches[1];
        let ext = 'jpg';
        if (mimeType === 'image/png') ext = 'png';
        if (mimeType === 'image/webp') ext = 'webp';

        const buffer = Buffer.from(matches[2], 'base64');
        const filename = `${folder}/${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;

        const { data, error } = await supabaseAdmin.storage
            .from(bucket)
            .upload(filename, buffer, { contentType: mimeType, upsert: true });

        if (error) {
            console.error(`Upload error:`, error.message);
            throw error;
        }

        const { data: urlData } = supabaseAdmin.storage.from(bucket).getPublicUrl(filename);
        return urlData.publicUrl;
    } catch (err) {
        console.error("Upload handler failed:", err);
        return null;
    }
}

// GET /api/advertisements
// Fetch all advertisements
router.get("/", async (req, res) => {
    try {
        const { data: ads, error } = await supabaseAdmin
            .from("advertisements")
            .select("*")
            .order("created_at", { ascending: false });

        if (error) throw error;
        res.json({ success: true, advertisements: ads });
    } catch (err) {
        console.error("GET ADS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch advertisements" });
    }
});

// POST /api/advertisements
// Create a new advertisement
router.post("/", verifyAdmin, async (req, res) => {
    try {
        const { title, image, linkUrl, isActive, placement } = req.body;
        const userId = req.user.id; // From verifyAdmin middleware

        if (!title || !image) {
            return res.status(400).json({ message: "Missing required fields" });
        }

        // Upload Image
        const imageUrl = await uploadBase64(image, 'event-assets', 'ads');

        const { data: ad, error } = await supabaseAdmin
            .from("advertisements")
            .insert({
                user_id: userId,
                title,
                image_url: imageUrl,
                placement: placement || 'general', // Default for now
                link_url: linkUrl || null,
                is_active: isActive
            })
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, advertisement: ad });
    } catch (err) {
        console.error("CREATE AD ERROR:", err);
        res.status(500).json({ message: "Failed to create advertisement" });
    }
});

// PUT /api/advertisements/:id
// Update an advertisement
router.put("/:id", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, image, linkUrl, isActive, placement } = req.body;

        if (!title) {
            return res.status(400).json({ message: "Title is required" });
        }

        // Upload Image if it's new (starts with data:)
        const imageUrl = await uploadBase64(image, 'event-assets', 'ads');

        const { data: ad, error } = await supabaseAdmin
            .from("advertisements")
            .update({
                title,
                image_url: imageUrl,
                link_url: linkUrl || null,
                is_active: isActive,
                placement: placement || 'general'
            })
            .eq("id", id)
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, advertisement: ad });
    } catch (err) {
        console.error("UPDATE AD ERROR:", err);
        res.status(500).json({ message: "Failed to update advertisement" });
    }
});

// DELETE /api/advertisements/:id
// Delete an advertisement
router.delete("/:id", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from("advertisements")
            .delete()
            .eq("id", id);

        if (error) throw error;

        res.json({ success: true, message: "Advertisement deleted" });
    } catch (err) {
        console.error("DELETE AD ERROR:", err);
        res.status(500).json({ message: "Failed to delete advertisement" });
    }
});

// PATCH /api/advertisements/:id/toggle
// Toggle active status
router.patch("/:id/toggle", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { isActive } = req.body;

        const { data, error } = await supabaseAdmin
            .from("advertisements")
            .update({ is_active: isActive })
            .eq("id", id)
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, advertisement: data });
    } catch (err) {
        console.error("TOGGLE AD ERROR:", err);
        res.status(500).json({ message: "Failed to update advertisement status" });
    }
});

export default router;
