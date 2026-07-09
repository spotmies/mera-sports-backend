import { supabaseAdmin } from "../config/supabaseClient.js";

// GET /api/contact (Admin)
export const getMessages = async (req, res) => {
    try {
        const { data: messages, error } = await supabaseAdmin.from("contact_messages").select("*").order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ success: true, messages });
    } catch (error) { res.status(500).json({ success: false, message: "Failed to fetch messages" }); }
};

// PUT /api/contact/:id/status (Admin)
export const updateMessageStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        if (!['cleared', 'ticket', 'pending'].includes(status)) return res.status(400).json({ success: false, message: "Invalid status" });

        const { data, error } = await supabaseAdmin.from("contact_messages").update({ status }).eq("id", id).select().single();
        if (error) throw error;
        res.json({ success: true, message: "Status updated", data });
    } catch (error) { res.status(500).json({ success: false, message: "Failed to update status" }); }
};

// POST /api/contact/send
export const sendMessage = async (req, res) => {
    const { name, email, phone, subject, message } = req.body;
    try {
        const { data: savedMessage, error } = await supabaseAdmin.from("contact_messages").insert({ name, email, phone, subject, message }).select().single();
        if (error) throw error;

        // --- TRIGGER NOTIFICATIONS FOR ADMIN AND SUPERADMIN ---
        try {
            // Fetch all active admins and superadmins
            const { data: adminUsers, error: fetchError } = await supabaseAdmin
                .from('users')
                .select('id')
                .in('role', ['admin', 'superadmin']);

            if (!fetchError && adminUsers && adminUsers.length > 0) {
                // Determine what to display regarding the sender
                const senderDisplay = name ? `${name} (${email})` : email;
                const subjectDisplay = subject ? `Subject: ${subject}` : 'New Message';

                // Format the inserted array based on the table schema
                const notificationInserts = adminUsers.map(admin => ({
                    user_id: admin.id,
                    title: 'New Contact Us Message',
                    message: `${senderDisplay} has sent a new Contact Us message. ${subjectDisplay}.`,
                    type: 'info',
                    link: `/reports` // Or wherever your frontend route to view these is named
                }));

                // Insert into the notifications table
                const { error: insertError } = await supabaseAdmin
                    .from('notifications')
                    .insert(notificationInserts);

                if (insertError) {
                    console.error("Failed to insert contact notifications:", insertError);
                }
            }
        } catch (notificationErr) {
            console.error("Critical error inside contact notification trigger logic:", notificationErr);
        }

        res.status(200).json({ success: true, message: "Message saved successfully" });
    } catch (error) { res.status(500).json({ success: false, message: "Failed to save message" }); }
};
