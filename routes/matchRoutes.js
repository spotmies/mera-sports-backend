import express from "express";
import {
    clearCategoryScores,
    createMatch,
    createMatchesBulk,
    deleteCategoryMatches,
    deleteMatch,
    finalizeRoundMatches,
    generateLeagueMatches,
    generateMatchesFromBracket,
    getMatches,
    updateMatchScore,
    updateRoundSelectedSets
} from "../controllers/matchController.js";

const router = express.Router();

// Generate matches from existing bracket (Idempotent)
// POST /api/admin/matches/generate/:eventId/:categoryId
router.post("/generate/:eventId/:categoryId", generateMatchesFromBracket);

// Generate league (round-robin) matches from league blueprint (Idempotent)
// POST /api/admin/matches/generate-league/:eventId/:categoryId
router.post("/generate-league/:eventId/:categoryId", generateLeagueMatches);

// Create manual match
// POST /api/admin/matches
router.post("/", createMatch);

// Create matches in bulk
// POST /api/admin/matches/bulk
router.post("/bulk", createMatchesBulk);

// Finalize all matches in a round (calculate winners and set COMPLETED)
// POST /api/admin/matches/:eventId/finalize
router.post("/:eventId/finalize", finalizeRoundMatches);

// Update selected sets (Best of N) for a bracket round
// POST /api/admin/matches/round-sets
router.post("/round-sets/update", updateRoundSelectedSets);

// Clear ONLY scores for a category (MUST come before full delete route)
// DELETE /api/admin/matches/category/:eventId/scores?categoryId=xxx&categoryName=xxx&roundName=...
router.delete("/category/:eventId/scores", clearCategoryScores);

// Delete all matches for a category (MUST come before parameterized routes)
// DELETE /api/admin/matches/category/:eventId?categoryId=xxx&categoryName=xxx&roundName=...
router.delete("/category/:eventId", deleteCategoryMatches);

// Update score and status
// PUT /api/admin/matches/:matchId/score
router.put("/:matchId/score", updateMatchScore);

// Delete match (MUST come before GET /:eventId to avoid conflicts)
// DELETE /api/admin/matches/:matchId
router.delete("/:matchId", deleteMatch);

// Get matches for event (with optional categoryId query)
// GET /api/admin/matches/:eventId
router.get("/:eventId", getMatches);

export default router;
