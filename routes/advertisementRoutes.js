import { cacheRoute } from "../middleware/responseCache.js";
import express from "express";
import { createAdvertisement, deleteAdvertisement, getAdvertisements, toggleAdvertisement, updateAdvertisement } from "../controllers/advertisementController.js";
import { requirePermission, verifyAdmin } from "../middleware/rbacMiddleware.js";

// Writes need the admin's "advertisements" permission; reading stays public.
const canManageAds = [verifyAdmin, requirePermission("advertisements")];

const router = express.Router();

router.get("/", cacheRoute("ads", 120), getAdvertisements);
router.post("/", canManageAds, createAdvertisement);
router.put("/:id", canManageAds, updateAdvertisement);
router.delete("/:id", canManageAds, deleteAdvertisement);
router.patch("/:id/toggle", canManageAds, toggleAdvertisement);

export default router;
