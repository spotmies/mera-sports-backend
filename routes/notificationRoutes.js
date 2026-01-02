import express from "express";
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabaseClient.js";

const router = express.Router();

/**
 * Helper: Create Notification within Backend
 * @param {string} userId - UUID of the user
 * @param {string} title - Title
 * @param {string} message - Message Content
 * @param {string} type - 'info' | 'success' | 'warning' | 'error'
 * @param {string} [link] - Optional link
 */
export const createNotification = async (userId, title, message, type = 'info', link = null) => {
    try {
        const { error } = await supabaseAdmin
            .from('notifications')
            .insert({
                user_id: userId,
                title,
                message,
                type,
                link,
                is_read: false
            });

        if (error) {
            console.error("Error creating notification:", error);
        }
    } catch (err) {
        console.error("Exception creating notification:", err);
    }
};

// Middleware to extract User ID from Token
const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: "No token provided" });

    const token = authHeader.split(" ")[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(403).json({ message: "Invalid Token" });
    }
};

// GET /api/notifications - Fetch Notifications for Current User
router.get("/", authenticate, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('notifications')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .limit(50); // Limit to last 50

        if (error) throw error;

        // Count unread
        const { count, error: countError } = await supabaseAdmin
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', req.user.id)
            .eq('is_read', false);

        res.json({ success: true, notifications: data, unreadCount: count || 0 });
    } catch (err) {
        console.error("Get Notifications Error:", err);
        res.status(500).json({ message: "Failed to fetch notifications" });
    }
});

// POST /api/notifications/mark-read - Mark notifications as read
router.post("/mark-read", authenticate, async (req, res) => {
    try {
        const { notificationId, markAll } = req.body;

        if (markAll) {
            await supabaseAdmin
                .from('notifications')
                .update({ is_read: true })
                .eq('user_id', req.user.id)
                .eq('is_read', false);
        } else if (notificationId) {
            await supabaseAdmin
                .from('notifications')
                .update({ is_read: true })
                .eq('id', notificationId)
                .eq('user_id', req.user.id);
        }

        res.json({ success: true });
    } catch (err) {
        console.error("Mark Read Error:", err);
        res.status(500).json({ message: "Failed to update notification" });
    }
});

export default router;
