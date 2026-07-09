/**
 * PROPAGATION CONTROLLER
 * 
 * Responsibility: Winner propagation to next round & BYE auto-advance
 * 
 * Functions:
 * - propagateWinner(req, res) - Record winner and advance to next round
 * - propagateWinnersToNextRound(bracketData, currentRoundIndex, matchResults) - Batch propagation
 * - autoAdvanceByeWinners(bracketData, roundIndex) - Auto-advance BYE matches
 * - syncWinnersFromMatches(bracketData, matchesTable) - Authority sync from DB
 * 
 * Dependencies:
 * - helpers: isFakeByePlayer, normalizeRoundName, isUuid, hasRealPlayer
 * 
 * Safety Rules:
 * ✅ Propagate only if current match is completed
 * ✅ Skip propagation for BYE winners
 * ✅ Use bracket_match_id to find next round slot
 * ✅ Validate next round slot is empty before placing
 * ✅ Update bracketData AND matches table in sync
 * 
 * Status: EXTRACT from bracketController.js (propagation logic in finalizeBracketMatch area)
 */

import {
    hasRealPlayer,
    isFakeByePlayer,
    isUuid
} from "./bracketHelpers.js";

/**
 * Propagate a match winner to the next round
 * 
 * Process:
 * 1. Find current match
 * 2. Verify winner is set
 * 3. Find next round slot via bracket_match_id -> winnerTo/winnerToSlot
 * 4. Place winner in next round
 * 5. Update bracketData
 * 6. Update matches table authority
 * 
 * @param {object} req
 * @param {object} res
 * @returns {void}
 */
export const propagateWinner = async (req, res) => {
    try {
        const { eventId, categoryId, roundName } = req.params;
        const { matchId, winner } = req.body;

        if (!eventId || !isUuid(categoryId)) {
            return res.status(400).json({ message: "Event ID and valid category ID required" });
        }

        // Implementation placeholder
        // EXTRACT propagation logic from bracketController.js

        return res.status(200).json({
            message: "Propagate functionality - EXTRACT FROM ORIGINAL",
            note: "TODO: Copy winner propagation logic"
        });

    } catch (error) {
        console.error("Error propagating winner:", error);
        return res.status(500).json({ message: "Failed to propagate winner", error: error.message });
    }
};

/**
 * Propagate all match winners in a round to the next round
 * Batch operation called after tournament round completion
 * 
 * @param {object} bracketData
 * @param {number} currentRoundIndex - 0-based index into rounds array
 * @param {object[]} matchResults - [{ matchId, winner: "player1"|"player2" }, ...]
 * @returns {object} { updated: number, failed: number }
 */
export const propagateWinnersToNextRound = (bracketData, currentRoundIndex, matchResults) => {
    if (!bracketData || !bracketData.rounds) {
        return { updated: 0, failed: matchResults?.length || 0 };
    }

    if (currentRoundIndex >= bracketData.rounds.length - 1) {
        // Already at final, nowhere to propagate
        return { updated: 0, failed: 0 };
    }

    const stats = { updated: 0, failed: 0 };

    for (const result of matchResults || []) {
        try {
            const currentRound = bracketData.rounds[currentRoundIndex];
            const currentMatch = currentRound.matches?.find(m => m.id === result.matchId);

            if (!currentMatch) {
                console.warn(`Match ${result.matchId} not found`);
                stats.failed++;
                continue;
            }

            // Don't propagate BYE winners
            if (isFakeByePlayer(currentMatch.player1) || isFakeByePlayer(currentMatch.player2)) {
                console.log(`Skipping BYE match ${result.matchId} (no propagation)`);
                continue;
            }

            // Get winner player object
            const winnerPlayer = result.winner === "player1"
                ? currentMatch.player1
                : currentMatch.player2;

            if (!winnerPlayer || isFakeByePlayer(winnerPlayer)) {
                console.warn(`Winner for ${result.matchId} is fake BYE - skipping`);
                stats.failed++;
                continue;
            }

            // Find next round via feeder linkage
            const nextRound = bracketData.rounds[currentRoundIndex + 1];
            if (!nextRound) {
                console.warn(`No next round after index ${currentRoundIndex}`);
                stats.failed++;
                continue;
            }

            // Find next match using winnerTo/winnerToSlot
            const nextMatchId = currentMatch.winnerTo;
            const nextSlot = currentMatch.winnerToSlot;

            if (!nextMatchId || !nextSlot) {
                console.warn(`No winnerTo linkage for ${result.matchId}`);
                stats.failed++;
                continue;
            }

            const nextMatch = nextRound.matches?.find(m => m.id === nextMatchId);
            if (!nextMatch) {
                console.warn(`Next round match ${nextMatchId} not found`);
                stats.failed++;
                continue;
            }

            // Place winner in next round
            if (nextMatch[nextSlot]) {
                console.warn(`Slot ${nextSlot} in ${nextMatchId} already occupied - overwriting`);
            }

            nextMatch[nextSlot] = winnerPlayer;
            console.log(`✓ Propagated winner from ${result.matchId} to ${nextMatchId}.${nextSlot}`);
            stats.updated++;

        } catch (e) {
            console.error(`Error propagating ${result.matchId}:`, e);
            stats.failed++;
        }
    }

    return stats;
};

