import { supabaseAdmin } from "../config/supabaseClient.js";
import { uploadBase64 } from "../utils/uploadHelper.js";

export const getAdvertisements = async (req, res) => {
    try {
        const { page, limit } = req.query;
        let query = supabaseAdmin.from("advertisements").select("*", { count: 'exact' }).order("created_at", { ascending: false });

        if (page && limit) {
            const pageNum = parseInt(page, 10);
            const limitNum = parseInt(limit, 10);
            const from = (pageNum - 1) * limitNum;
            const to = from + limitNum - 1;
            query = query.range(from, to);
        }

        const { data, count, error } = await query;
        if (error) throw error;
        res.json({ success: true, advertisements: data, total_count: count });
    } catch (err) { res.status(500).json({ message: "Failed to fetch advertisements" }); }
};

export const createAdvertisement = async (req, res) => {
    try {
        const { title, image, linkUrl, isActive, placement } = req.body;
        if (!title || !image) return res.status(400).json({ message: "Missing required fields" });

        const imageUrl = await uploadBase64(image, 'event-assets', 'ads');
        const { data, error } = await supabaseAdmin.from("advertisements")
            .insert({ user_id: req.user.id, title, image_url: imageUrl, placement: placement || 'general', link_url: linkUrl || null, is_active: isActive })
            .select().single();

        if (error) throw error;
        res.json({ success: true, advertisement: data });
    } catch (err) { res.status(500).json({ message: "Failed to create advertisement" }); }
};

export const updateAdvertisement = async (req, res) => {
    try {
        const { id } = req.params;
        const { title, image, linkUrl, isActive, placement } = req.body;
        if (!title) return res.status(400).json({ message: "Title is required" });

        const imageUrl = await uploadBase64(image, 'event-assets', 'ads'); // uploadBase64 handles if it's not base64
        const { data, error } = await supabaseAdmin.from("advertisements")
            .update({ title, image_url: imageUrl, link_url: linkUrl || null, is_active: isActive, placement: placement || 'general' })
            .eq("id", id).select().single();

        if (error) throw error;
        res.json({ success: true, advertisement: data });
    } catch (err) { res.status(500).json({ message: "Failed to update advertisement" }); }
};

export const deleteAdvertisement = async (req, res) => {
    try {
        const { error } = await supabaseAdmin.from("advertisements").delete().eq("id", req.params.id);
        if (error) throw error;
        res.json({ success: true, message: "Advertisement deleted" });
    } catch (err) { res.status(500).json({ message: "Failed to delete advertisement" }); }
};

export const toggleAdvertisement = async (req, res) => {
    try {
        const { isActive } = req.body;
        const { data, error } = await supabaseAdmin.from("advertisements").update({ is_active: isActive }).eq("id", req.params.id).select().single();
        if (error) throw error;
        res.json({ success: true, advertisement: data });
    } catch (err) { res.status(500).json({ message: "Failed to update status" }); }
};
