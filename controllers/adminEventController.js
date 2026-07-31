import { supabaseAdmin } from "../config/supabaseClient.js";
import { createNotification } from "../services/notificationService.js";
import { uploadBase64 } from "../utils/uploadHelper.js";
import { sendRegistrationStatusWhatsApp } from "../utils/whatsapp.js";
import { invalidateMatchesCache } from "../utils/matchesCache.js";

// Fire-and-forget WhatsApp status update to the registration's player
const notifyRegistrationStatusWhatsApp = (playerId, eventName, registrationNo, status) => {
    (async () => {
        try {
            const { data: user } = await supabaseAdmin
                .from("users")
                .select("first_name, mobile")
                .eq("id", playerId)
                .maybeSingle();
            if (user?.mobile) {
                await sendRegistrationStatusWhatsApp(user.mobile, {
                    playerName: user.first_name,
                    eventName,
                    registrationNo,
                    status,
                });
            }
        } catch (e) { console.error("Registration status WhatsApp error:", e.message); }
    })();
};

/* ================= CATEGORIES ================= */
export const getAllCategories = async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin.from("events").select("categories");
        if (error) throw error;

        const uniqueCategories = new Set(["All Categories"]);
        data.forEach(event => {
            let cats = event.categories;
            if (typeof cats === 'string') try { if (cats.startsWith('[')) cats = JSON.parse(cats); } catch (e) { }

            const addCat = (cat) => {
                const name = cat.name || cat.category || cat.Category || cat.id;
                if (name) uniqueCategories.add(name);
                else if (typeof cat === 'string') uniqueCategories.add(cat);
            };

            if (Array.isArray(cats)) cats.forEach(addCat);
            else if (typeof cats === 'object' && cats !== null) addCat(cats);
            else if (cats) uniqueCategories.add(String(cats));
        });

        res.json({ success: true, categories: Array.from(uniqueCategories).sort() });
    } catch (err) {
        console.error("Error fetching categories:", err);
        res.status(500).json({ success: false, message: "Server Error" });
    }
};

/* ================= REGISTRATIONS & TRANSACTIONS ================= */
export const getRegistrations = async (req, res) => {
    try {
        const { eventId, admin_id, page, limit } = req.query;
        let query = supabaseAdmin.from("event_registrations")
            .select(`
                id, event_id, player_id, team_id, registration_no, status, amount_paid, payment_proof:screenshot_url, manual_transaction_id, transaction_id, created_at, categories, document_url,
                events ( id, name, sport, start_date, end_date, start_time, location, venue, categories, status ),
                users:player_id ( id, first_name, last_name, player_id, mobile, email, gender, apartment ),
                player_teams ( id, team_name, captain_name, captain_mobile, members )
            `, { count: 'exact' })
            .order('created_at', { ascending: false });

        if (eventId) query = query.eq('event_id', eventId);

        const requestingAdminId = req.user?.role === 'superadmin'
            ? null
            : (admin_id || req.user?.id);

        if (requestingAdminId) {
            // Run both queries concurrently to avoid sequential round-trips
            const [directResult, assignmentResult] = await Promise.all([
                supabaseAdmin.from('events').select('id').or(`created_by.eq.${requestingAdminId},assigned_to.eq.${requestingAdminId}`),
                supabaseAdmin.from('event_admin_assignments').select('event_id').eq('admin_id', requestingAdminId),
            ]);

            if (directResult.error) throw directResult.error;
            if (assignmentResult.error) {
                if (assignmentResult.error.code === '42P01') {
                    console.warn('[getRegistrations] event_admin_assignments table does not exist — multi-assignment filter skipped.');
                } else {
                    throw assignmentResult.error;
                }
            }

            const allowedEventIds = new Set();
            (directResult.data || []).forEach((eventRow) => allowedEventIds.add(eventRow.id));
            (assignmentResult.data || []).forEach((row) => allowedEventIds.add(row.event_id));

            const eventIds = Array.from(allowedEventIds).filter((value) => value !== null && value !== undefined);
            if (eventIds.length === 0) {
                return res.json({ success: true, registrations: [] });
            }

            query = query.in('event_id', eventIds);
        }

        if (page && limit) {
            const pageNum = parseInt(page, 10);
            const limitNum = parseInt(limit, 10);
            const from = (pageNum - 1) * limitNum;
            const to = from + limitNum - 1;
            query = query.range(from, to);
        }

        const { data: registrations, count, error } = await query;
        if (error) throw error;
        res.json({ success: true, registrations, total_count: count });
    } catch (err) {
        console.error("ADMIN REGISTRATIONS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch registrations" });
    }
};

