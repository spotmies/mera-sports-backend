import express from "express";

import {
    collectEvents,
    getAnalyticsDashboard,
    getAnalyticsStatus,
} from "../controllers/analyticsController.js";
import { verifyAdmin } from "../middleware/rbacMiddleware.js";

/**
 * Two routers because the two halves have opposite trust models, and keeping
 * them in separate mounts makes it impossible to accidentally hang an
 * unauthenticated route off the admin prefix.
 *
 *   analyticsRoutes       → /api/analytics        public, write-only ingest
 *   adminAnalyticsRoutes  → /api/admin/analytics  admin-only, read-only reports
 */

// ── Public ingest ──────────────────────────────────────────────────────────
// Deliberately unauthenticated: anonymous visits are the ones worth counting.
// The controller treats the body as hostile and always answers 204.
const analyticsRoutes = express.Router();

analyticsRoutes.post("/collect", collectEvents);

// ── Admin reporting ────────────────────────────────────────────────────────
const adminAnalyticsRoutes = express.Router();

adminAnalyticsRoutes.get("/", verifyAdmin, getAnalyticsDashboard);
adminAnalyticsRoutes.get("/status", verifyAdmin, getAnalyticsStatus);

export { adminAnalyticsRoutes };
export default analyticsRoutes;
