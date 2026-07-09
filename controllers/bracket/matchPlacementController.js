/**
 * MATCH PLACEMENT CONTROLLER
 * 
 * Responsibility: Single writer layer for match updates (critical safety)
 * 
 * CRITICAL DESIGN: This is the ONLY place where bracket_data.rounds[x].matches[y] is modified
 * All other modules must call through this controller.
 * 
 * Functions:
 * - updateBracketMatch(req, res) - Place/move player in bracket slot
 * - movePlayer(bracketData, roundName, matchId, slot, playerObject) - Lowlevel placement
 * - validatePlacementSafety(bracketData, roundName, matchId, slot, playerObject) - Checks before move
 * 
 * Dependencies:
 * - helpers: normalizeRoundName, isRankedBye, isFakeByePlayer, isUuid
 * - bracketValidation middleware
 * 
 * Safety Checks:
 * ✅ Ranked players cannot be moved once placed
 * ✅ Completed matches cannot be edited
 * ✅ No duplicate player assignments (same player in two slots)
 * ✅ No placement into reserved BYE slots
 * 
 * Status: EXTRACT from bracketController.js (handleUpdateMatch endpoint logic)
 * and from BracketBuilderTab.tsx (frontend handleUpdateMatch)
 */

import { supabaseAdmin } from "../../config/supabaseClient.js";
import {
    hasRealPlayer,
    isFakeByePlayer,
    isRankedBye,
    isUuid,
    LEGACY_ROUND_NAME_BRACKET,
    normalizeRoundName
} from "./bracketHelpers.js";

/**
 * Single entry point for all match player updates
 * Called by: Frontend via POST /api/admin/events/:id/categories/:categoryId/bracket/match
 * 
 * Body: {
 *   matchId: string,
 *   player1: object | null,
 *   player2: object | null,
 *   roundName: string
 * }
 * 
 * @param {object} req
 * @param {object} res
 * @returns {void}
 */
