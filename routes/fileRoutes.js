import express from "express";
import { LEGACY_BUCKETS, getSignedFileUrl } from "../utils/railwayStorage.js";

const router = express.Router();

/**
 * Public file delivery for the private Railway bucket.
 * GET /api/files/:bucket/*  →  302 redirect to a short-lived signed URL.
 * DB-stored URLs point here, so storage backends can change without
 * ever rewriting URLs again.
 */
router.get("/:bucket/*path", async (req, res) => {
    try {
        const { bucket } = req.params;
        if (!LEGACY_BUCKETS.includes(bucket)) {
            return res.status(404).json({ success: false, message: "Unknown bucket" });
        }
        // Express 5 wildcard params arrive as an array of segments
        const rest = Array.isArray(req.params.path) ? req.params.path.join("/") : req.params.path;
        if (!rest || rest.includes("..")) {
            return res.status(400).json({ success: false, message: "Invalid path" });
        }
        const signedUrl = await getSignedFileUrl(`${bucket}/${rest}`, 3600);
        res.setHeader("Cache-Control", "private, max-age=300");
        return res.redirect(302, signedUrl);
    } catch (err) {
        console.error("File route error:", err.message);
        return res.status(500).json({ success: false, message: "File unavailable" });
    }
});

export default router;
