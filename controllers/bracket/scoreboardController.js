/**
 * SCOREBOARD CONTROLLER
 * 
 * Responsibility: Match result recording & bracket sync
 * 
 * Functions:
 * - recordResult(req, res) - Record score winner in matches table
 * - syncBracketToMatches(bracketData, eventId, categoryId) - Ensure bracket -> matches
 * - syncMatchesToBracket(matchesTable, bracketData) - Ensure matches -> bracket
 * - validateScore(score) - Validate score structure
 * 
 * Dependencies:
 * - bracketData, matches table
 * - propagationController: propagateWinner
 * - helpers: isFakeByePlayer, isUuid, hasRealPlayer
 * 
 * Safety Rules:
 * ✅ Treat BYE winners as completed matches (no score entry)
 * ✅ Validate scores before recording
 * ✅ Update both tables (matches + bracket_data)
 * ✅ Trigger winner propagation after score recorded
 * ✅ Check match completion (check if final scores recorded)
 * 
 * Status: EXTRACT from bracketController.js (recordResult/handleSetResult endpoint logic)
 */

import { supabaseAdmin } from "../../config/supabaseClient.js";
import {
    hasRealPlayer,
    isUuid,
    normalizeRoundName
} from "./bracketHelpers.js";

/**
 * Record a match result (score + winner)
 * Entry point: POST /api/admin/events/:id/categories/:categoryId/bracket/result
 * 
 * Body: {
 *   matchId: string,
 *   roundName: string,
 *   winner: "player1" | "player2",
 *   score?: { player1: number, player2: number }
 * }
 * 
 * Process:
 * 1. Validate score structure
 * 2. Update matches table (authoritative for results)
 * 3. Update bracketData with winner
 * 4. Trigger winner propagation to next round
 * 5. Check if round is complete (all matches scored)
 * 
 * @param {object} req
 * @param {object} res
 * @returns {void}
 */
export const recordResult = async (req, res) => {
    try {
        const { eventId, categoryId, roundName } = req.params;
        const { matchId, winner, score, sets } = req.body;

        if (!eventId || !isUuid(categoryId)) {
            return res.status(400).json({ message: "Event ID and valid category ID required" });
        }

        if (!matchId || !winner) {
            return res.status(400).json({ message: "Missing matchId or winner" });
        }

        // Fetch bracket
        const { data: bracket } = await supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("category_id", categoryId)
            .single();

        if (!bracket) {
            return res.status(404).json({ message: "Bracket not found" });
        }

        const bracketData = bracket.bracket_data || {};
        const normalizedRound = normalizeRoundName(roundName);

        // Find round in bracket
        const round = bracketData.rounds?.find(r => normalizeRoundName(r.name) === normalizedRound);
        if (!round) {
            return res.status(404).json({ message: `Round "${roundName}" not found` });
        }

        // Find match
        const match = round.matches?.find(m => m.id === matchId);
        if (!match) {
            return res.status(404).json({ message: `Match "${matchId}" not found` });
        }

        // Validate score if provided
        if (score) {
            const scoreValidation = validateScore(score, match);
            if (!scoreValidation.valid) {
                return res.status(400).json({
                    message: "Invalid score",
                    errors: scoreValidation.errors
                });
            }
        }

        // Update matches table (authoritative)
        const matchesUpdate = {
            winner: winner === "player1" ? "A" : "B",
            score: score,
            sets: sets,
            status: "COMPLETED",
            updated_at: new Date().toISOString()
        };

        await supabaseAdmin
            .from("matches")
            .update(matchesUpdate)
            .eq("bracket_match_id", matchId)
            .eq("event_id", eventId)
            .eq("category_id", categoryId);

        // Update bracket_data (sync)
        match.winner = winner;
        if (score) match.score = score;
        if (sets) match.sets = sets;

        await supabaseAdmin
            .from("event_brackets")
            .update({
                bracket_data: bracketData,
                draw_data: bracketData,
                updated_at: new Date().toISOString()
            })
            .eq("id", bracket.id);

        // Check if round is complete
        const roundComplete = isRoundComplete(round);

        // Auto-propagate if round complete
        if (roundComplete) {
            const matchResults = round.matches
                .filter(m => m.winner)
                .map(m => ({ matchId: m.id, winner: m.winner }));

            const currentRoundIndex = bracketData.rounds.indexOf(round);
            const propStats = propagateWinnersToNextRound(bracketData, currentRoundIndex, matchResults);

            // Persist propagation changes
            await supabaseAdmin
                .from("event_brackets")
                .update({ bracket_data: bracketData })
                .eq("id", bracket.id);

            console.log(`Round complete - propagated ${propStats.updated} winners`);
        }

        return res.status(200).json({
            message: "Result recorded successfully",
            matchId,
            winner,
            roundComplete,
            score
        });

    } catch (error) {
        console.error("Error recording result:", error);
        return res.status(500).json({
            message: "Failed to record result",
            error: error.message
        });
    }
};

