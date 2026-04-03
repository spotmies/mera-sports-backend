import { supabaseAdmin } from "../config/supabaseClient.js";
import { getPublicEventId, resolveEventIdByIdentifier } from "../utils/eventResolver.js";

// Simple UUID v4 validator
const isUuid = (value) => {
    if (!value || typeof value !== "string") return false;
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        value.trim()
    );
};

/**
 * Sanitize a string for safe use in Supabase ilike / eq filters.
 * Strips characters that could be used for SQL/PostgREST injection:
 *   - Removes parentheses, semicolons, single/double quotes, backslashes, commas
 *   - Escapes SQL LIKE wildcards (% and _) so they match literally
 *   - Trims and limits length to 200 chars
 */
const sanitizeFilterInput = (value) => {
    if (!value || typeof value !== 'string') return '';
    return value
        .replace(/[()';"\\,]/g, '')  // strip dangerous chars
        .replace(/%/g, '\\%')        // escape LIKE wildcard
        .replace(/_/g, '\\_')        // escape LIKE wildcard
        .trim()
        .slice(0, 200);
};

const normalizeText = (value) => String(value || "").trim().toLowerCase();

const isLeagueCategoryPublishedForPublic = async ({ eventId, categoryId, categoryLabel }) => {
    const { data: publishedRows, error } = await supabaseAdmin
        .from("event_brackets")
        .select("category_id, category")
        .eq("event_id", eventId)
        .eq("published", true);

    if (error) throw error;
    if (!Array.isArray(publishedRows) || publishedRows.length === 0) return false;

    const targetId = String(categoryId || "").trim();
    const targetLabel = String(categoryLabel || "").trim();
    const targetIdNormalized = normalizeText(targetId);
    const targetLabelNormalized = normalizeText(targetLabel);

    return publishedRows.some((row) => {
        const rowCategoryId = String(row?.category_id || "").trim();
        const rowCategoryLabel = String(row?.category || "").trim();
        const rowCategoryIdNormalized = normalizeText(rowCategoryId);
        const rowCategoryLabelNormalized = normalizeText(rowCategoryLabel);

        // 1) Exact UUID category_id match (most reliable)
        if (targetId && isUuid(targetId) && rowCategoryId && rowCategoryId === targetId) return true;

        // 2) Label match (used for non-UUID category ids and legacy draws)
        if (targetLabel && rowCategoryLabelNormalized && rowCategoryLabelNormalized === targetLabelNormalized) return true;

        // 3) Fallback: when category id is stored in label for non-UUID categories
        if (targetId && !isUuid(targetId) && rowCategoryLabelNormalized && rowCategoryLabelNormalized === targetIdNormalized) return true;

        // 4) Additional fallback: compare normalized category_id text values
        if (targetId && rowCategoryIdNormalized && rowCategoryIdNormalized === targetIdNormalized) return true;

        return false;
    });
};

// GET /api/public/events/list
export const listPublicEvents = async (_req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("events")
            .select("*, event_registrations(count)")
            .order("start_date", { ascending: true });

        if (error) throw error;

        const events = (data || []).map((event) => {
            const publicId = getPublicEventId(event);
            const { id: _internalId, ...rest } = event;
            return {
                ...rest,
                id: publicId,
                public_id: publicId,
            };
        });

        return res.json({ success: true, events });
    } catch (err) {
        console.error("PUBLIC EVENTS LIST ERROR:", err);
        return res.status(500).json({ success: false, message: "Failed to fetch public events", events: [] });
    }
};

// GET /api/public/settings
export const getPublicSettings = async (req, res) => {
    try {
        const { data: settings, error } = await supabaseAdmin
            .from("platform_settings")
            .select("platform_name, logo_url, support_email, support_phone, logo_size, registration_config")
            .eq("id", 1)
            .maybeSingle();

        if (error) throw error;

        res.json({
            success: true,
            settings: settings || { platform_name: 'Sports Paramount', logo_url: '' }
        });
    } catch (err) {
        console.error("PUBLIC SETTINGS ERROR:", err);
        res.json({
            success: true,
            settings: { platform_name: 'Sports Paramount', logo_url: '' }
        });
    }
};

/**
 * Public: Dynamic share preview page for messaging crawlers (WhatsApp/Telegram/etc.)
 * GET /api/public/events/:id/share
 * Returns HTML with OG tags and client-side redirect to the real event page.
 */
export const getPublicEventSharePreview = async (req, res) => {
        try {
            const { id: eventIdentifier } = req.params;
            if (!eventIdentifier) {
                return res.status(400).send("Missing event id");
            }

            const eventId = await resolveEventIdByIdentifier(eventIdentifier);
            if (!eventId) {
                return res.status(404).send("Event not found");
            }

            const { data: eventData, error } = await supabaseAdmin
                .from("events")
                .select("id, name, venue, city, start_date, end_date, registration_deadline, banner_url, categories")
                .eq("id", eventId)
                .maybeSingle();

            if (error || !eventData) {
                return res.status(404).send("Event not found");
            }

            const publicEventId = getPublicEventId(eventData);

            const publicBaseUrl = (process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || "http://localhost:8080").replace(/\/$/, "");
            const canonicalEventUrl = `${publicBaseUrl}/events/${publicEventId}`;

            const parseDateSafe = (value) => {
                const d = value ? new Date(value) : null;
                return d && !Number.isNaN(d.getTime()) ? d : null;
            };

            const getRegistrationDeadline = () => {
                const explicit = parseDateSafe(eventData.registration_deadline) || parseDateSafe(eventData.end_date);
                if (explicit) return explicit;

                if (Array.isArray(eventData.categories)) {
                    const dates = eventData.categories
                        .map((cat) => parseDateSafe(cat?.lastDateToRegister || cat?.last_date_to_register))
                        .filter(Boolean);
                    if (dates.length > 0) {
                        return new Date(Math.max(...dates.map((d) => d.getTime())));
                    }
                }

                return parseDateSafe(eventData.start_date);
            };

            const startDate = parseDateSafe(eventData.start_date);
            const regDeadline = getRegistrationDeadline();
            const formatDate = (d) => {
                if (!d) return "N/A";
                const day = String(d.getDate()).padStart(2, "0");
                const month = String(d.getMonth() + 1).padStart(2, "0");
                const year = d.getFullYear();
                return `${day}-${month}-${year}`;
            };

            const title = String(eventData.name || "Sports Event");
            const venue = [eventData.venue, eventData.city].filter(Boolean).join(", ") || "Venue TBD";
            const description = `Register for ${title}. Event Date: ${formatDate(startDate)}. Registration Ends: ${formatDate(regDeadline)}. Venue: ${venue}.`;
            const imageUrl = String(eventData.banner_url || `${publicBaseUrl}/default-event-banner.png`);

            const escapeHtml = (value) => String(value || "")
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/\"/g, "&quot;")
                .replace(/'/g, "&#39;");

            const html = `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(title)}</title>
        <meta name="description" content="${escapeHtml(description)}" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="${escapeHtml(title)}" />
        <meta property="og:description" content="${escapeHtml(description)}" />
        <meta property="og:url" content="${escapeHtml(canonicalEventUrl)}" />
        <meta property="og:image" content="${escapeHtml(imageUrl)}" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="${escapeHtml(title)}" />
        <meta name="twitter:description" content="${escapeHtml(description)}" />
        <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
        <meta http-equiv="refresh" content="0;url=${escapeHtml(canonicalEventUrl)}" />
        <script>window.location.replace(${JSON.stringify(canonicalEventUrl)});</script>
      </head>
      <body>
        <p>Redirecting to event page...</p>
        <a href="${escapeHtml(canonicalEventUrl)}">${escapeHtml(canonicalEventUrl)}</a>
      </body>
    </html>`;

            res.setHeader("Content-Type", "text/html; charset=utf-8");
            return res.status(200).send(html);
        } catch (err) {
            console.error("PUBLIC EVENT SHARE PREVIEW ERROR:", err);
            return res.status(500).send("Failed to build share preview");
        }
};

/**
 * Public: Get league config (participants + rules) for a category.
 * GET /api/public/events/:id/categories/:categoryId/league
 * Query: categoryLabel or category (optional fallback when categoryId is not present)
 */
export const getPublicLeagueConfig = async (req, res) => {
    try {
        const { id: eventIdentifier, categoryId } = req.params;
        const rawCategoryLabel = req.query.categoryLabel || req.query.category;
        const categoryLabel = rawCategoryLabel ? sanitizeFilterInput(rawCategoryLabel) : null;

        if (!eventIdentifier) {
            return res.status(400).json({ success: false, message: "Event ID required" });
        }

        const eventId = await resolveEventIdByIdentifier(eventIdentifier);
        if (!eventId) {
            return res.status(404).json({ success: false, message: "Event not found" });
        }

        if (!categoryId && !categoryLabel) {
            return res.status(400).json({ success: false, message: "Category ID or label required" });
        }

        let query = supabaseAdmin
            .from("leagues")
            .select("*")
            .eq("event_id", eventId);

        if (categoryId) {
            query = query.eq("category_id", String(categoryId));
        } else if (categoryLabel) {
            query = query.eq("category_label", categoryLabel);
        }

        let { data, error } = await query.maybeSingle();

        if (error && error.code !== "PGRST116") {
            throw error;
        }

        if (!data && categoryId && !isUuid(categoryId)) {
            const fallback = await supabaseAdmin
                .from("leagues")
                .select("*")
                .eq("event_id", eventId)
                .eq("category_label", String(categoryId))
                .maybeSingle();

            if (!fallback.error || fallback.error.code === "PGRST116") {
                data = fallback.data;
            }
        }

        if (!data) {
            return res.json({
                success: true,
                league: {
                    format: "LEAGUE",
                    participants: [],
                    rules: {
                        pointsWin: 3,
                        pointsLoss: 0,
                        pointsDraw: 1,
                        win: 3,
                        loss: 0,
                        draw: 1,
                    },
                },
            });
        }

        const isPublished = await isLeagueCategoryPublishedForPublic({
            eventId,
            categoryId: data.category_id || categoryId,
            categoryLabel: data.category_label || categoryLabel || categoryId,
        });

        if (!isPublished) {
            return res.json({
                success: true,
                league: {
                    format: "LEAGUE",
                    participants: [],
                    rules: {
                        pointsWin: 3,
                        pointsLoss: 0,
                        pointsDraw: 1,
                        win: 3,
                        loss: 0,
                        draw: 1,
                    },
                },
                published: false,
            });
        }

        const rawRules = data.rules || {};
        const pointsWin = Number(rawRules.pointsWin ?? rawRules.win ?? 3);
        const pointsLoss = Number(rawRules.pointsLoss ?? rawRules.loss ?? 0);
        const pointsDraw = Number(rawRules.pointsDraw ?? rawRules.draw ?? 1);

        return res.json({
            success: true,
            league: {
                format: rawRules.format === "HEAT" ? "HEAT" : "LEAGUE",
                participants: Array.isArray(data.participants) ? data.participants : [],
                rules: {
                    ...rawRules,
                    pointsWin: Number.isFinite(pointsWin) ? pointsWin : 3,
                    pointsLoss: Number.isFinite(pointsLoss) ? pointsLoss : 0,
                    pointsDraw: Number.isFinite(pointsDraw) ? pointsDraw : 1,
                    win: Number.isFinite(pointsWin) ? pointsWin : 3,
                    loss: Number.isFinite(pointsLoss) ? pointsLoss : 0,
                    draw: Number.isFinite(pointsDraw) ? pointsDraw : 1,
                },
            },
            published: true,
        });
    } catch (err) {
        console.error("PUBLIC GET LEAGUE CONFIG ERROR:", err);
        return res.status(500).json({ success: false, message: "Failed to fetch public league config" });
    }
};

/**
 * Public: Get published draw/bracket for a category
 * GET /api/public/events/:id/categories/:categoryId/draw
 * Query: categoryLabel or category (if no categoryId)
 * Only returns published draws.
 */
export const getPublicCategoryDraw = async (req, res) => {
    try {
        const { id: eventIdentifier, categoryId } = req.params;
        const rawCategoryLabel = req.query.categoryLabel || req.query.category;
        const categoryLabel = rawCategoryLabel ? sanitizeFilterInput(rawCategoryLabel) : null;

        if (!eventIdentifier) return res.status(400).json({ message: "Event ID required" });
        const eventId = await resolveEventIdByIdentifier(eventIdentifier);
        if (!eventId) return res.status(404).json({ message: "Event not found" });

        const categoryIsUuid = categoryId && isUuid(categoryId);

        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId);

        if (categoryIsUuid) {
            // STRICT: UUID-based lookup only — never fall back to label for UUID categories.
            // This prevents a bracket stored under the SAME display name but a DIFFERENT
            // category UUID from bleeding into this category's draw view.
            query = query.eq("category_id", categoryId);
        } else if (categoryLabel) {
            query = query.eq("category", categoryLabel);
        } else {
            return res.status(400).json({ message: "Category ID or label required" });
        }

        let { data, error } = await query.order("created_at", { ascending: true });

        // Partial matching fallback — ONLY for label-based lookups (no UUID).
        // When a UUID categoryId is provided, never attempt a label fallback.
        if ((!data || data.length === 0) && categoryLabel && !categoryIsUuid) {
            const labelParts = categoryLabel.split(" - ").filter(p => p.trim()).map(p => sanitizeFilterInput(p));
            if (labelParts.length > 0) {
                const baseCategory = sanitizeFilterInput(labelParts[0]);
                const { data: partialData, error: partialError } = await supabaseAdmin
                    .from("event_brackets")
                    .select("*")
                    .eq("event_id", eventId)
                    .ilike("category", `${baseCategory}%`)
                    .order("created_at", { ascending: true });

                if (!partialError && partialData && partialData.length > 0) {
                    if (partialData.length === 1) {
                        data = partialData;
                        error = null;
                    } else {
                        const exactishMatch = partialData.filter(row => {
                            const storedLabel = (row.category || "").toLowerCase();
                            return labelParts.every(part => storedLabel.includes(part.toLowerCase()));
                        });
                        if (exactishMatch.length > 0) {
                            data = exactishMatch;
                            error = null;
                        }
                    }
                }
            }
        }

        // Additional safety: if we got results via label lookup but one of the rows has a
        // different UUID category_id, filter those out to prevent cross-category leaking.
        if (data && data.length > 0 && !categoryIsUuid && categoryId) {
            const exactIdMatches = data.filter(row =>
                !row.category_id || !isUuid(row.category_id) || row.category_id === categoryId
            );
            if (exactIdMatches.length > 0) {
                data = exactIdMatches;
            }
        }

        if (error) throw error;

        // If no rows found at all, return empty draw
        if (!data || data.length === 0) {
            return res.json({
                success: true,
                draw: {
                    categoryId: categoryId || null,
                    categoryLabel: categoryLabel || null,
                    mode: null,
                    media: null,
                    bracket: null,
                    published: false
                }
            });
        }

        // Group by mode
        const mediaDraw = data.find(b => b.mode === 'MEDIA');
        const bracketDraw = data.find(b => b.mode === 'BRACKET');

        const hasActualMedia = mediaDraw && ((mediaDraw.media_urls && mediaDraw.media_urls.length > 0) || mediaDraw.pdf_url);

        // Only return published data to the public
        const isMediaPublished = mediaDraw && hasActualMedia && mediaDraw.published;
        const isBracketPublished = bracketDraw && bracketDraw.published;

        // If nothing is published, return empty draw
        if (!isMediaPublished && !isBracketPublished) {
            return res.json({
                success: true,
                draw: {
                    categoryId: categoryId || null,
                    categoryLabel: categoryLabel || data[0]?.category || null,
                    mode: null,
                    media: null,
                    bracket: null,
                    published: false
                }
            });
        }

        res.json({
            success: true,
            draw: {
                categoryId: categoryId || null,
                categoryLabel: categoryLabel || data[0]?.category,
                mode: isBracketPublished ? 'BRACKET' : (isMediaPublished ? 'MEDIA' : null),
                media: isMediaPublished ? {
                    id: mediaDraw.id,
                    urls: mediaDraw.media_urls || [],
                    pdfUrl: mediaDraw.pdf_url,
                    published: mediaDraw.published
                } : null,
                bracket: isBracketPublished ? {
                    id: bracketDraw.id,
                    roundStructure: bracketDraw.round_structure || [],
                    bracketData: bracketDraw.bracket_data || {},
                    published: bracketDraw.published
                } : null,
                published: true
            }
        });
    } catch (err) {
        console.error("PUBLIC GET CATEGORY DRAW ERROR:", err);
        res.status(500).json({ message: "Failed to fetch category draw", error: err.message });
    }
};


/**
 * Public: Get all published draws for an event
 * GET /api/public/events/:id/draws
 * Returns all published brackets/media draws grouped by category.
 */
export const getPublicEventDraws = async (req, res) => {
    try {
        const { id: eventIdentifier } = req.params;
        if (!eventIdentifier) return res.status(400).json({ message: "Event ID required" });
        const eventId = await resolveEventIdByIdentifier(eventIdentifier);
        if (!eventId) return res.status(404).json({ message: "Event not found" });

        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("published", true)
            .order("created_at", { ascending: true });

        if (error) throw error;

        // Group by category_id or category label
        const categoryMap = {};
        for (const row of (data || [])) {
            const key = row.category_id || row.category || row.id;
            if (!categoryMap[key]) {
                categoryMap[key] = {
                    categoryId: row.category_id,
                    categoryLabel: row.category,
                    media: null,
                    bracket: null
                };
            }
            if (row.mode === 'MEDIA') {
                const hasMedia = (row.media_urls && row.media_urls.length > 0) || row.pdf_url;
                if (hasMedia) {
                    categoryMap[key].media = {
                        id: row.id,
                        urls: row.media_urls || [],
                        pdfUrl: row.pdf_url
                    };
                }
            } else if (row.mode === 'BRACKET') {
                categoryMap[key].bracket = {
                    id: row.id,
                    roundStructure: row.round_structure || [],
                    bracketData: row.bracket_data || {}
                };
            }
        }

        // Convert to array and determine mode for each
        const draws = Object.values(categoryMap).map(cat => ({
            ...cat,
            mode: cat.bracket ? 'BRACKET' : (cat.media ? 'MEDIA' : null)
        }));

        res.json({ success: true, draws });
    } catch (err) {
        console.error("PUBLIC GET EVENT DRAWS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch event draws", error: err.message });
    }
};
