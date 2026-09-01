import { supabaseAdmin } from "../config/supabaseClient.js";
import { cacheDel, cacheGet, cacheSet } from "../config/redisClient.js";
import { uploadBase64, uploadBuffer } from "../utils/uploadHelper.js";

/**
 * Photos and videos for the venue page (/indoor-turf-hyderabad).
 *
 * The page's copy is static in the frontend — only the media lives here,
 * because that is the part the admin needs to change without a deploy.
 *
 * Photos are uploaded images. A video may be EITHER a link (YouTube / Vimeo)
 * or an uploaded file.
 *
 * Uploaded video does NOT go through this controller's JSON body — base64 in
 * JSON is capped at 15 MB by express and inflates a file by a third, which
 * tops out around 11 MB and is useless for a promo clip. Uploads go to
 * POST /media/upload as multipart instead, which bypasses the JSON parser
 * entirely; the storage layer beneath is an S3 PutObject and is comfortable
 * with far larger objects. That endpoint returns a URL, which is then saved
 * through the ordinary create/update below — so as far as the rest of this
 * file is concerned, every video is still just a URL.
 */

const VENUE_MEDIA_CACHE_KEY = "public:venue:media";

/** Cache lifetime, seconds. Writes bust the key, so this is only a safety net. */
const VENUE_MEDIA_CACHE_TTL = Number(process.env.VENUE_MEDIA_CACHE_TTL_SECONDS || 300);

/** Cleared after every admin write so a change is visible immediately. */
const invalidateVenueMediaCache = () => cacheDel(VENUE_MEDIA_CACHE_KEY);

/**
 * YouTube video id from any of the shapes people actually paste: watch?v=,
 * youtu.be/, /embed/, /shorts/. Returns null for anything else (Vimeo, a direct
 * .mp4, an Instagram link) — those simply get no derived thumbnail.
 */
const youTubeId = (url) => {
    const text = String(url || "").trim();
    if (!text) return null;
    const patterns = [
        /(?:youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/,
        /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
        /(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
        /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[1];
    }
    return null;
};

/**
 * Shape one row for the client, filling in what it can derive.
 *
 * `embed_url` is resolved here rather than in the frontend so the two apps (the
 * player site's player and the admin panel's preview) cannot disagree about
 * what a given link means.
 */
const shapeMedia = (row) => {
    const videoId = row.kind === "video" ? youTubeId(row.url) : null;
    return {
        id: row.id,
        kind: row.kind,
        url: row.url,
        caption: row.caption || "",
        sort_order: row.sort_order,
        is_active: row.is_active,
        created_at: row.created_at,
        thumbnail_url:
            row.thumbnail_url ||
            (videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : null),
        embed_url: videoId ? `https://www.youtube.com/embed/${videoId}` : null,
    };
};

/**
 * PostgREST's code for "this table is not in the schema cache" — in practice,
 * the migration has not been run against this environment yet.
 *
 * Worth naming explicitly: the generic "Failed to add media" this used to
 * return told the admin nothing, and the real cause (a missing table) is not
 * something they could have guessed from it.
 */
const TABLE_MISSING_CODE = "PGRST205";

/**
 * Admin-facing failure message. Admin routes are behind verifyAdmin, so naming
 * the setup step here is useful rather than leaky — the public endpoint keeps
 * its generic message.
 */
const adminFailure = (err, fallback) =>
    err?.code === TABLE_MISSING_CODE
        ? "Venue media storage is not set up yet — run scripts/venue_media_migration.sql against this environment's database, then try again."
        : err?.message || fallback;

/** Only these may be written; everything else in the body is ignored. */
const MAX_CAPTION_LENGTH = 200;
const MAX_URL_LENGTH = 2048;

const validateWrite = ({ kind, url, caption }) => {
    if (!["photo", "video"].includes(kind)) return "kind must be 'photo' or 'video'";
    if (!url || !String(url).trim()) return kind === "photo" ? "An image is required" : "A video link is required";
    if (String(url).length > MAX_URL_LENGTH && !String(url).startsWith("data:")) return "URL is too long";
    if (caption && String(caption).length > MAX_CAPTION_LENGTH) {
        return `Caption cannot exceed ${MAX_CAPTION_LENGTH} characters`;
    }
    // A video arrives here as a URL either way: pasted by the admin, or handed
    // back by POST /media/upload. A base64 payload is the one thing it must not
    // be — see the note at the top of the file.
    if (kind === "video" && String(url).startsWith("data:")) {
        return "Upload the video file through the upload endpoint rather than embedding it in this request";
    }
    return null;
};

/**
 * POST /api/venue/media/upload — admin, multipart.
 *
 * Takes one file under the field name "file" and returns its stored URL. The
 * caller then saves that URL with the ordinary create/update call. Kept as its
 * own step rather than folded into create so the two concerns stay separate:
 * a failed upload never leaves a half-written row, and the client can show
 * upload progress independently of the save.
 */
export const uploadVenueFile = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: "No file received" });

        const { buffer, mimetype, originalname } = req.file;
        const url = await uploadBuffer(buffer, mimetype, "event-assets", "venue", originalname);
        if (!url) return res.status(500).json({ success: false, message: "Upload to storage failed" });

        return res.json({ success: true, url, kind: mimetype.startsWith("video/") ? "video" : "photo" });
    } catch (err) {
        console.error("VENUE MEDIA UPLOAD ERROR:", err);
        return res.status(500).json({ success: false, message: err?.message || "Upload failed" });
    }
};

