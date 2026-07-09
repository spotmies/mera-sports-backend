import express from "express";
import multer from "multer";
import { deleteMedia, getMedia, uploadMedia } from "../controllers/mediaController.js";
import {
    changePassword,
    checkConflict, checkPassword,
    deleteAccount,
    getPlayerDashboard,
    updateProfile
} from "../controllers/playerController.js";
import { verifyPlayer } from "../middleware/rbacMiddleware.js";

// ── Size limits ──
const MAX_VIDEO_SIZE = 6 * 1024 * 1024;  // 6 MB per video
const MAX_IMAGE_SIZE = 4 * 1024 * 1024;  // 4 MB per image
const MAX_FILE_SIZE  = 6 * 1024 * 1024;  // multer hard cap = max of the two (6 MB)

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/jpg", "image/webp"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime", "video/x-msvideo"];
const ALLOWED_TYPES = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES];

// Multer: memory storage, per-type size validated in controller
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_TYPES.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: JPEG, PNG, WEBP, MP4, WEBM, MOV, AVI`), false);
        }
    },
});

const router = express.Router();

router.get("/dashboard", verifyPlayer, getPlayerDashboard);
router.post("/check-conflict", verifyPlayer, checkConflict);
router.post("/check-password", verifyPlayer, checkPassword);
router.put("/update-profile", verifyPlayer, updateProfile);
router.put("/change-password", verifyPlayer, changePassword);
router.delete("/delete-account", verifyPlayer, deleteAccount);

/* ================= MEDIA UPLOADS ================= */
// Multer error handler: return user-friendly JSON instead of raw stack trace
const handleMulterUpload = (req, res, next) => {
    upload.single("image")(req, res, (err) => {
        if (err) {
            if (err.code === "LIMIT_FILE_SIZE") {
                const isVideo = req.headers["content-type"]?.includes("video") ||
                    (req.file && req.file.mimetype?.startsWith("video/"));
                const limitMB = isVideo ? "6" : "4";
                const type = isVideo ? "Video" : "Image";
                return res.status(400).json({
                    success: false,
                    message: `${type} too large. Maximum size is ${limitMB} MB.`,
                    code: "FILE_TOO_LARGE",
                });
            }
            return res.status(400).json({
                success: false,
                message: err.message || "File upload failed",
                code: "UPLOAD_ERROR",
            });
        }
        next();
    });
};
router.post("/upload-media", verifyPlayer, handleMulterUpload, uploadMedia);
router.get("/media", verifyPlayer, getMedia);
router.delete("/delete-media/:id", verifyPlayer, deleteMedia);

export default router;
