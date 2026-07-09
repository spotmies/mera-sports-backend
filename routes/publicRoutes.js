import express from "express";
import { getPublicCategoryDraw, getPublicEventDraws, getPublicEventSharePreview, getPublicLeagueConfig, getPublicSettings, listPublicEvents } from "../controllers/publicController.js";

const router = express.Router();

router.get("/settings", getPublicSettings);
router.get("/events/list", listPublicEvents);

// Public draw/bracket endpoints (no auth required, only returns published draws)
router.get("/events/:id/categories/:categoryId/draw", getPublicCategoryDraw);
router.get("/events/:id/categories/draw", getPublicCategoryDraw); // Alternative with categoryLabel query
router.get("/events/:id/draws", getPublicEventDraws); // All published draws for an event
router.get("/events/:id/categories/:categoryId/league", getPublicLeagueConfig);
router.get("/events/:id/categories/league", getPublicLeagueConfig); // Alternative with categoryLabel query

// Dynamic OG preview endpoint used for rich link cards in chat apps
router.get("/events/:id/share", getPublicEventSharePreview);

export default router;
