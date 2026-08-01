import { supabaseAdmin } from "../config/supabaseClient.js";
import { cacheGet, cacheSet } from "../config/redisClient.js";
import { getPublicEventId, resolveEventIdByIdentifier } from "../utils/eventResolver.js";
// The single rule for "which rows belong to this category?" — see utils/categoryKeys.js.
import { fetchCategoryBracketRows, isUuid } from "../utils/categoryKeys.js";

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
    const targetId = String(categoryId || "").trim();

    // For sub-round IDs like `uuid_R2`, also check the BASE UUID
    const subRoundMatch = targetId.match(/^(.+)_R\d+$/i);
    const baseUUID = subRoundMatch ? subRoundMatch[1].trim() : null;

    // Build targeted queries instead of fetching ALL published rows
    const queries = [];

    if (targetId && isUuid(targetId)) {
        queries.push(
            supabaseAdmin
                .from("event_brackets")
                .select("id")
                .eq("event_id", eventId)
                .eq("category_id", targetId)
                .eq("published", true)
                .limit(1)
        );
    }

    if (targetId) {
        queries.push(
            supabaseAdmin
                .from("event_brackets")
                .select("id")
                .eq("event_id", eventId)
                .eq("category", targetId)
                .eq("published", true)
                .limit(1)
        );
    }

    // Sub-round fallback: if uuid_R2, check if base uuid is published
    if (baseUUID) {
        if (isUuid(baseUUID)) {
            queries.push(
                supabaseAdmin
                    .from("event_brackets")
                    .select("id")
                    .eq("event_id", eventId)
                    .eq("category_id", baseUUID)
                    .eq("published", true)
                    .limit(1)
            );
        }
        queries.push(
            supabaseAdmin
                .from("event_brackets")
                .select("id")
                .eq("event_id", eventId)
                .eq("category", baseUUID)
                .eq("published", true)
                .limit(1)
        );
    }

    const results = await Promise.all(queries);
    return results.some(({ data }) => Array.isArray(data) && data.length > 0);
};

/**
 * Columns the public events list actually serves.
 *
 * Replaces `select("*")`, which shipped all 31 event columns — including
 * qr_code, payment_qr_image and upi_id, i.e. payment credentials, on an
 * unauthenticated endpoint. Everything listed here is read by a consumer;
 * anything not listed had no reader. Add a column here if a client needs it.
 */
const PUBLIC_EVENT_LIST_COLUMNS = [
    "id",
    "public_id",
    "name",
    "sport",
    "location",
    "venue",
    "start_date",
    "end_date",
    "start_time",
    "banner_url",
    "categories",
    "created_at",
].join(", ");

/** Public events list cache lifetime, seconds. Override with EVENTS_LIST_CACHE_TTL_SECONDS. */
const EVENTS_LIST_CACHE_TTL = Number(process.env.EVENTS_LIST_CACHE_TTL_SECONDS || 300);

/**
 * Cache key. The endpoint takes no page/filter/search/sort parameters — the
 * client fetches the list once and filters, sorts and paginates in memory — so
 * there is exactly one response variant and the key is a constant. Parameter
 * segments would be dead weight here; add them only if the endpoint ever grows
 * real query parameters.
 */
const EVENTS_LIST_CACHE_KEY = "public:events:list";

// GET /api/public/events/list
export const listPublicEvents = async (_req, res) => {
    try {
        // Cache-aside: serve the public events list from Redis when warm.
        const cached = await cacheGet(EVENTS_LIST_CACHE_KEY);
        if (cached) {
            console.log(`[events:list] cache HIT  ${EVENTS_LIST_CACHE_KEY}`);
            return res.json({ success: true, events: cached });
        }
        console.log(`[events:list] cache MISS ${EVENTS_LIST_CACHE_KEY}`);

        // The dropped `event_registrations(count)` embed made PostgREST run a
        // correlated count per event — 17 sequential scans of an event_registrations
        // table that has no index on event_id (1088 shared buffers vs ~30 without).
        // No consumer read the result.
        const { data, error } = await supabaseAdmin
            .from("events")
            .select(PUBLIC_EVENT_LIST_COLUMNS)
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

        await cacheSet(EVENTS_LIST_CACHE_KEY, events, EVENTS_LIST_CACHE_TTL);
        return res.json({ success: true, events });
    } catch (err) {
        console.error("PUBLIC EVENTS LIST ERROR:", err);
        return res.status(500).json({ success: false, message: "Failed to fetch public events", events: [] });
    }
};

// GET /api/public/settings
export const getPublicSettings = async (req, res) => {
    try {
        // Cache-aside: settings change rarely — cache for 2 min.
        const cached = await cacheGet("public:settings");
        if (cached) return res.json({ success: true, settings: cached });

        const { data: settings, error } = await supabaseAdmin
            .from("platform_settings")
            .select("platform_name, logo_url, support_email, support_phone, logo_size, registration_config")
            .eq("id", 1)
            .maybeSingle();

        if (error) throw error;

        const payload = settings || { platform_name: 'Sports Paramount', logo_url: '' };
        await cacheSet("public:settings", payload, 120);
        res.json({ success: true, settings: payload });
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

        if (!categoryId && !categoryLabel) {
            return res.status(400).json({ message: "Category ID or label required" });
        }

        // A non-UUID category id had NO branch here at all: the UUID test failed, the
        // public app deliberately sends no categoryLabel (a name-based lookup can
        // match a same-named sibling category), and the fall-through returned 400.
        // Every category the event form creates has a numeric-string id, so the
        // public draw endpoint answered 400 for all of them.
        //
        // The shared resolver keeps the strict UUID behaviour intact and adds the
        // id-in-`category` case that brackets are actually stored under.
        let data = await fetchCategoryBracketRows(eventId, categoryId, categoryLabel);

        // Additional safety: if we got results via label lookup but one of the rows has a
        // different UUID category_id, filter those out to prevent cross-category leaking.
        if (data.length > 0 && !categoryIsUuid && categoryId) {
            const exactIdMatches = data.filter(row =>
                !row.category_id || !isUuid(row.category_id) || row.category_id === categoryId
            );
            if (exactIdMatches.length > 0) {
                data = exactIdMatches;
            }
        }

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

        // Group by category_id or category label.
        // `category` holds the category ID itself for every non-UUID category (the
        // id-keyed form), so reporting it as `categoryLabel` with a null
        // `categoryId` hands callers a "label" of "1785400000042" and no id to
        // match on. Detect that shape and report it as the id it is.
        const categoryMap = {};
        for (const row of (data || [])) {
            const key = row.category_id || row.category || row.id;
            if (!categoryMap[key]) {
                const catStr = row.category || "";
                const isIdKeyed = Boolean(catStr) && /^\d/.test(catStr) && !catStr.includes(" ");
                categoryMap[key] = {
                    categoryId: row.category_id || (isIdKeyed ? catStr : null),
                    categoryLabel: isIdKeyed ? null : row.category,
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
