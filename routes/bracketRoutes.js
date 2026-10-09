import express from "express";
import {
    addBracketRound,
    assignByeToPlayer,
    createFullBracketStructure,
    deleteBracketRound,
    deleteCategoryBracket,
    deleteCategoryMedia,
    finalizeByes,
    getCategoryDraw,
    getBulkDrawSummary,
    getEventDrawsSummary,
    initBracket,
    notifyBracketPromotions,
    publishCategoryDraw,
    randomizeRound1Byes,
    recordResult,
    replaceRoundMatches,
    resetBracket,
    updateBracketMatch,
    uploadCategoryMedia,
    validateBracketDraw
} from "../controllers/bracketController.js";
import { fromParam, requireEventAccess } from "../middleware/eventAccess.js";
import { verifyAdmin } from "../middleware/rbacMiddleware.js";

// Every route here acts on one event (:id); admins may only touch events they manage.
const eventAccess = requireEventAccess(fromParam("id"));

const router = express.Router();

// Bulk get draws summary for multiple events
router.get("/events/draws/summary", verifyAdmin, getBulkDrawSummary);

// All categories' draw summary for ONE event, in a single query.
// Used by the Draws tab on open instead of one getCategoryDraw per category.
router.get("/events/:id/draws", verifyAdmin, eventAccess, getEventDrawsSummary);

// Get draw/bracket for category
router.get("/events/:id/categories/:categoryId/draw", verifyAdmin, eventAccess, getCategoryDraw);
router.get("/events/:id/categories/draw", verifyAdmin, eventAccess, getCategoryDraw); // Alternative with categoryLabel query

// Validate bracket integrity (Semifinal-safe check)
router.get("/events/:id/categories/:categoryId/draw/validate", verifyAdmin, eventAccess, validateBracketDraw);
router.get("/events/:id/categories/draw/validate", verifyAdmin, eventAccess, validateBracketDraw); // Alternative with categoryLabel query

// Initialize bracket
router.post("/events/:id/categories/:categoryId/bracket/init", verifyAdmin, eventAccess, initBracket);
router.post("/events/:id/categories/bracket/init", verifyAdmin, eventAccess, initBracket); // Alternative

// Start rounds - create full bracket structure (all rounds + matches) in one shot
router.post("/events/:id/categories/:categoryId/bracket/start", verifyAdmin, eventAccess, createFullBracketStructure);
router.post("/events/:id/categories/bracket/start", verifyAdmin, eventAccess, createFullBracketStructure); // Alternative with categoryLabel

// Upload media
router.post("/events/:id/categories/:categoryId/media", verifyAdmin, eventAccess, uploadCategoryMedia);
router.post("/events/:id/categories/media", verifyAdmin, eventAccess, uploadCategoryMedia); // Alternative

// Bracket match operations
router.post("/events/:id/categories/:categoryId/bracket/match", verifyAdmin, eventAccess, updateBracketMatch);
router.post("/events/:id/categories/bracket/match", verifyAdmin, eventAccess, updateBracketMatch); // Alternative

// Replace entire round matches (bulk seed for 100+ players)
router.post("/events/:id/categories/:categoryId/bracket/round/replace", verifyAdmin, eventAccess, replaceRoundMatches);
router.post("/events/:id/categories/bracket/round/replace", verifyAdmin, eventAccess, replaceRoundMatches); // Alternative with categoryLabel

// Set match result
router.post("/events/:id/categories/:categoryId/bracket/result", verifyAdmin, eventAccess, recordResult);
router.post("/events/:id/categories/bracket/result", verifyAdmin, eventAccess, recordResult); // Alternative

// Publish/Unpublish
router.post("/events/:id/categories/:categoryId/publish", verifyAdmin, eventAccess, publishCategoryDraw);
router.post("/events/:id/categories/publish", verifyAdmin, eventAccess, publishCategoryDraw); // Alternative

// Delete media
router.delete("/events/:id/categories/:categoryId/media/:mediaId", verifyAdmin, eventAccess, deleteCategoryMedia);
router.delete("/events/:id/categories/media/:mediaId", verifyAdmin, eventAccess, deleteCategoryMedia); // Alternative

// Reset bracket
router.post("/events/:id/categories/:categoryId/bracket/reset", verifyAdmin, eventAccess, resetBracket);
router.post("/events/:id/categories/bracket/reset", verifyAdmin, eventAccess, resetBracket); // Alternative

// Delete bracket (unpublished only)
router.delete("/events/:id/categories/:categoryId/bracket", verifyAdmin, eventAccess, deleteCategoryBracket);
router.delete("/events/:id/categories/bracket", verifyAdmin, eventAccess, deleteCategoryBracket); // Alternative with categoryLabel query

// Add round to bracket (dynamic rounds)
router.post("/events/:id/categories/:categoryId/bracket/round/add", verifyAdmin, eventAccess, addBracketRound);
router.post("/events/:id/categories/bracket/round/add", verifyAdmin, eventAccess, addBracketRound); // Alternative with categoryLabel

// Delete last round from bracket
router.post("/events/:id/categories/:categoryId/bracket/round/delete", verifyAdmin, eventAccess, deleteBracketRound);
router.post("/events/:id/categories/bracket/round/delete", verifyAdmin, eventAccess, deleteBracketRound); // Alternative with categoryLabel

// Randomize BYE placement in Round 1
router.post("/events/:id/categories/:categoryId/bracket/round/randomize-byes", verifyAdmin, eventAccess, randomizeRound1Byes);
router.post("/events/:id/categories/bracket/round/randomize-byes", verifyAdmin, eventAccess, randomizeRound1Byes); // Alternative with categoryLabel

// Alias: requested endpoint naming (/bracket/round1/reshuffle-byes)
router.post("/events/:id/categories/:categoryId/bracket/round1/reshuffle-byes", verifyAdmin, eventAccess, randomizeRound1Byes);
router.post("/events/:id/categories/bracket/round1/reshuffle-byes", verifyAdmin, eventAccess, randomizeRound1Byes); // Alternative with categoryLabel

// Assign BYE to unranked player (manual BYE assignment)
router.patch("/events/:id/categories/:categoryId/bracket/round1/assign-bye", verifyAdmin, eventAccess, assignByeToPlayer);
router.patch("/events/:id/categories/bracket/round1/assign-bye", verifyAdmin, eventAccess, assignByeToPlayer); // Alternative with categoryLabel

// Finalize BYEs
router.post("/events/:id/categories/:categoryId/bracket/finalize-byes", verifyAdmin, eventAccess, finalizeByes);
router.post("/events/:id/categories/bracket/finalize-byes", verifyAdmin, eventAccess, finalizeByes);

// Send promotion notifications
router.post("/events/:id/categories/:categoryId/bracket/notify-promotions", verifyAdmin, eventAccess, notifyBracketPromotions);
router.post("/events/:id/categories/bracket/notify-promotions", verifyAdmin, eventAccess, notifyBracketPromotions);

export default router;