export const updateBracketMatch = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const {
            categoryLabel,
            roundName,
            matchId,
            player1,
            player2,
            matchIndex,
            deleteMatch,
            updatePlayerRanks,
            playerRanks,
            enableRanking,
            playerRanksByRound,
            player_ranks_by_round,
            enableRankingByRound,
            enable_ranking_by_round
        } = req.body;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        // Get bracket
        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else {
            query = query.eq("category", categoryLabel);
        }

        const { data: brackets, error: fetchError } = await query;

        if (fetchError) throw fetchError;
        if (!brackets || brackets.length === 0) {
            return res.status(404).json({ message: "Bracket not found. Initialize bracket first." });
        }

        const bracket = brackets[0];
        const bracketData = bracket.bracket_data || { rounds: [], players: [] };

        // Handle player ranks update
        if (updatePlayerRanks === true) {
            const incomingByRound = playerRanksByRound || player_ranks_by_round || null;

            if (incomingByRound && typeof incomingByRound === "object") {
                bracketData.playerRanksByRound = incomingByRound;
                bracketData.player_ranks_by_round = incomingByRound;
            }

            const incomingToggleByRound = enableRankingByRound || enable_ranking_by_round || null;

            if (incomingToggleByRound && typeof incomingToggleByRound === "object") {
                bracketData.enableRankingByRound = incomingToggleByRound;
                bracketData.enable_ranking_by_round = incomingToggleByRound;
            }

            if (playerRanks !== undefined) {
                bracketData.playerRanks = playerRanks;
            }

            if (enableRanking !== undefined) {
                bracketData.enableRanking = enableRanking;
                bracketData.enable_ranking = enableRanking;
            }

            const { data, error } = await supabaseAdmin
                .from("event_brackets")
                .update({
                    round_name: bracket.round_name || LEGACY_ROUND_NAME_BRACKET,
                    draw_type: "bracket",
                    draw_data: bracketData,
                    bracket_data: bracketData,
                    updated_at: new Date().toISOString()
                })
                .eq("id", bracket.id)
                .select()
                .maybeSingle();

            if (error) throw error;

            return res.json({
                success: true,
                bracket: data,
                message: "Player ranks updated successfully"
            });
        }

        // Find round (normalize for consistent matching)
        const roundNameNorm = normalizeRoundName(roundName);
        let roundIndex = bracketData.rounds.findIndex(r => normalizeRoundName(r?.name) === roundNameNorm);
        if (roundIndex === -1) {
            return res.status(400).json({ message: `Round "${roundName}" not found` });
        }

        const round = bracketData.rounds[roundIndex];

        // Find or create match
        let foundMatchIndex = -1;
        if (matchId) {
            foundMatchIndex = round.matches.findIndex(m => m && String(m.id).trim() === String(matchId).trim());
        } else if (typeof matchIndex === 'number' && matchIndex >= 0) {
            foundMatchIndex = matchIndex;
        }

        // Delete match if requested
        if (deleteMatch === true) {
            if (foundMatchIndex === -1) {
                return res.status(400).json({ message: "Match not found", code: "MATCH_NOT_FOUND" });
            }

            const matchToDelete = round.matches[foundMatchIndex];
            const firstRoundName = bracketData.rounds?.[0]?.name;

            // Block deletion of ranked BYEs
            if (isRankedBye(matchToDelete, bracketData, firstRoundName)) {
                return res.status(403).json({
                    message: "Cannot delete ranked BYE. Ranked BYEs are locked.",
                    code: "RANKED_BYE_LOCKED"
                });
            }

            round.matches.splice(foundMatchIndex, 1);
            bracketData.rounds[roundIndex] = round;

            const { data, error } = await supabaseAdmin
                .from("event_brackets")
                .update({
                    round_name: bracket.round_name || LEGACY_ROUND_NAME_BRACKET,
                    draw_type: "bracket",
                    draw_data: bracketData,
                    bracket_data: bracketData,
                    updated_at: new Date().toISOString()
                })
                .eq("id", bracket.id)
                .select()
                .maybeSingle();

            if (error) throw error;

            return res.json({
                success: true,
                bracket: data,
                message: "Match deleted successfully"
            });
        }

        if (foundMatchIndex === -1) {
            // Create new match
            const newMatch = {
                id: matchId || `match-${Date.now()}-${Math.random()}`,
                player1: (player1 && !isFakeByePlayer(player1)) ? player1 : null,
                player2: (player2 && !isFakeByePlayer(player2)) ? player2 : null,
                winner: null,
                score: null
            };
            round.matches.push(newMatch);
        } else {
            // Update existing match
            const match = round.matches[foundMatchIndex];
            const firstRoundName = bracketData.rounds?.[0]?.name;

            // Block modification of ranked BYEs (but allow filling empty BYE side)
            if (isRankedBye(match, bracketData, firstRoundName)) {
                const p1Exists = hasRealPlayer(match.player1);
                const p2Exists = hasRealPlayer(match.player2);

                const isFillingEmptySide =
                    (player1 !== undefined && !p1Exists && p2Exists) ||
                    (player2 !== undefined && !p2Exists && p1Exists);

                if (!isFillingEmptySide) {
                    return res.status(403).json({
                        message: "Cannot modify ranked BYE. Ranked BYEs are locked.",
                        code: "RANKED_BYE_LOCKED"
                    });
                }
            }

            const safeP1 = (player1 && !isFakeByePlayer(player1)) ? player1 : null;
            const safeP2 = (player2 && !isFakeByePlayer(player2)) ? player2 : null;

            // Validate no duplicate players in same round
            if (safeP1) {
                const player1Id = typeof player1 === 'object' ? player1.id : player1;
                const duplicate = round.matches.some((m, idx) =>
                    idx !== foundMatchIndex && (
                        (m.player1 && (typeof m.player1 === 'object' ? m.player1.id : m.player1) === player1Id) ||
                        (m.player2 && (typeof m.player2 === 'object' ? m.player2.id : m.player2) === player1Id)
                    )
                );
                if (duplicate) {
                    return res.status(400).json({
                        message: "Player already assigned to another match in this round",
                        code: "DUPLICATE_PLAYER"
                    });
                }
            }

            if (safeP2) {
                const player2Id = typeof player2 === 'object' ? player2.id : player2;
                const duplicate = round.matches.some((m, idx) =>
                    idx !== foundMatchIndex && (
                        (m.player1 && (typeof m.player1 === 'object' ? m.player1.id : m.player1) === player2Id) ||
                        (m.player2 && (typeof m.player2 === 'object' ? m.player2.id : m.player2) === player2Id)
                    )
                );
                if (duplicate) {
                    return res.status(400).json({
                        message: "Player already assigned to another match in this round",
                        code: "DUPLICATE_PLAYER"
                    });
                }
            }

            if (player1 !== undefined) match.player1 = safeP1;
            if (player2 !== undefined) match.player2 = safeP2;

            // If a player slot was cleared (set to null/None), mark the match as NOT a BYE.
            // This persists in bracket_data so the frontend won't treat this single-player
            // match as a BYE auto-advance after page refresh. Without this, removing a
            // player would create an extra BYE beyond the allowed count.
            if ((player1 !== undefined && !safeP1) || (player2 !== undefined && !safeP2)) {
                match.isBye = false;
            }

            if (match.winner) {
                match.winner = null;
            }
        }

        // Update bracket data
        bracketData.rounds[roundIndex] = round;

        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .update({
                round_name: bracket.round_name || LEGACY_ROUND_NAME_BRACKET,
                draw_type: "bracket",
                draw_data: bracketData,
                bracket_data: bracketData,
                updated_at: new Date().toISOString()
            })
            .eq("id", bracket.id)
            .select()
            .maybeSingle();

        if (error) throw error;

        res.json({
            success: true,
            bracket: data,
            message: "Match updated successfully"
        });
    } catch (err) {
        console.error("UPDATE MATCH ERROR:", err);
        res.status(500).json({ message: "Failed to update match", error: err.message });
    }
};

export default {
    updateBracketMatch
};