// GET /api/venue/media — public
export const getVenueMedia = async (_req, res) => {
    try {
        const cached = await cacheGet(VENUE_MEDIA_CACHE_KEY);
        if (cached) return res.json({ success: true, ...cached });

        const { data, error } = await supabaseAdmin
            .from("venue_media")
            .select("*")
            .eq("is_active", true)
            .order("sort_order", { ascending: true })
            .order("created_at", { ascending: true });

        // Must throw rather than fall through to `data || []`: an empty array is
        // indistinguishable from "this venue has no photos", and the result gets
        // cached. Same reasoning as the events list.
        if (error) throw error;

        const shaped = (data || []).map(shapeMedia);
        const payload = {
            photos: shaped.filter((m) => m.kind === "photo"),
            videos: shaped.filter((m) => m.kind === "video"),
        };

        await cacheSet(VENUE_MEDIA_CACHE_KEY, payload, VENUE_MEDIA_CACHE_TTL);
        return res.json({ success: true, ...payload });
    } catch (err) {
        // Logged in full, but not echoed: this endpoint is unauthenticated.
        console.error("VENUE MEDIA LIST ERROR:", err?.code === TABLE_MISSING_CODE
            ? "venue_media table missing — run scripts/venue_media_migration.sql"
            : err);
        return res.status(500).json({ success: false, message: "Failed to fetch venue media", photos: [], videos: [] });
    }
};

// GET /api/venue/media/all — admin; includes hidden rows
export const getAllVenueMedia = async (_req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("venue_media")
            .select("*")
            .order("kind", { ascending: true })
            .order("sort_order", { ascending: true })
            .order("created_at", { ascending: true });

        if (error) throw error;

        const shaped = (data || []).map(shapeMedia);
        return res.json({
            success: true,
            photos: shaped.filter((m) => m.kind === "photo"),
            videos: shaped.filter((m) => m.kind === "video"),
        });
    } catch (err) {
        console.error("VENUE MEDIA ADMIN LIST ERROR:", err);
        return res.status(500).json({ success: false, message: adminFailure(err, "Failed to fetch venue media") });
    }
};

// POST /api/venue/media — admin
export const createVenueMedia = async (req, res) => {
    try {
        const { kind, url, thumbnail, caption, sortOrder, isActive } = req.body;

        const invalid = validateWrite({ kind, url, caption });
        if (invalid) return res.status(400).json({ success: false, message: invalid });

        // uploadBase64 passes a plain URL straight through, so this handles both
        // "admin picked a file" and "admin pasted a link" without branching.
        const storedUrl = await uploadBase64(url, "event-assets", "venue");
        if (!storedUrl) return res.status(400).json({ success: false, message: "Upload failed — check the file type" });

        const storedThumb = thumbnail ? await uploadBase64(thumbnail, "event-assets", "venue") : null;

        const { data, error } = await supabaseAdmin
            .from("venue_media")
            .insert({
                kind,
                url: storedUrl,
                thumbnail_url: storedThumb,
                caption: caption?.trim() || null,
                sort_order: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0,
                is_active: isActive !== false,
                created_by: req.user?.id || null,
            })
            .select()
            .single();

        if (error) throw error;

        await invalidateVenueMediaCache();
        return res.json({ success: true, media: shapeMedia(data) });
    } catch (err) {
        console.error("VENUE MEDIA CREATE ERROR:", err);
        return res.status(500).json({ success: false, message: adminFailure(err, "Failed to add media") });
    }
};

