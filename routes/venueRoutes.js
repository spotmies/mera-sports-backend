import express from "express";
import multer from "multer";
import {
    createVenueMedia,
    deleteVenueMedia,
    getAllVenueMedia,
    getVenueMedia,
    reorderVenueMedia,
    toggleVenueMedia,
    updateVenueMedia,
    uploadVenueFile,
} from "../controllers/venueController.js";
import { verifyAdmin } from "../middleware/rbacMiddleware.js";

const router = express.Router();

/**
 * Upload ceiling for a venue video, bytes. Override with
 * VENUE_UPLOAD_MAX_MB — raise it if the venue's clips are longer.
 *
 * 50 MB is roughly a minute or two of 1080p. The real constraint is not
 * storage (S3 PutObject handles far more) but memory: multer buffers the whole
 * file in RAM before it is forwarded, so this number is what one concurrent
 * upload costs the container. Raise it deliberately, not reflexively.
 */
const MAX_UPLOAD_BYTES = Number(process.env.VENUE_UPLOAD_MAX_MB || 50) * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const ALLOWED_VIDEO_TYPES = [
    "video/mp4",
    "video/webm",
    "video/quicktime",   // .mov — what an iPhone produces
    "video/x-msvideo",   // .avi
    "video/x-matroska",  // .mkv
];

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES },
    fileFilter: (_req, file, cb) => {
        if ([...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES].includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: JPG, PNG, WEBP, MP4, WEBM, MOV, AVI, MKV`), false);
        }
    },
});

/**
 * Multer rejects with an Error, not an HTTP response — without this the client
 * gets a raw stack trace and an admin who picked a 200 MB file is told nothing
 * useful. Translate the two cases that actually happen into plain JSON.
 */
const handleUpload = (req, res, next) => {
    upload.single("file")(req, res, (err) => {
        if (!err) return next();
        if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({
                success: false,
                message: `File too large. Maximum size is ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`,
                code: "FILE_TOO_LARGE",
            });
        }
        return res.status(400).json({
            success: false,
            message: err.message || "File upload failed",
            code: "UPLOAD_ERROR",
        });
    });
};

// Public — what the venue page renders. Active rows only.
router.get("/media", getVenueMedia);

// Admin — includes hidden rows, and every write.
router.get("/media/all", verifyAdmin, getAllVenueMedia);
// Declared before "/media/:id" so "upload" and "reorder" are not captured as ids.
router.post("/media/upload", verifyAdmin, handleUpload, uploadVenueFile);
router.patch("/media/reorder", verifyAdmin, reorderVenueMedia);
router.post("/media", verifyAdmin, createVenueMedia);
router.put("/media/:id", verifyAdmin, updateVenueMedia);
router.patch("/media/:id/toggle", verifyAdmin, toggleVenueMedia);
router.delete("/media/:id", verifyAdmin, deleteVenueMedia);

export default router;
