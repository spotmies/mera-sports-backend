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
import { verifyAdmin } from "../middleware/rbacMiddleware.js";

const router = express.Router();

// Bulk get draws summary for multiple events
router.get("/events/draws/summary", verifyAdmin, getBulkDrawSummary);

// Get draw/bracket for category
router.get("/events/:id/categories/:categoryId/draw", verifyAdmin, getCategoryDraw);
router.get("/events/:id/categories/draw", verifyAdmin, getCategoryDraw); // Alternative with categoryLabel query

// Validate bracket integrity (Semifinal-safe check)
router.get("/events/:id/categories/:categoryId/draw/validate", verifyAdmin, validateBracketDraw);
router.get("/events/:id/categories/draw/validate", verifyAdmin, validateBracketDraw); // Alternative with categoryLabel query

// Initialize bracket
router.post("/events/:id/categories/:categoryId/bracket/init", verifyAdmin, initBracket);
router.post("/events/:id/categories/bracket/init", verifyAdmin, initBracket); // Alternative

// Start rounds - create full bracket structure (all rounds + matches) in one shot
router.post("/events/:id/categories/:categoryId/bracket/start", verifyAdmin, createFullBracketStructure);
router.post("/events/:id/categories/bracket/start", verifyAdmin, createFullBracketStructure); // Alternative with categoryLabel

// Upload media
router.post("/events/:id/categories/:categoryId/media", verifyAdmin, uploadCategoryMedia);
router.post("/events/:id/categories/media", verifyAdmin, uploadCategoryMedia); // Alternative

// Bracket match operations
router.post("/events/:id/categories/:categoryId/bracket/match", verifyAdmin, updateBracketMatch);
router.post("/events/:id/categories/bracket/match", verifyAdmin, updateBracketMatch); // Alternative

// Replace entire round matches (bulk seed for 100+ players)
router.post("/events/:id/categories/:categoryId/bracket/round/replace", verifyAdmin, replaceRoundMatches);
router.post("/events/:id/categories/bracket/round/replace", verifyAdmin, replaceRoundMatches); // Alternative with categoryLabel

// Set match result
router.post("/events/:id/categories/:categoryId/bracket/result", verifyAdmin, recordResult);
router.post("/events/:id/categories/bracket/result", verifyAdmin, recordResult); // Alternative

// Publish/Unpublish
router.post("/events/:id/categories/:categoryId/publish", verifyAdmin, publishCategoryDraw);
router.post("/events/:id/categories/publish", verifyAdmin, publishCategoryDraw); // Alternative

// Delete media
router.delete("/events/:id/categories/:categoryId/media/:mediaId", verifyAdmin, deleteCategoryMedia);
router.delete("/events/:id/categories/media/:mediaId", verifyAdmin, deleteCategoryMedia); // Alternative

// Reset bracket
router.post("/events/:id/categories/:categoryId/bracket/reset", verifyAdmin, resetBracket);
router.post("/events/:id/categories/bracket/reset", verifyAdmin, resetBracket); // Alternative

// Delete bracket (unpublished only)
router.delete("/events/:id/categories/:categoryId/bracket", verifyAdmin, deleteCategoryBracket);
router.delete("/events/:id/categories/bracket", verifyAdmin, deleteCategoryBracket); // Alternative with categoryLabel query

// Add round to bracket (dynamic rounds)
router.post("/events/:id/categories/:categoryId/bracket/round/add", verifyAdmin, addBracketRound);
router.post("/events/:id/categories/bracket/round/add", verifyAdmin, addBracketRound); // Alternative with categoryLabel

// Delete last round from bracket
router.post("/events/:id/categories/:categoryId/bracket/round/delete", verifyAdmin, deleteBracketRound);
router.post("/events/:id/categories/bracket/round/delete", verifyAdmin, deleteBracketRound); // Alternative with categoryLabel

// Randomize BYE placement in Round 1
router.post("/events/:id/categories/:categoryId/bracket/round/randomize-byes", verifyAdmin, randomizeRound1Byes);
router.post("/events/:id/categories/bracket/round/randomize-byes", verifyAdmin, randomizeRound1Byes); // Alternative with categoryLabel

// Alias: requested endpoint naming (/bracket/round1/reshuffle-byes)
router.post("/events/:id/categories/:categoryId/bracket/round1/reshuffle-byes", verifyAdmin, randomizeRound1Byes);
router.post("/events/:id/categories/bracket/round1/reshuffle-byes", verifyAdmin, randomizeRound1Byes); // Alternative with categoryLabel

// Assign BYE to unranked player (manual BYE assignment)
router.patch("/events/:id/categories/:categoryId/bracket/round1/assign-bye", verifyAdmin, assignByeToPlayer);
router.patch("/events/:id/categories/bracket/round1/assign-bye", verifyAdmin, assignByeToPlayer); // Alternative with categoryLabel

// Finalize BYEs
router.post("/events/:id/categories/:categoryId/bracket/finalize-byes", verifyAdmin, finalizeByes);
router.post("/events/:id/categories/bracket/finalize-byes", verifyAdmin, finalizeByes);

// Send promotion notifications
router.post("/events/:id/categories/:categoryId/bracket/notify-promotions", verifyAdmin, notifyBracketPromotions);
router.post("/events/:id/categories/bracket/notify-promotions", verifyAdmin, notifyBracketPromotions);

export default router;