export const getTransactions = async (req, res) => {
    try {
        const { eventId, admin_id, page, limit } = req.query;
        let query = supabaseAdmin.from("event_registrations")
            .select(`
                id, event_id, player_id, registration_no, status, amount_paid, payment_proof:screenshot_url, manual_transaction_id, transaction_id, created_at, categories,
                events ( id, name, created_by, assigned_to ),
                users:player_id ( id, first_name, last_name, player_id, mobile, email, apartment ),
                transactions:transaction_id ( id, payment_mode, payment_id, order_id )
            `, { count: 'exact' })
            .order('created_at', { ascending: false });

        if (eventId) query = query.eq('event_id', eventId);
        if (admin_id) {
            // Run both queries concurrently to avoid sequential round-trips
            const [directResult, assignmentResult] = await Promise.all([
                supabaseAdmin.from('events').select('id').or(`created_by.eq.${admin_id},assigned_to.eq.${admin_id}`),
                supabaseAdmin.from('event_admin_assignments').select('event_id').eq('admin_id', admin_id),
            ]);

            if (directResult.error) throw directResult.error;
            if (assignmentResult.error) {
                if (assignmentResult.error.code === '42P01') {
                    console.warn('[getTransactions] event_admin_assignments table does not exist — multi-assignment filter skipped.');
                } else {
                    throw assignmentResult.error;
                }
            }

            const allowedEventIds = new Set();
            (directResult.data || []).forEach((eventRow) => allowedEventIds.add(eventRow.id));
            (assignmentResult.data || []).forEach((row) => allowedEventIds.add(row.event_id));

            const eventIds = Array.from(allowedEventIds).filter((value) => value !== null && value !== undefined);
            if (eventIds.length === 0) {
                return res.json({ success: true, transactions: [] });
            }

            query = query.in('event_id', eventIds);
        }

        if (page && limit) {
            const pageNum = parseInt(page, 10);
            const limitNum = parseInt(limit, 10);
            const from = (pageNum - 1) * limitNum;
            const to = from + limitNum - 1;
            query = query.range(from, to);
        }

        const { data: transactions, count, error } = await query;
        if (error) throw error;
        res.json({ success: true, transactions, total_count: count });
    } catch (err) {
        console.error("ADMIN TRANSACTIONS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch transactions" });
    }
};

export const verifyTransaction = async (req, res) => {
    try {
        const { id } = req.params;
        const { data: updatedReg, error } = await supabaseAdmin
            .from("event_registrations")
            .update({ status: "verified" })
            .eq("id", id)
            .select("player_id, registration_no, events(name)")
            .maybeSingle();

        if (error) throw error;
        if (updatedReg) {
            createNotification(
                updatedReg.player_id,
                "Registration Verified",
                `Your registration for ${updatedReg.events?.name} (Reg No: ${updatedReg.registration_no}) has been verified.`,
                "success"
            );
            notifyRegistrationStatusWhatsApp(updatedReg.player_id, updatedReg.events?.name, updatedReg.registration_no, "Verified");
        }
        res.json({ success: true, message: "Transaction verified" });
    } catch (err) {
        console.error("VERIFY ERROR:", err);
        res.status(500).json({ message: "Verification failed" });
    }
};

export const rejectTransaction = async (req, res) => {
    try {
        const { id } = req.params;
        const { data: updatedReg, error } = await supabaseAdmin
            .from("event_registrations")
            .update({ status: "rejected" })
            .eq("id", id)
            .select("player_id, registration_no, events(name)")
            .maybeSingle();

        if (error) throw error;
        if (updatedReg) {
            createNotification(
                updatedReg.player_id,
                "Registration Rejected",
                `Your registration for ${updatedReg.events?.name} (Reg No: ${updatedReg.registration_no}) was rejected.`,
                "error"
            );
            notifyRegistrationStatusWhatsApp(updatedReg.player_id, updatedReg.events?.name, updatedReg.registration_no, "Rejected");
        }
        res.json({ success: true, message: "Transaction rejected" });
    } catch (err) {
        console.error("REJECT ERROR:", err);
        res.status(500).json({ message: "Rejection failed" });
    }
};

export const bulkUpdateTransactions = async (req, res) => {
    try {
        const { ids, status } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: "Invalid IDs" });
        if (!['verified', 'rejected'].includes(status)) return res.status(400).json({ message: "Invalid status" });

        const { data: updatedRegs, error, count } = await supabaseAdmin
            .from("event_registrations")
            .update({ status })
            .in("id", ids)
            .select('id, player_id, registration_no, events(name)');

        if (error) throw error;

        if (updatedRegs) {
            const statusLabel = status === 'verified' ? "Verified" : "Rejected";
            updatedRegs.forEach(reg => {
                const title = status === 'verified' ? "Registration Verified" : "Registration Rejected";
                const type = status === 'verified' ? "success" : "error";
                const msg = `Your registration for ${reg.events?.name} (Reg No: ${reg.registration_no}) was ${status}.`;
                createNotification(reg.player_id, title, msg, type);
                notifyRegistrationStatusWhatsApp(reg.player_id, reg.events?.name, reg.registration_no, statusLabel);
            });
        }
        res.json({ success: true, message: `Transactions ${status}`, count });
    } catch (err) {
        console.error("BULK UPDATE ERROR:", err);
        res.status(500).json({ message: "Batch update failed" });
    }
};

