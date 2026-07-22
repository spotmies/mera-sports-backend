import { supabaseAdmin } from "../config/supabaseClient.js";
import { emitNotification } from "./realtimeService.js";

/**
 * Helper: Create Notification within Backend
 * @param {string} userId - UUID of the user
 * @param {string} title - Title
 * @param {string} message - Message Content
 * @param {string} type - 'info' | 'success' | 'warning' | 'error'
 * @param {string} [link] - Optional deduplication/navigation link
 * @returns {Promise<boolean>} true if the notification was created successfully, false on any error.
 *                             Callers should check the return value when notification delivery is critical.
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
            return false;
        }

        // Socket.IO broadcast (replaces Supabase Realtime httpSend).
        // Fire-and-forget: a broadcast failure must never fail the notification.
        try {
            emitNotification(userId, { title, type });
        } catch (err) {
            console.warn("Broadcast failed, but notification saved:", err);
        }

        return true;

    } catch (err) {
        console.error("Exception creating notification:", err);
        return false;
    }
};
