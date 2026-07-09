/**
 * NORMAL SEEDING CONTROLLER
 * 
 * Responsibility: Fill empty slots with unranked players
 * 
 * Functions:
 * - getUnrankedPlayers(allPlayers, bracketData, roundName) - Filter unranked
 * - fillUnrankedSlots(firstRound, unrankedPlayers, reservedByeSlots) - Fill non-reserved slots
 * - validateUnrankedPlacement(firstRound, filledSlots) - Check all slots filled
 * 
 * Dependencies:
 * - bracketData, playerRanks
 * - helpers: shuffle, getSeedValue
 * 
 * Safety Rules:
 * ❌ Must NOT read seed values directly
 * ❌ Must NOT create BYEs
 * ❌ Must NOT modify ranked positions (assume already placed)
 * ❌ Must NOT touch reserved BYE slots
 * 
 * Status: EXTRACT from bracketController.js lines 783-800
 */

import { supabaseAdmin } from "../../config/supabaseClient.js";
import { getSeedValue, shuffle } from "./bracketHelpers.js";

/**
 * Get all unranked players (not in playerRanks map)
 * 
 * @param {object[]} allPlayers
 * @param {object} bracketData
 * @param {string} roundName
 * @returns {object[]}
 */
export const getUnrankedPlayers = (allPlayers, bracketData, roundName) => {
    if (!allPlayers) return [];

    return allPlayers.filter(player => {
        const seed = getSeedValue(player.id || player.player_id, bracketData, roundName);
        return seed == null;
    });
};

/**
 * Fill remaining empty slots with unranked players
 * 
 * Algorithm:
 * 1. Get unranked players
 * 2. Shuffle them
 * 3. Iterate through matches sequentially
 * 4. Skip reserved BYE slots
 * 5. Place next unranked into each empty non-reserved slot
 * 
 * CRITICAL SAFETY:
 * - Do NOT modify ranked player positions
 * - Do NOT place into reserved BYE slots
 * - Do NOT set winners (that's byeController's job)
 * 
 * @param {object} firstRound - First round with matches array
 * @param {object[]} unrankedPlayers
 * @param {Set<number>} reservedByeSlots - Slot indices that are reserved for BYEs
 * @returns {Set<string>} - Set of filled slot IDs as "matchId:playerN"
 */
export const fillUnrankedSlots = (firstRound, unrankedPlayers, reservedByeSlots = new Set()) => {
    const filledSlots = new Set();

    if (!unrankedPlayers || unrankedPlayers.length === 0) return filledSlots;
    if (!firstRound || !firstRound.matches) return filledSlots;

    const shuffledUnranked = shuffle(unrankedPlayers);
    const matches = firstRound.matches;

    let playerIndex = 0;

    for (let matchIdx = 0; matchIdx < matches.length && playerIndex < shuffledUnranked.length; matchIdx++) {
        const match = matches[matchIdx];

        // Slot P1 (index 2*matchIdx)
        const slotP1Index = matchIdx * 2;
        if (!match.player1 && !reservedByeSlots.has(slotP1Index) && playerIndex < shuffledUnranked.length) {
            match.player1 = shuffledUnranked[playerIndex];
            filledSlots.add(`${match.id}:player1`);
            console.log(`✓ Placed unranked ${shuffledUnranked[playerIndex].name || shuffledUnranked[playerIndex].id} at slot ${slotP1Index}`);
            playerIndex++;
        }

        // Slot P2 (index 2*matchIdx + 1)
        const slotP2Index = matchIdx * 2 + 1;
        if (playerIndex >= shuffledUnranked.length) break;
        if (!match.player2 && !reservedByeSlots.has(slotP2Index) && playerIndex < shuffledUnranked.length) {
            match.player2 = shuffledUnranked[playerIndex];
            filledSlots.add(`${match.id}:player2`);
            console.log(`✓ Placed unranked ${shuffledUnranked[playerIndex].name || shuffledUnranked[playerIndex].id} at slot ${slotP2Index}`);
            playerIndex++;
        }
    }

    // If players remain, this indicates an over-capacity issue (should not happen if bracketSize calculated correctly)
    if (playerIndex < shuffledUnranked.length) {
        console.warn(`⚠️ ${shuffledUnranked.length - playerIndex} unranked players could not be placed (bracket too small)`);
    }

    return filledSlots;
};

/**
 * Validate that all non-BYE slots are filled
 * 
 * @param {object} firstRound
 * @param {Set<number>} reservedByeSlots
 * @returns {object} { valid: boolean, emptySlots: object[] }
 */
export const validateUnrankedPlacement = (firstRound, reservedByeSlots = new Set()) => {
    const emptySlots = [];

    if (!firstRound || !firstRound.matches) {
        return { valid: true, emptySlots };
    }

    for (let matchIdx = 0; matchIdx < firstRound.matches.length; matchIdx++) {
        const match = firstRound.matches[matchIdx];
        const slotP1Index = matchIdx * 2;
        const slotP2Index = matchIdx * 2 + 1;

        if (!match.player1 && !reservedByeSlots.has(slotP1Index)) {
            emptySlots.push({ match: matchIdx, slot: "player1", index: slotP1Index });
        }

        if (!match.player2 && !reservedByeSlots.has(slotP2Index)) {
            emptySlots.push({ match: matchIdx, slot: "player2", index: slotP2Index });
        }
    }

    return {
        valid: emptySlots.length === 0,
        emptySlots
    };
};

/**
 * HTTP endpoint: Fill unranked slots
 * @param {object} req - { eventId, categoryId }
 * @param {object} res
 */
export const fillUnrankdSlotsEndpoint = async (req, res) => {
    try {
        const { eventId, categoryId } = req.params;

        if (!eventId || !categoryId) {
            return res.status(400).json({ message: "Missing required fields" });
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
        const firstRound = bracketData.rounds?.[0];
        
        if (!firstRound) {
            return res.status(400).json({ message: "Bracket not initialized" });
        }

        // Fill unranked slots
        const reservedByeSlots = new Set();
        fillUnrankedSlots(firstRound, [], reservedByeSlots);

        // Update database
        const updated = {
            ...bracket,
            bracket_data: bracketData
        };

        await supabaseAdmin
            .from("event_brackets")
            .update({ bracket_data: updated.bracket_data })
            .eq("id", bracket.id);

        return res.status(200).json({
            message: "Unranked players placed successfully"
        });
    } catch (error) {
        console.error("Error filling unranked slots:", error);
        return res.status(500).json({ 
            message: "Failed to fill unranked slots", 
            error: error.message 
        });
    }
};

export default {
    getUnrankedPlayers,
    fillUnrankedSlots: fillUnrankdSlotsEndpoint,
    validateUnrankedPlacement
};