/* ================= NEWS ================= */
export const getEventNews = async (req, res) => {
    try {
        const { eventId } = req.query;
        if (!eventId) return res.status(400).json({ message: "Event ID required" });
        const { data: news, error } = await supabaseAdmin.from("event_news").select("*").eq("event_id", eventId).order("created_at", { ascending: false });
        if (error) throw error;
        res.json({ success: true, news });
    } catch (err) {
        res.status(500).json({ message: "Failed to fetch news" });
    }
};

export const createEventNews = async (req, res) => {
    try {
        const { eventId, title, content, imageUrl, isHighlight } = req.body;
        const { data, error } = await supabaseAdmin.from("event_news")
            .insert({ event_id: eventId, title, content, image_url: imageUrl, is_highlight: isHighlight })
            .select().maybeSingle();
        if (error) throw error;
        res.json({ success: true, news: data });
    } catch (err) { res.status(500).json({ message: "Failed to create news" }); }
};

export const updateEventNews = async (req, res) => {
    try {
        const { id } = req.params;
        const { title, content, imageUrl, isHighlight } = req.body;
        const { data, error } = await supabaseAdmin.from("event_news")
            .update({ title, content, image_url: imageUrl, is_highlight: isHighlight }).eq("id", id).select().maybeSingle();
        if (error) throw error;
        res.json({ success: true, news: data });
    } catch (err) { res.status(500).json({ message: "Failed to update news" }); }
};

export const deleteEventNews = async (req, res) => {
    try {
        const { error } = await supabaseAdmin.from("event_news").delete().eq("id", req.params.id);
        if (error) throw error;
        res.json({ success: true, message: "News deleted" });
    } catch (err) { res.status(500).json({ message: "Failed to delete news" }); }
};

/* ================= BRACKETS ================= */
export const getBrackets = async (req, res) => {
    try {
        const { eventId } = req.query;
        if (!eventId) return res.status(400).json({ message: "Event ID required" });
        const { data, error } = await supabaseAdmin.from("event_brackets").select("*").eq("event_id", eventId).order("created_at", { ascending: true });
        if (error) throw error;
        res.json({ success: true, brackets: data });
    } catch (err) { res.status(500).json({ message: "Failed to fetch brackets" }); }
};

