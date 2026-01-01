import express from "express";
import { supabaseAdmin } from "../config/supabaseClient.js";

const router = express.Router();

// GET /api/public/settings
// Fetch platform settings (Public)
router.get("/settings", async (req, res) => {
    try {
        const { data: settings, error } = await supabaseAdmin
            .from("platform_settings")
            .select("platform_name, logo_url, support_email, logo_size") // Only fetch necessary public fields
            .eq("id", 1)
            .single();

        if (error) throw error;

        // Return default if not found, to avoid crash
        res.json({
            success: true,
            settings: settings || { platform_name: 'Sports Paramount', logo_url: '' }
        });
    } catch (err) {
        // Fallback for missing settings table or other errors
        console.error("PUBLIC SETTINGS ERROR:", err);
        res.json({
            success: true,
            settings: { platform_name: 'Sports Paramount', logo_url: '' }
        });
    }
});

export default router;
