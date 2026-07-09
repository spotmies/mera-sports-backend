import express from "express";
import { deleteLeague, getLeagueConfig, notifyLeaguePromotions, saveLeagueConfig } from "../controllers/leagueController.js";
import { verifyAdmin } from "../middleware/rbacMiddleware.js";

const router = express.Router();

// League configuration (blueprint only, scores still live in matches table)
// GET  /api/admin/events/:id/categories/:categoryId/league
router.get("/events/:id/categories/:categoryId/league", verifyAdmin, getLeagueConfig);

// POST /api/admin/events/:id/categories/:categoryId/league
router.post("/events/:id/categories/:categoryId/league", verifyAdmin, saveLeagueConfig);

// POST /api/admin/events/:id/categories/:categoryId/league/notify-promotions
router.post("/events/:id/categories/:categoryId/league/notify-promotions", verifyAdmin, notifyLeaguePromotions);

// DELETE /api/admin/events/:id/categories/:categoryId/league
router.delete("/events/:id/categories/:categoryId/league", verifyAdmin, deleteLeague);

export default router;

