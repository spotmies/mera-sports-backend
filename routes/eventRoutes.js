import express from "express";
import QRCode from 'qrcode';
import { supabaseAdmin } from "../config/supabaseClient.js";
import { verifyAdmin } from "../middleware/rbacMiddleware.js";

const router = express.Router();

/* ================= HELPER: UPLOAD BASE64 TO SUPABASE ================= */
async function uploadBase64(base64Data, bucket, folder = 'misc') {
    if (!base64Data || typeof base64Data !== 'string' || !base64Data.startsWith('data:')) {
        return base64Data;
    }

    try {
        // Support images and PDFs
        const matches = base64Data.match(/^data:(image\/[a-zA-Z]+|application\/pdf);base64,(.+)$/);
        if (!matches) {
            console.warn("Invalid base64 format:", base64Data.substring(0, 30) + "...");
            return null;
        }

        const mimeType = matches[1];
        let ext = 'bin';
        if (mimeType === 'application/pdf') ext = 'pdf';
        else if (mimeType === 'image/jpeg') ext = 'jpg';
        else if (mimeType.startsWith('image/')) ext = mimeType.split('/')[1];

        const buffer = Buffer.from(matches[2], 'base64');
        const filename = `${folder}/${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;

        const { data, error } = await supabaseAdmin.storage
            .from(bucket)
            .upload(filename, buffer, { contentType: mimeType, upsert: true });

        if (error) {
            console.error(`Upload error for ${filename}:`, error.message);
            throw error;
        }

        const { data: urlData } = supabaseAdmin.storage.from(bucket).getPublicUrl(filename);
        return urlData.publicUrl;
    } catch (err) {
        console.error("Upload handler failed:", err);
        return null;
    }
}

/* ================= CREATE EVENT (PROTECTED) ================= */
router.post('/create', verifyAdmin, async (req, res) => {
    try {
        const {
            name,
            sport,
            location,
            venue,
            start_date,
            end_date,
            start_time,
            banner_image,
            document_url, // Base64 PDF
            document_description,
            sponsors,
            categories,
            assigned_to,
        } = req.body;

        // Sanitize Dates
        const cleanStartDate = start_date === "" ? null : start_date;
        const cleanEndDate = end_date === "" ? null : end_date;

        // req.user is populated by verifyAdmin
        const created_by = req.user.id;

        if (!name || !sport || !start_date) {
            return res.status(400).json({ message: "Missing required fields (name, sport, date)" });
        }

        console.log(`Creating event: ${name} by user: ${created_by}`);

        // 1. Upload Banner
        let banner_url = null;
        if (banner_image) {
            banner_url = await uploadBase64(banner_image, 'event-assets', 'banners');
        }

        // 2. Upload Document (PDF)
        let uploadedDocUrl = null;
        if (document_url) {
            uploadedDocUrl = await uploadBase64(document_url, 'event-documents', 'docs');
        }

        // 3. Process Sponsors
        let processedSponsors = [];
        if (sponsors && Array.isArray(sponsors)) {
            processedSponsors = await Promise.all(sponsors.map(async (sp) => {
                const logoUrl = await uploadBase64(sp.logo, 'event-assets', 'sponsors');
                let mediaItems = [];
                if (sp.mediaItems && Array.isArray(sp.mediaItems)) {
                    mediaItems = await Promise.all(sp.mediaItems.map(async (media) => {
                        const url = await uploadBase64(media.url, 'event-assets', 'sponsor-media');
                        return { ...media, url };
                    }));
                }
                return { ...sp, logo: logoUrl, mediaItems };
            }));
        }

        // 4. Insert into Table
        const { data, error } = await supabaseAdmin
            .from('events')
            .insert({
                name,
                sport,
                location,
                venue,
                start_date: cleanStartDate,
                end_date: cleanEndDate,
                start_time,
                banner_url,
                payment_qr_image: req.body.payment_qr_image ? await uploadBase64(req.body.payment_qr_image, 'event-assets', 'payment-qrs') : null,
                document_url: uploadedDocUrl,
                document_description,
                sponsors: processedSponsors,
                categories,
                created_by, // Secured ID
                assigned_to,
                status: 'upcoming'
            })
            .select()
            .single();

        if (error) throw error;

        // 5. Generate and Upload QR Code
        try {
            const eventId = data.id;
            const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8081';
            const link = `${frontendUrl}/events/${eventId}`;
            const qrDataUrl = await QRCode.toDataURL(link);
            const qrPublicUrl = await uploadBase64(qrDataUrl, 'event-assets', 'qrcodes');

            // Update event with QR code URL
            await supabaseAdmin
                .from('events')
                .update({ qr_code: qrPublicUrl })
                .eq('id', eventId);

            // Attach QR code to response
            data.qr_code = qrPublicUrl;

        } catch (qrError) {
            console.error("QR Code Generation Failed:", qrError);
            // Non-critical error, continue
        }

        res.json({ success: true, event: data });

    } catch (err) {
        console.error("Create Event Logic Error:", err);
        res.status(500).json({ message: err.message || "Internal Server Error" });
    }
});
/* ================= FETCH ALL EVENTS (PUBLIC) ================= */
router.get('/list', async (req, res) => {
    try {
        const { created_by, admin_id } = req.query;

        let query = supabaseAdmin
            .from('events')
            .select('id, name, sport, start_date, start_time, location, venue, categories, banner_url, created_by, assigned_to, qr_code, status, registration_deadline:end_date, sponsors, document_url, document_description, payment_qr_image')
            .order('start_date', { ascending: true });

        // Filter by Creator (Legacy support)
        if (created_by) {
            query = query.eq('created_by', created_by);
        }

        // Filter by Admin ID (Created BY OR Assigned TO)
        if (admin_id) {
            query = query.or(`created_by.eq.${admin_id},assigned_to.eq.${admin_id}`);
        }

        const { data, error } = await query;

        if (error) throw error;

        res.json({ success: true, events: data });
    } catch (err) {
        console.error("Fetch Events Error:", err);
        // LOG DETAIL FOR DEBUGGING
        if (err.details) console.error("DB Details:", err.details);
        if (err.hint) console.error("DB Hint:", err.hint);
        res.status(500).json({ message: err.message || "Internal Server Error" });
    }
});

/* ================= FETCH SINGLE EVENT (PUBLIC) ================= */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        // Fetch Event Details
        const { data: eventData, error: eventError } = await supabaseAdmin
            .from('events')
            .select('id, name, sport, start_date, start_time, location, venue, categories, banner_url, created_by, assigned_to, qr_code, status, registration_deadline:end_date, sponsors, document_url, document_description, payment_qr_image')
            .eq('id', id)
            .single();

        if (eventError) throw eventError;
        if (!eventData) return res.status(404).json({ success: false, message: "Event not found" });

        // Manual fetch for assigned user due to missing FK
        if (eventData.assigned_to) {
            const { data: assignedUser } = await supabaseAdmin
                .from('users')
                .select('id, name, email')
                .eq('id', eventData.assigned_to)
                .single();

            if (assignedUser) {
                eventData.assigned_user = assignedUser;
            }
        }

        // Fetch Event News
        const { data: newsData, error: newsError } = await supabaseAdmin
            .from('event_news')
            .select('*')
            .eq('event_id', id)
            .order('created_at', { ascending: false });

        // Attach news to event object (even if empty or error, don't fail the whole request)
        if (newsData) {
            eventData.news = newsData;
        } else {
            eventData.news = [];
        }

        res.json({ success: true, event: eventData });
    } catch (err) {
        console.error("Fetch Event Error:", err);
        res.status(500).json({ message: err.message || "Internal Server Error" });
    }
});

/* ================= FETCH EVENT BRACKETS (PUBLIC) ================= */
router.get('/:id/brackets', async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabaseAdmin
            .from('event_brackets')
            .select('*')
            .eq('event_id', id)
            .order('created_at', { ascending: true });

        if (error) throw error;

        res.json({ success: true, brackets: data || [] });
    } catch (err) {
        console.error("Fetch Brackets Error:", err);
        res.status(500).json({ message: err.message || "Internal Server Error" });
    }
});

/* ================= FETCH EVENT SPONSORS (PUBLIC) ================= */
router.get('/:id/sponsors', async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabaseAdmin
            .from('events')
            .select('sponsors')
            .eq('id', id)
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: "Event not found" });

        res.json({ success: true, sponsors: data.sponsors || [] });
    } catch (err) {
        console.error("Fetch Sponsors Error:", err);
        res.status(500).json({ message: err.message || "Internal Server Error" });
    }
});

/* ================= UPDATE EVENT (PROTECTED) ================= */
router.put('/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        // Sanitize Date Fields (Postgres fails on empty strings)
        ['start_date', 'end_date', 'registration_deadline'].forEach(field => {
            if (updates[field] === "") updates[field] = null;
        });

        console.log(`Updating event ${id}`);

        // 1. Handle Banner Image
        if (updates.banner_image) {
            const bannerUrl = await uploadBase64(updates.banner_image, 'event-assets', 'banners');
            updates.banner_url = bannerUrl;
            updates.banner_url = bannerUrl;
            delete updates.banner_image;
        }

        // 1b. Handle Payment QR Image
        if (updates.payment_qr_image && updates.payment_qr_image.startsWith('data:')) {
            const qrUrl = await uploadBase64(updates.payment_qr_image, 'event-assets', 'payment-qrs');
            updates.payment_qr_image = qrUrl;
        } else if (updates.payment_qr_image === null) {
            // Explicit removal if user cleared it?
            // updates.payment_qr_image = null; 
        }

        // 2. Handle Document (PDF)
        if (updates.document_file) {
            // Upload Base64 to Storage
            const docUrl = await uploadBase64(updates.document_file, 'event-documents', 'docs');
            // Assign URL to DB column
            updates.document_url = docUrl;
        }
        // Always remove the Base64 input field so Supabase doesn't error (it's not a column)
        delete updates.document_file;

        // 3. Handle Sponsors
        if (updates.sponsors && Array.isArray(updates.sponsors)) {
            const processedSponsors = await Promise.all(updates.sponsors.map(async (sp) => {
                const logoUrl = await uploadBase64(sp.logo, 'event-assets', 'sponsors');
                let mediaItems = [];
                if (sp.mediaItems && Array.isArray(sp.mediaItems)) {
                    mediaItems = await Promise.all(sp.mediaItems.map(async (media) => {
                        const url = await uploadBase64(media.url, 'event-assets', 'sponsor-media');
                        return { ...media, url };
                    }));
                }
                return { ...sp, logo: logoUrl, mediaItems };
            }));
            updates.sponsors = processedSponsors;
        }

        // Exclude protected/irrelevant fields
        delete updates.id;
        delete updates.created_at;
        delete updates.created_by;

        const { data, error } = await supabaseAdmin
            .from('events')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, event: data });
    } catch (err) {
        console.error("Update Event Error:", err);
        res.status(500).json({ message: err.message || "Internal Server Error" });
    }
});

/* ================= DELETE EVENT (PROTECTED) ================= */
router.delete('/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        console.log(`Deleting event ${id}`);

        const { error } = await supabaseAdmin
            .from('events')
            .delete()
            .eq('id', id);

        if (error) throw error;

        res.json({ success: true, message: "Event deleted successfully" });
    } catch (err) {
        console.error("Delete Event Error:", err);
        res.status(500).json({ message: err.message || "Internal Server Error" });
    }
});

export default router;
