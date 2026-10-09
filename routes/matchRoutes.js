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
import { fromBody, fromParam, fromRow, requireEventAccess } from "../middleware/eventAccess.js";
import { verifyAdmin } from "../middleware/rbacMiddleware.js";

const router = express.Router();

// Every route here is mounted under /api/admin and every one of them reads or
// writes match data for an event, so all of them require an admin token.
//
// They previously had NO auth middleware at all — unlike bracketRoutes, where
// every route is gated — which left match creation, score updates, round
// finalisation and both delete endpoints callable by anyone who could reach the
// API. The public app never uses these; it reads matches through
// GET /api/events/:id/matches (getPublicMatches), which stays unauthenticated.
router.use(verifyAdmin);

// On top of that, an admin may only touch matches of events they manage. Each
// route names its event differently, hence one guard per shape.
const byEventParam = requireEventAccess(fromParam("eventId"));
const byBodyEvent = requireEventAccess(fromBody("eventId", "event_id"));
const byMatchRow = requireEventAccess(fromRow("matches", "matchId"));
const byBulkMatches = requireEventAccess((req) =>
    Array.isArray(req.body?.matches) ? req.body.matches.map((m) => m?.event_id) : null
);

// Generate matches from existing bracket (Idempotent)
// POST /api/admin/matches/generate/:eventId/:categoryId
router.post("/generate/:eventId/:categoryId", byEventParam, generateMatchesFromBracket);

// Generate league (round-robin) matches from league blueprint (Idempotent)
// POST /api/admin/matches/generate-league/:eventId/:categoryId
router.post("/generate-league/:eventId/:categoryId", byEventParam, generateLeagueMatches);

// Create manual match
// POST /api/admin/matches
router.post("/", byBodyEvent, createMatch);

// Create matches in bulk
// POST /api/admin/matches/bulk
router.post("/bulk", byBulkMatches, createMatchesBulk);

// Finalize all matches in a round (calculate winners and set COMPLETED)
// POST /api/admin/matches/:eventId/finalize
router.post("/:eventId/finalize", byEventParam, finalizeRoundMatches);

// Update selected sets (Best of N) for a bracket round
// POST /api/admin/matches/round-sets
router.post("/round-sets/update", byBodyEvent, updateRoundSelectedSets);

// Clear ONLY scores for a category (MUST come before full delete route)
// DELETE /api/admin/matches/category/:eventId/scores?categoryId=xxx&categoryName=xxx&roundName=...
router.delete("/category/:eventId/scores", byEventParam, clearCategoryScores);

// Delete all matches for a category (MUST come before parameterized routes)
// DELETE /api/admin/matches/category/:eventId?categoryId=xxx&categoryName=xxx&roundName=...
router.delete("/category/:eventId", byEventParam, deleteCategoryMatches);

// Update score and status
// PUT /api/admin/matches/:matchId/score
router.put("/:matchId/score", byMatchRow, updateMatchScore);

// Delete match (MUST come before GET /:eventId to avoid conflicts)
// DELETE /api/admin/matches/:matchId
router.delete("/:matchId", byMatchRow, deleteMatch);

// Get matches for event (with optional categoryId query)
// GET /api/admin/matches/:eventId
router.get("/:eventId", byEventParam, getMatches);

export default router;
