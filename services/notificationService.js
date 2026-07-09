import { supabaseAdmin } from "../config/supabaseClient.js";

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

        // Use httpSend() instead of send() for server-side broadcast.
        //
        // WHY: send() requires an active WebSocket connection. Browser clients maintain one,
        // but a Node.js backend server does not — so send() was silently falling back to REST
        // every time and printing a deprecation warning in the console.
        //
        // httpSend(event, payload) explicitly uses the REST API with no WebSocket needed.
        // Signature: httpSend(event: string, payload: any, opts?: { timeout?: number })
        // Available in @supabase/supabase-js >= 2.43 (using v2.87.3 here).
        await supabaseAdmin
            .channel(`system-notifications`)
            .httpSend('new_notification', { user_id: userId })
            .catch(err => console.warn("Broadcast failed, but notification saved:", err));

        return true;

    } catch (err) {
        console.error("Exception creating notification:", err);
        return false;
    }
};