export const saveBracket = async (req, res) => {
    try {
        const { eventId, category, roundName, drawType, drawData, pdfUrl } = req.body;
        let finalDrawData = drawData;
        let finalPdfUrl = null;

        if (drawType === 'image') {
            // Handle multiple images format (new)
            if (drawData?.images && Array.isArray(drawData.images)) {
                const uploadedImages = [];

                for (const img of drawData.images) {
                    // If image URL is base64, upload it
                    if (img.url?.startsWith('data:')) {
                        const uploadedUrl = await uploadBase64(img.url, 'event-assets', 'draws');
                        if (uploadedUrl) {
                            uploadedImages.push({
                                id: img.id || `img-${Date.now()}-${Math.random()}`,
                                url: uploadedUrl,
                                description: img.description || ""
                            });
                        }
                    } else {
                        // Already uploaded URL, keep as is
                        uploadedImages.push({
                            id: img.id || `img-${Date.now()}-${Math.random()}`,
                            url: img.url,
                            description: img.description || ""
                        });
                    }
                }

                finalDrawData = { images: uploadedImages };
            }
            // Handle old single image format (backward compatibility)
            else if (drawData?.url?.startsWith('data:')) {
                const url = await uploadBase64(drawData.url, 'event-assets', 'draws');
                if (url) {
                    finalDrawData = {
                        images: [{
                            id: `img-${Date.now()}-${Math.random()}`,
                            url: url,
                            description: drawData.description || ""
                        }]
                    };
                }
            }
            // If single URL already uploaded (backward compatibility)
            else if (drawData?.url) {
                finalDrawData = {
                    images: [{
                        id: `img-${Date.now()}-${Math.random()}`,
                        url: drawData.url,
                        description: drawData.description || ""
                    }]
                };
            }
        }

        // Handle PDF upload
        if (pdfUrl !== undefined) {
            if (pdfUrl === null) {
                // Clear PDF URL
                finalPdfUrl = null;
            } else if (pdfUrl.startsWith('data:')) {
                // Upload PDF from base64
                finalPdfUrl = await uploadBase64(pdfUrl, 'event-assets', 'draws');
            } else {
                // Already a URL, keep as is
                finalPdfUrl = pdfUrl;
            }
        }

        const { data: existing } = await supabaseAdmin.from("event_brackets").select("id, draw_type, draw_data").eq("event_id", eventId).eq("category", category).eq("round_name", roundName).maybeSingle();

        let result;

        if (existing) {
            // Update existing bracket - preserve existing draw_data when only updating pdf_url
            const updateData = {};

            // Always preserve existing draw_data first
            updateData.draw_data = existing.draw_data || {};

            // Only update draw_type if provided
            if (drawType) {
                updateData.draw_type = drawType;
            }

            // Only update draw_data if new data is provided and different from existing
            if (finalDrawData && Object.keys(finalDrawData).length > 0) {
                // Check if we're actually updating draw_data (not just pdf_url)
                const hasNewImages = finalDrawData.images && Array.isArray(finalDrawData.images) && finalDrawData.images.length > 0;
                const hasNewMatches = finalDrawData.matches && Array.isArray(finalDrawData.matches) && finalDrawData.matches.length > 0;
                const hasExistingImages = existing.draw_data?.images && Array.isArray(existing.draw_data.images) && existing.draw_data.images.length > 0;
                const hasExistingMatches = existing.draw_data?.matches && Array.isArray(existing.draw_data.matches) && existing.draw_data.matches.length > 0;

                // If we have new images or matches, update draw_data
                if (hasNewImages) {
                    const existingImages = existing.draw_data?.images || [];
                    const existingUrls = new Set(existingImages.map(img => typeof img === 'string' ? img : (img.url || img)));
                    const newImages = finalDrawData.images.filter(img => {
                        const imgUrl = typeof img === 'string' ? img : (img.url || img);
                        return !existingUrls.has(imgUrl);
                    });
                    updateData.draw_data = {
                        ...(existing.draw_data || {}),
                        images: [...existingImages, ...newImages]
                    };
                } else if (hasNewMatches) {
                    // For bracket type, replace matches
                    updateData.draw_data = {
                        ...(existing.draw_data || {}),
                        matches: finalDrawData.matches
                    };
                }
                // If no new images/matches, keep existing draw_data (already set above)
            }

            // Only update pdf_url if it's explicitly provided
            if (pdfUrl !== undefined) {
                updateData.pdf_url = finalPdfUrl;
            }

            const { data, error } = await supabaseAdmin.from("event_brackets").update(updateData).eq("id", existing.id).select().maybeSingle();
            if (error) throw error;
            result = data;
        } else {
            // Insert new bracket
            const insertData = {
                event_id: eventId,
                category,
                round_name: roundName,
                draw_type: drawType || 'image',
                draw_data: finalDrawData || { images: [] }
            };
            if (pdfUrl !== undefined) {
                insertData.pdf_url = finalPdfUrl;
            }
            const { data, error } = await supabaseAdmin.from("event_brackets").insert(insertData).select().maybeSingle();
            if (error) throw error;
            result = data;
        }
        res.json({ success: true, bracket: result });
    } catch (err) {
        console.error("SAVE BRACKET ERROR:", err);
        res.status(500).json({ message: "Failed to save bracket" });
    }
};

export const deleteBracket = async (req, res) => {
    try {
        const bracketId = req.params.id;
        if (!bracketId) {
            return res.status(400).json({ success: false, message: "Bracket id is required" });
        }

        // Fetch bracket to know event/category for match cleanup
        const { data: bracket, error: fetchError } = await supabaseAdmin
            .from("event_brackets")
            .select("id,event_id,category_id,category")
            .eq("id", bracketId)
            .maybeSingle();

        if (fetchError) throw fetchError;
        if (!bracket) {
            return res.status(404).json({ success: false, message: "Bracket not found" });
        }

        const { event_id: eventId, category_id: categoryId, category } = bracket;

        // Best-effort: delete all matches for this event+category from scoreboard
        try {
            let matchQuery = supabaseAdmin
                .from("matches")
                .delete()
                .eq("event_id", eventId)
                .select("id");

            if (categoryId) {
                matchQuery = matchQuery.eq("category_id", categoryId);
            } else if (category) {
                matchQuery = matchQuery.eq("category_id", category);
            }

            const { error: deleteMatchesError } = await matchQuery;
            if (deleteMatchesError) {
                console.error("Failed to delete matches when deleting bracket:", deleteMatchesError);
            }
        } catch (matchErr) {
            console.error("Error while deleting matches for bracket:", matchErr);
        }

        const { error: deleteBracketError } = await supabaseAdmin
            .from("event_brackets")
            .delete()
            .eq("id", bracketId);

        if (deleteBracketError) throw deleteBracketError;
        await invalidateMatchesCache(eventId);
        res.json({ success: true, message: "Bracket and related matches deleted" });
    } catch (err) {
        console.error("DELETE BRACKET ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to delete bracket" });
    }
};