// PUT /api/venue/media/:id — admin
export const updateVenueMedia = async (req, res) => {
    try {
        const { id } = req.params;
        const { kind, url, thumbnail, caption, sortOrder, isActive } = req.body;

        const invalid = validateWrite({ kind, url, caption });
        if (invalid) return res.status(400).json({ success: false, message: invalid });

        const storedUrl = await uploadBase64(url, "event-assets", "venue");
        if (!storedUrl) return res.status(400).json({ success: false, message: "Upload failed — check the file type" });

        // `undefined` means "not sent" and leaves the stored value alone; an
        // empty string means "clear it".
        const storedThumb =
            thumbnail === undefined ? undefined : thumbnail ? await uploadBase64(thumbnail, "event-assets", "venue") : null;

        const patch = {
            kind,
            url: storedUrl,
            caption: caption?.trim() || null,
            sort_order: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0,
            is_active: isActive !== false,
        };
        if (storedThumb !== undefined) patch.thumbnail_url = storedThumb;

        const { data, error } = await supabaseAdmin
            .from("venue_media")
            .update(patch)
            .eq("id", id)
            .select()
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ success: false, message: "Media not found" });

        await invalidateVenueMediaCache();
        return res.json({ success: true, media: shapeMedia(data) });
    } catch (err) {
        console.error("VENUE MEDIA UPDATE ERROR:", err);
        return res.status(500).json({ success: false, message: adminFailure(err, "Failed to update media") });
    }
};

// PATCH /api/venue/media/:id/toggle — admin
export const toggleVenueMedia = async (req, res) => {
    try {
        const { isActive } = req.body;
        const { data, error } = await supabaseAdmin
            .from("venue_media")
            .update({ is_active: isActive !== false })
            .eq("id", req.params.id)
            .select()
            .single();

        if (error) throw error;

        await invalidateVenueMediaCache();
        return res.json({ success: true, media: shapeMedia(data) });
    } catch (err) {
        console.error("VENUE MEDIA TOGGLE ERROR:", err);
        return res.status(500).json({ success: false, message: adminFailure(err, "Failed to update status") });
    }
};

// PATCH /api/venue/media/reorder — admin. Body: { order: [id, id, …] }
export const reorderVenueMedia = async (req, res) => {
    try {
        const { order } = req.body;
        if (!Array.isArray(order) || order.length === 0) {
            return res.status(400).json({ success: false, message: "order must be a non-empty array of ids" });
        }

        // Sequential rather than Promise.all: this runs on a drag-and-drop of a
        // handful of items, and a partial failure is easier to reason about when
        // the writes are ordered.
        for (let i = 0; i < order.length; i += 1) {
            const { error } = await supabaseAdmin
                .from("venue_media")
                .update({ sort_order: i })
                .eq("id", order[i]);
            if (error) throw error;
        }

        await invalidateVenueMediaCache();
        return res.json({ success: true });
    } catch (err) {
        console.error("VENUE MEDIA REORDER ERROR:", err);
        return res.status(500).json({ success: false, message: adminFailure(err, "Failed to reorder media") });
    }
};

// DELETE /api/venue/media/:id — admin
export const deleteVenueMedia = async (req, res) => {
    try {
        const { error } = await supabaseAdmin.from("venue_media").delete().eq("id", req.params.id);
        if (error) throw error;

        await invalidateVenueMediaCache();
        return res.json({ success: true, message: "Media deleted" });
    } catch (err) {
        console.error("VENUE MEDIA DELETE ERROR:", err);
        return res.status(500).json({ success: false, message: adminFailure(err, "Failed to delete media") });
    }
};
