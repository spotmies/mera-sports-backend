/**
 * RANK SEEDING CONTROLLER
 * 
 * Responsibility: Place ranked/seeded players into certified slots
 * 
 * Functions:
 * - getSeedValue(playerId, bracketData, roundName) - Get seed number for player [moved to helpers]
 * - placeRankedPlayers(seededPlayers, certifiedSeeding, firstRound, matchCount) - Place all ranked
 * - validateSeedIntegrity(bracketData, playerRanks) - Check seed validity
 * 
 * Dependencies:
 * - generateCertifiedSeedingOrder (from bracketStructureController)
 * 
 * Safety Rules:
 * ❌ Must NOT create BYEs
 * ❌ Must NOT place unranked players
 * ❌ Must NOT modify winners
 * 
 * Status: EXTRACT from bracketController.js lines 650-700
 */

import { supabaseAdmin } from "../../config/supabaseClient.js";
import { getSeedValue } from "./bracketHelpers.js";

/**
 * Place all ranked players into certified seeding slots
 * 
 * Algorithm:
 * 1. For each ranked player with seed N
 * 2. Find N in certified seeding order
 * 3. Calculate which match & slot
 * 4. Place player (ONLY if slot empty)
 * 5. No fallback if seed not found (skip player - data error)
 * 
 * @param {object[]} seededPlayers - Players with seed property [{ ...player, seed: 1 }, ...]
 * @param {number[]} certifiedSeeding - Seeding order from generateCertifiedSeedingOrder
 * @param {object} firstRound - First round object with matches array
 * @param {number} matchCount - Number of matches in first round
 * @returns {void}
 */
export const placeRankedPlayers = (seededPlayers, certifiedSeeding, firstRound, matchCount) => {
    if (!seededPlayers || seededPlayers.length === 0) return;
    if (!certifiedSeeding || certifiedSeeding.length === 0) return;
    if (!firstRound || !firstRound.matches) return;

    // Sort ranked players by seed (ascending: 1 is best)
    const seededSorted = [...seededPlayers].sort((a, b) => (a.seed || 0) - (b.seed || 0));

    for (const player of seededSorted) {
        if (!player.seed) continue;

        // Find the slot index for this seed
        const slotIndex = certifiedSeeding.indexOf(player.seed);
        
        if (slotIndex === -1) {
            // Seed not found in order (data error)
            console.warn(`Seed ${player.seed} not found in certified seeding. Skipping player ${player.name || player.id}`);
            continue;
        }

        // Calculate which match and which slot (player1 or player2)
        const matchIndex = Math.floor(slotIndex / 2);
        const side = slotIndex % 2 === 0 ? "player1" : "player2";

        if (matchIndex >= matchCount) {
            console.warn(`Match index ${matchIndex} exceeds match count ${matchCount}. Skipping.`);
            continue;
        }

        const match = firstRound.matches[matchIndex];
        
        // Only place if slot is currently empty
        if (!match[side]) {
            match[side] = player;
            console.log(`✓ Placed seed ${player.seed} at slot ${slotIndex} (M${matchIndex + 1}.${side})`);
        } else {
            console.warn(`Slot ${slotIndex} (M${matchIndex + 1}.${side}) already occupied. Skipping seed ${player.seed}.`);
        }
    }
};

/**
 * Validate seed integrity
 * 
 * Checks:
 * - No duplicate seeds
 * - No gaps in sequence (if 3 seeds, should be 1,2,3)
 * - All seeds >= 1
 * - Seeds are integers
 * 
 * @param {object} bracketData
 * @param {Map<string, number>|object} playerRanks
 * @returns {object} { valid: boolean, errors: string[] }
 */
export const validateSeedIntegrity = (bracketData, playerRanks) => {
    const errors = [];
    
    if (!playerRanks) return { valid: true, errors };

    // Convert Map to object if needed
    const ranksObj = playerRanks instanceof Map 
        ? Object.fromEntries(playerRanks) 
        : playerRanks;

    const seedValues = Object.values(ranksObj)
        .filter(s => Number.isFinite(s))
        .map(s => parseInt(s, 10));

    if (seedValues.length === 0) return { valid: true, errors };

    // Check for duplicates
    const seedSet = new Set(seedValues);
    if (seedSet.size !== seedValues.length) {
        const duplicates = seedValues.filter((s, i) => seedValues.indexOf(s) !== i);
        errors.push(`Duplicate seeds found: ${[...new Set(duplicates)].join(", ")}`);
    }

    // Check for gaps (seeds should be 1, 2, 3, ... N)
    const minSeed = Math.min(...seedValues);
    const maxSeed = Math.max(...seedValues);
    
    if (minSeed !== 1) {
        errors.push(`Seeds should start from 1, but start from ${minSeed}`);
    }

    for (let s = minSeed; s <= maxSeed; s++) {
        if (!seedSet.has(s)) {
            errors.push(`Gap detected: seed ${s} missing in sequence 1..${maxSeed}`);
        }
    }

    // Check value ranges
    for (const [playerId, seed] of Object.entries(ranksObj)) {
        if (!Number.isFinite(seed) || seed < 1) {
            errors.push(`Invalid seed for player ${playerId}: ${seed}`);
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
};

/**
 * Separate players into seeded and unseeded
 * 
 * @param {object[]} allPlayers
 * @param {object} bracketData
 * @param {string} roundName
 * @returns {object} { seeded: object[], unseeded: object[] }
 */
/**
 * HTTP endpoint: Place ranked players
 * @param {object} req - { eventId, categoryId, body: { playerRanks } }
 * @param {object} res
 */
export const placeRankedPlayersEndpoint = async (req, res) => {
    try {
        const { eventId, categoryId } = req.params;
        const { playerRanks } = req.body;
        
        if (!eventId || !categoryId || !playerRanks) {
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

        // Place ranked players
        placeRankedPlayers(firstRound, playerRanks, bracketData);

        // Update database
        const updated = {
            ...bracket,
            bracket_data: {
                ...bracketData,
                playerRanks
            }
        };

        await supabaseAdmin
            .from("event_brackets")
            .update({ bracket_data: updated.bracket_data })
            .eq("id", bracket.id);

        return res.status(200).json({
            message: "Ranked players placed successfully",
            seeded: Object.keys(playerRanks).length
        });
    } catch (error) {
        console.error("Error placing ranked players:", error);
        return res.status(500).json({ 
            message: "Failed to place ranked players", 
            error: error.message 
        });
    }
};

export const separateSeededUnseeded = (allPlayers, bracketData, roundName) => {
    const seeded = [];
    const unseeded = [];

    for (const player of allPlayers) {
        const seed = getSeedValue(player.id || player.player_id, bracketData, roundName);
        if (seed != null) {
            seeded.push({ ...player, seed });
        } else {
            unseeded.push(player);
        }
    }

    return { seeded, unseeded };
};

export default {
    placeRankedPlayers: placeRankedPlayersEndpoint,
    validateSeedIntegrity,
    separateSeededUnseeded,
    getSeedValue
};
