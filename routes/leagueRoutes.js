import express from "express";
import { deleteLeague, getLeagueConfig, notifyLeaguePromotions, saveLeagueConfig } from "../controllers/leagueController.js";
import { fromParam, requireEventAccess } from "../middleware/eventAccess.js";
import { verifyAdmin } from "../middleware/rbacMiddleware.js";

// Every route here acts on one event (:id); admins may only touch events they manage.
const eventAccess = requireEventAccess(fromParam("id"));

const router = express.Router();

// League configuration (blueprint only, scores still live in matches table)
// GET  /api/admin/events/:id/categories/:categoryId/league
router.get("/events/:id/categories/:categoryId/league", verifyAdmin, eventAccess, getLeagueConfig);

// POST /api/admin/events/:id/categories/:categoryId/league
router.post("/events/:id/categories/:categoryId/league", verifyAdmin, eventAccess, saveLeagueConfig);

// POST /api/admin/events/:id/categories/:categoryId/league/notify-promotions
router.post("/events/:id/categories/:categoryId/league/notify-promotions", verifyAdmin, eventAccess, notifyLeaguePromotions);

// DELETE /api/admin/events/:id/categories/:categoryId/league
router.delete("/events/:id/categories/:categoryId/league", verifyAdmin, eventAccess, deleteLeague);

export default router;