/**
 * Validate score structure
 * 
 * @param {object} score - { player1: number, player2: number }
 * @param {object} match - For reference (sets config, etc.)
 * @returns {object} { valid: boolean, errors: string[] }
 */
export const validateScore = (score, match) => {
    const errors = [];

    if (!score || typeof score !== "object") {
        errors.push("Score must be an object");
        return { valid: false, errors };
    }

    const p1Score = score.player1;
    const p2Score = score.player2;

    if (!Number.isFinite(p1Score) || !Number.isFinite(p2Score)) {
        errors.push("Scores must be numbers");
    }

    if (p1Score < 0 || p2Score < 0) {
        errors.push("Scores cannot be negative");
    }

    // Check sets config if available
    if (match?.setsConfig?.pointsPerSet) {
        const pointsPerSet = match.setsConfig.pointsPerSet;
        const maxScore = pointsPerSet * (match.setsConfig.sets || 1) * 2;

        if (p1Score > maxScore || p2Score > maxScore) {
            errors.push(
                `Score exceeds maximum ${maxScore} ` +
                `(${match.setsConfig.sets} × ${pointsPerSet})`
            );
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
};

/**
 * Check if all matches in a round are completed
 * 
 * @param {object} round
 * @returns {boolean}
 */
export const isRoundComplete = (round) => {
    if (!round || !round.matches) return false;

    // All non-BYE matches must have winner set
    for (const match of round.matches) {
        // Skip BYE matches (they auto-advance)
        const isBye =
            (hasRealPlayer(match.player1) && !hasRealPlayer(match.player2)) ||
            (!hasRealPlayer(match.player1) && hasRealPlayer(match.player2));

        if (!isBye && !match.winner) {
            return false; // Found an incomplete normal match
        }
    }

    return true;
};

/**
 * Sync bracketData winners to matches table
 * Ensure all bracketData winners are recorded in matches table
 * 
 * @param {object} bracketData
 * @param {string} eventId
 * @param {string} categoryId
 * @returns {Promise<object>} { updated: number, failed: number }
 */
export const syncBracketToMatches = async (bracketData, eventId, categoryId) => {
    const stats = { updated: 0, failed: 0 };

    if (!bracketData || !bracketData.rounds) return stats;

    try {
        for (const round of bracketData.rounds) {
            for (const match of round.matches || []) {
                if (!match.winner || !match.id) continue;

                // Skip BYE matches
                const isBye =
                    (hasRealPlayer(match.player1) && !hasRealPlayer(match.player2)) ||
                    (!hasRealPlayer(match.player1) && hasRealPlayer(match.player2));

                if (isBye) continue;

                const { data: existing } = await supabaseAdmin
                    .from("matches")
                    .select("id")
                    .eq("bracket_match_id", match.id)
                    .eq("event_id", eventId)
                    .eq("category_id", categoryId)
                    .single();

                if (!existing) continue;

                const winnerSide = match.winner === "player1" ? "A" : "B";
                const { error } = await supabaseAdmin
                    .from("matches")
                    .update({
                        winner: winnerSide,
                        score: match.score,
                        status: "COMPLETED"
                    })
                    .eq("id", existing.id);

                if (error) {
                    stats.failed++;
                } else {
                    stats.updated++;
                }
            }
        }
    } catch (e) {
        console.error("Error syncing bracket to matches:", e);
    }

    return stats;
};

/**
 * Sync matches table winners to bracketData
 * Ensure all matches table winners are recorded in bracketData
 * 
 * @param {object[]} matchesTableRows
 * @param {object} bracketData
 * @returns {object} { synced: number, failed: number }
 */
export const syncMatchesToBracket = (matchesTableRows, bracketData) => {
    const stats = { synced: 0, failed: 0 };

    if (!bracketData || !bracketData.rounds) return stats;

    for (const row of matchesTableRows || []) {
        try {
            if (!row.bracket_match_id || !row.winner) continue;

            for (const round of bracketData.rounds) {
                const match = round.matches?.find(m => m.id === row.bracket_match_id);
                if (match) {
                    const winnerSide = row.winner === "A" ? "player1" : "player2";
                    match.winner = winnerSide;
                    if (row.score) match.score = row.score;
                    stats.synced++;
                    break;
                }
            }
        } catch (e) {
            console.error(`Error syncing ${row.bracket_match_id}:`, e);
            stats.failed++;
        }
    }

    return stats;
};

export default {
    recordResult,
    validateScore,
    isRoundComplete,
    syncBracketToMatches,
    syncMatchesToBracket
};
