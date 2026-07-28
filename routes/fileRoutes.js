import express from "express";
import { Readable } from "node:stream";
import { LEGACY_BUCKETS, getSignedFileUrl } from "../utils/railwayStorage.js";

const router = express.Router();

/**
 * Public file delivery for the private Railway bucket.
 *
 *   GET /api/files/:bucket/*            → 302 redirect to a short-lived signed URL.
 *   GET /api/files/:bucket/*?download=1 → the bytes, streamed through this server.
 *
 * DB-stored URLs point here, so storage backends can change without ever
 * rewriting URLs again.
 *
 * Why the `download` mode exists
 * ------------------------------
 * The redirect is the cheap path and is right for <img src>, which does not care
 * about CORS. It is useless to `fetch()` though: the browser follows the 302 to
 * the bucket, and the bucket's response carries no `Access-Control-Allow-Origin`
 * header. CORS requires the *final* response in a redirect chain to allow the
 * origin, so the fetch is blocked even though the network shows a clean 200 —
 * which is exactly how "download QR" failed while the network tab looked fine.
 *
 * Streaming through this route puts the bytes on our own origin (global
 * `cors()` in server.js sets the header), so fetch/blob/File all work.
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

        if (req.query.download === undefined) {
            res.setHeader("Cache-Control", "private, max-age=300");
            return res.redirect(302, signedUrl);
        }

        const upstream = await fetch(signedUrl);
        if (!upstream.ok || !upstream.body) {
            console.error(`File proxy: upstream ${upstream.status} for ${bucket}/${rest}`);
            return res.status(502).json({ success: false, message: "File unavailable" });
        }

        // Quotes and CR/LF would let a crafted object key break out of the header.
        const safeName = (rest.split("/").pop() || "download").replace(/["\r\n]/g, "");
        res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
        const length = upstream.headers.get("content-length");
        if (length) res.setHeader("Content-Length", length);
        res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
        res.setHeader("Cache-Control", "private, max-age=300");

        // Stream rather than buffer — banners and PDFs go through here too.
        return Readable.fromWeb(upstream.body).pipe(res);
    } catch (err) {
        console.error("File route error:", err.message);
        return res.status(500).json({ success: false, message: "File unavailable" });
    }
});

export default router;
