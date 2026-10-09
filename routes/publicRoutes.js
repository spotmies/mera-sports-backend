import { cacheRoute } from "../middleware/responseCache.js";
import express from "express";
import { getPublicCategoryDraw, getPublicEventDraws, getPublicEventSharePreview, getPublicLeagueConfig, getPublicSettings, getSitemapXml, listPublicEvents } from "../controllers/publicController.js";

const router = express.Router();

router.get("/settings", getPublicSettings);
router.get("/events/list", listPublicEvents);
router.get("/sitemap.xml", getSitemapXml);

// Public draw/bracket endpoints (no auth required, only returns published draws)
router.get("/events/:id/categories/:categoryId/draw", cacheRoute("draw", 60), getPublicCategoryDraw);
router.get("/events/:id/categories/draw", cacheRoute("draw", 60), getPublicCategoryDraw); // Alternative with categoryLabel query
router.get("/events/:id/draws", cacheRoute("draws", 60), getPublicEventDraws); // All published draws for an event
router.get("/events/:id/categories/:categoryId/league", cacheRoute("league-config", 60), getPublicLeagueConfig);
router.get("/events/:id/categories/league", cacheRoute("league-config", 60), getPublicLeagueConfig); // Alternative with categoryLabel query

// Dynamic OG preview endpoint used for rich link cards in chat apps
router.get("/events/:id/share", cacheRoute("share", 300), getPublicEventSharePreview);

export default router;
