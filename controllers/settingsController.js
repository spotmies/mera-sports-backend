import { supabaseAdmin } from "../config/supabaseClient.js";

export const getSettings = async (req, res) => {
    try {
        const { data: settings, error } = await supabaseAdmin.from("platform_settings").select("*").eq("id", 1).single();
        if (error) throw error;
        res.json({ success: true, settings });
    } catch (err) {
        if (err.code === 'PGRST116') {
            return res.json({ success: true, settings: { id: 1, platform_name: 'Default', logo_url: '' } });
        }
        console.error("GET SETTINGS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch settings" });
    }
};

export const updateSettings = async (req, res) => {
    try {
        const { platformName, supportEmail, supportPhone, logoUrl, logoSize } = req.body;
        const { data: settings, error } = await supabaseAdmin
            .from("platform_settings")
            .upsert({
                id: 1,
                platform_name: platformName,
                support_email: supportEmail,
                support_phone: supportPhone,
                logo_url: logoUrl,
                logo_size: logoSize,
                registration_config: req.body.registrationConfig,
                updated_at: new Date()
            })
            .select()
            .single();

        if (error) throw error;
        res.json({ success: true, settings });
    } catch (err) {
        console.error("UPDATE SETTINGS ERROR:", err);
        res.status(500).json({ message: "Failed to update settings" });
    }
};