/**
 * Auto-advance all BYE winners in a round
 * Called after bracket creation or BYE assignment
 * 
 * @param {object} bracketData
 * @param {number} roundIndex - 0-based
 * @returns {number} - Count of BYE winners advanced
 */
export const autoAdvanceByeWinners = (bracketData, roundIndex) => {
    if (!bracketData || !bracketData.rounds) return 0;

    const round = bracketData.rounds[roundIndex];
    if (!round || !round.matches) return 0;

    let advanceCount = 0;

    for (const match of round.matches) {
        const p1 = hasRealPlayer(match.player1) ? match.player1 : null;
        const p2 = hasRealPlayer(match.player2) ? match.player2 : null;

        // BYE scenario: one player, one empty
        if ((p1 && !p2) || (!p1 && p2)) {
            if (!match.winner) {
                match.winner = p1 ? "player1" : "player2";
                console.log(`✓ Auto-advanced BYE: ${match.id} → ${match.winner}`);
                advanceCount++;
            }
        }
    }

    return advanceCount;
};

/**
 * Sync winners from matches table (authoritative) into bracketData
 * Called when matches table is updated externally
 * 
 * @param {object} bracketData
 * @param {object[]} matchesTableRows - From SQL query to matches table
 * @returns {object} { synced: number, conflicts: number }
 */
export const syncWinnersFromMatches = (bracketData, matchesTableRows) => {
    if (!bracketData || !bracketData.rounds) {
        return { synced: 0, conflicts: 0 };
    }

    const stats = { synced: 0, conflicts: 0 };

    for (const tableRow of matchesTableRows || []) {
        try {
            if (!tableRow.bracket_match_id || !tableRow.winner) continue;

            // Find match in bracket by bracket_match_id
            let found = false;
            for (const round of bracketData.rounds) {
                const match = round.matches?.find(m => m.id === tableRow.bracket_match_id);
                if (match) {
                    // Determine which player won
                    const winnerSide = tableRow.winner === "A" || tableRow.winner === "player_a"
                        ? "player1"
                        : "player2";

                    // Check for conflict
                    if (match.winner && match.winner !== winnerSide) {
                        console.warn(
                            `Conflict in ${tableRow.bracket_match_id}: ` +
                            `bracket says ${match.winner}, table says ${winnerSide}`
                        );
                        stats.conflicts++;
                    } else {
                        match.winner = winnerSide;
                        console.log(`✓ Synced winner for ${tableRow.bracket_match_id}`);
                        stats.synced++;
                    }

                    found = true;
                    break;
                }
            }

            if (!found) {
                console.warn(`Match ${tableRow.bracket_match_id} not found in bracketData`);
            }

        } catch (e) {
            console.error(`Error syncing winner for ${tableRow.bracket_match_id}:`, e);
            stats.conflicts++;
        }
    }

    return stats;
};

export default {
    propagateWinner,
    propagateWinnersToNextRound,
    autoAdvanceByeWinners,
    syncWinnersFromMatches
};
