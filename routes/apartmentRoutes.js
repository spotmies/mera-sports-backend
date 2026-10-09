import { cacheRoute } from "../middleware/responseCache.js";
import express from "express";
import { addApartment, deleteApartment, getApartments, migrateApartments, updateApartment } from "../controllers/apartmentController.js";
import { authenticateUser } from "../middleware/authMiddleware.js";
import { requirePermission, requireSuperAdmin, verifyAdmin } from "../middleware/rbacMiddleware.js";

const router = express.Router();

// These routes had no auth at all, so anyone could rename, delete or bulk
// re-import apartments. Listing stays public (the signup form reads it).
// Adding one needs any signed-in user: a player adds their own apartment
// right after signing up, an admin from the Apartments page (an admin also
// needs the "apartments" permission).
const canManageApartments = [verifyAdmin, requirePermission("apartments")];

router.post("/migrate", verifyAdmin, requireSuperAdmin, migrateApartments);
router.get("/", cacheRoute("apartments", 300), getApartments);
router.post("/", authenticateUser, requirePermission("apartments"), addApartment);
router.put("/:id", canManageApartments, updateApartment);
router.delete("/:id", canManageApartments, deleteApartment);

export default router;
