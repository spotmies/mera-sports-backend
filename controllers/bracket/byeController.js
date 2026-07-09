/**
 * BYE CONTROLLER
 * 
 * Responsibility: BYE slot management (calculation, reservation, randomization, locking, assignment)
 * 
 * Functions:
 * - calculateByeCount(bracketSize, playerCount)
 * - reserveByeSlots(certifiedSeeding, byesTotal)
 * - assignByeWinners(firstRound, reservedByeSlots)
 * - randomizeRound1Byes(req, res) - Implemented from bracketController extraction
 * - assignByeToPlayer(req, res)   - Implemented from bracketController extraction
 * - finalizeByes(req, res)
 */

import { supabaseAdmin } from "../../config/supabaseClient.js";
import {
    getSeedValue,
    hasRealPlayer,
    isRankedBye,
    isSeededLocal,
    isUuid,
    shuffle
} from "./bracketHelpers.js";

/**
 * Calculate how many BYE slots are needed
 */
export const calculateByeCount = (bracketSize, playerCount) => {
    if (playerCount >= bracketSize) return 0;
    return Math.max(0, bracketSize - playerCount);
};

/**
 * Reserve BYE slots for top N seeds
 */
export const reserveByeSlots = (certifiedSeeding, byesTotal) => {
    const reservedSlots = new Set();
    if (!certifiedSeeding || byesTotal <= 0) return reservedSlots;

    for (let seed = 1; seed <= byesTotal; seed++) {
        const seedSlotIndex = certifiedSeeding.indexOf(seed);
        if (seedSlotIndex === -1) {
            console.warn(`Seed ${seed} not found in certified seeding. Cannot reserve BYE slot.`);
            continue;
        }
        // Opponent is on opposite side of match
        const opponentSlotIndex = seedSlotIndex % 2 === 0
            ? seedSlotIndex + 1
            : seedSlotIndex - 1;

        reservedSlots.add(opponentSlotIndex);
    }
    return reservedSlots;
};

/**
 * Mark winners for all BYE matches (auto-advance)
 */
export const assignByeWinners = (firstRound) => {
    if (!firstRound || !firstRound.matches) return;

    for (const match of firstRound.matches) {
        const p1 = match.player1 && typeof match.player1 === "object" && (match.player1.id || match.player1.player_id);
        const p2 = match.player2 && typeof match.player2 === "object" && (match.player2.id || match.player2.player_id);

        if (p1 && !p2) {
            match.winner = "player1";
        } else if (!p1 && p2) {
            match.winner = "player2";
        } else {
            match.winner = null;
        }
    }
};

/**
 * Randomize Round 1 BYE positions while preserving top-seed BYEs
 */
export const randomizeRound1Byes = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, expectedTotalPlayers } = req.body || {};

        console.log("[Round1 BYE] randomizeRound1Byes called", {
            eventId,
            categoryId,
            categoryLabel,
            expectedTotalPlayers
        });

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (categoryId) {
            query = query.eq("category_id", categoryId);
        } else if (categoryLabel) {
            query = query.eq("category", categoryLabel);
        }

        const { data: brackets, error: fetchError } = await query;
        if (fetchError) throw fetchError;
        if (!brackets || brackets.length === 0) {
            return res.status(404).json({ message: "Bracket not found" });
        }

        const bracket = brackets[0];
        if (bracket.published === true) {
            return res.status(400).json({ message: "Unpublish bracket before randomizing BYEs" });
        }

        const bracketData = bracket.bracket_data || { rounds: [], players: [] };
        const rounds = Array.isArray(bracketData.rounds) ? bracketData.rounds : [];
        if (rounds.length === 0) {
            return res.status(400).json({ message: "No rounds in bracket" });
        }

        const firstRound = rounds[0];
        const matches = Array.isArray(firstRound.matches) ? firstRound.matches : [];
        const slotCount = matches.length * 2;
        const firstRoundName = firstRound.name;

        // === HARD DIAGNOSTIC TRACE ===
        console.log("==== [Round1 BYE RESHUFFLE] RAW RANK MAP FROM DB ====");
        console.log("playerRanks:", (bracketData.playerRanks || bracketData.player_ranks || null));

        // Collect seeded vs unseeded slots
        const seededSlots = [];   // { matchIndex, slot, player, seed }
        const unseededPlayers = [];
        let totalPlayers = 0;

        for (let i = 0; i < matches.length; i++) {
            const m = matches[i];
            const p1 = hasRealPlayer(m.player1) ? m.player1 : null;
            const p2 = hasRealPlayer(m.player2) ? m.player2 : null;

            if (p1) {
                totalPlayers++;
                if (isSeededLocal(p1, bracketData, firstRoundName)) {
                    const s = getSeedValue(p1.id || p1.player_id, bracketData, firstRoundName) || 9999;
                    seededSlots.push({ matchIndex: i, slot: "player1", player: p1, seed: s });
                } else {
                    unseededPlayers.push(p1);
                }
            }
            if (p2) {
                totalPlayers++;
                if (isSeededLocal(p2, bracketData, firstRoundName)) {
                    const s = getSeedValue(p2.id || p2.player_id, bracketData, firstRoundName) || 9999;
                    seededSlots.push({ matchIndex: i, slot: "player2", player: p2, seed: s });
                } else {
                    unseededPlayers.push(p2);
                }
            }
        }

        // STEP 3 — VERIFY SORT ORDER OF SEEDED SLOTS
        const seededSortedView = [...seededSlots]
            .sort((a, b) => (a.seed || 0) - (b.seed || 0))
            .map(s => ({
                matchIndex: s.matchIndex,
                side: s.slot,
                playerId: s.player.id || s.player.player_id,
                seed: s.seed
            }));
        console.log("==== [Round1 BYE RESHUFFLE] SEEDED SORTED ORDER (CURRENT ROUND 1) ====");
        console.log(seededSortedView);

        // BYE count calculation
        let effectiveTotalPlayers = totalPlayers;
        if (expectedTotalPlayers && Number(expectedTotalPlayers) > 0) {
            effectiveTotalPlayers = Number(expectedTotalPlayers);
            if (effectiveTotalPlayers !== totalPlayers) {
                console.warn(`[Round1 BYE] Player count mismatch: Request expects ${effectiveTotalPlayers}, but found ${totalPlayers} in matches. Using expected count.`);
            }
        }

        let byesTotal = Math.max(0, slotCount - effectiveTotalPlayers);
        if (effectiveTotalPlayers >= slotCount) byesTotal = 0;

        // Calculate locked top-seed BYEs
        let lockedSeedByeCount = 0;
        const topNForByes = Math.min(byesTotal, seededSortedView.length);
        const topSeedValues = seededSortedView.slice(0, topNForByes).map(s => s.seed);
        const topSeedValueSet = new Set(topSeedValues);
        const lockedTopSeedValues = new Set();

        for (let i = 0; i < matches.length; i++) {
            const m = matches[i];
            const p1 = hasRealPlayer(m.player1) ? m.player1 : null;
            const p2 = hasRealPlayer(m.player2) ? m.player2 : null;

            const seed1 = p1 && isSeededLocal(p1, bracketData, firstRoundName);
            const seed2 = p2 && isSeededLocal(p2, bracketData, firstRoundName);
            const seedVal1 = seed1 ? getSeedValue(p1.id || p1.player_id, bracketData, firstRoundName) : null;
            const seedVal2 = seed2 ? getSeedValue(p2.id || p2.player_id, bracketData, firstRoundName) : null;

            const byeOnTopSeed =
                (seed1 && !p2 && seedVal1 != null && topSeedValueSet.has(seedVal1)) ||
                (seed2 && !p1 && seedVal2 != null && topSeedValueSet.has(seedVal2));

            if (byeOnTopSeed) {
                lockedSeedByeCount++;
                if (seedVal1 != null && seed1) lockedTopSeedValues.add(seedVal1);
                if (seedVal2 != null && seed2) lockedTopSeedValues.add(seedVal2);
            }
        }
        const byesToAssign = Math.max(0, byesTotal - lockedSeedByeCount);

        if (byesTotal <= 0) {
            // No BYEs to randomize. 
            // CRITICAL: Do NOT reset winners here, as it invalidates played matches in full brackets.
            return res.status(200).json({
                success: true,
                message: "Full bracket (no BYEs needed). No changes made."
            });
        } else {
            // Reshuffle Logic
            const unseededPlayersPool = [];
            const unlockedSlots = [];

            for (let i = 0; i < matches.length; i++) {
                const m = matches[i];
                const p1 = hasRealPlayer(m.player1) ? m.player1 : null;
                const p2 = hasRealPlayer(m.player2) ? m.player2 : null;

                if (m.isManualBye === true) continue;
                if (isRankedBye(m, bracketData, firstRoundName)) continue;

                const seed1 = p1 && isSeededLocal(p1, bracketData, firstRoundName);
                const seed2 = p2 && isSeededLocal(p2, bracketData, firstRoundName);
                const seedVal1 = seed1 ? getSeedValue(p1.id || p1.player_id, bracketData, firstRoundName) : null;
                const seedVal2 = seed2 ? getSeedValue(p2.id || p2.player_id, bracketData, firstRoundName) : null;

                m.winner = null;

                const seedHasBye = (seed1 && !p2) || (seed2 && !p1);
                const byeLockedHere =
                    (seed1 && !p2 && seedVal1 != null && topSeedValueSet.has(seedVal1)) ||
                    (seed2 && !p1 && seedVal2 != null && topSeedValueSet.has(seedVal2));

                if (seedHasBye && byeLockedHere) continue; // Locked BYE

                if (seed1) {
                    // seeded player stays
                } else {
                    if (p1) unseededPlayersPool.push(p1);
                    unlockedSlots.push({ matchIndex: i, slot: "player1" });
                    m.player1 = null;
                }

                if (seed2) {
                    // seeded player stays
                } else {
                    if (p2) unseededPlayersPool.push(p2);
                    unlockedSlots.push({ matchIndex: i, slot: "player2" });
                    m.player2 = null;
                }
            }

            const shuffledSlots = shuffle(unlockedSlots);
            const shuffledPlayers = shuffle(unseededPlayersPool);

            const unlockedKeySet = new Set(unlockedSlots.map(s => `${s.matchIndex}:${s.slot}`));
            const byeSlotKeys = new Set();

            // Priority: Give BYEs to top seeds first
            const preferredByeKeys = [];
            for (const s of seededSlots) {
                if (!topSeedValueSet.has(s.seed)) continue;
                if (lockedTopSeedValues.has(s.seed)) continue;
                const opponentSide = s.slot === "player1" ? "player2" : "player1";
                const key = `${s.matchIndex}:${opponentSide}`;
                if (unlockedKeySet.has(key)) {
                    preferredByeKeys.push(key);
                }
            }

            let remainingByes = byesToAssign;
            for (const key of preferredByeKeys) {
                if (remainingByes <= 0) break;
                byeSlotKeys.add(key);
                remainingByes--;
            }

            // Randomly assign rest
            if (remainingByes > 0) {
                for (const s of shuffledSlots) {
                    if (remainingByes <= 0) break;
                    const key = `${s.matchIndex}:${s.slot}`;
                    if (byeSlotKeys.has(key)) continue;
                    byeSlotKeys.add(key);
                    remainingByes--;
                }
            }

            // Place unseeded players
            let playerIndex = 0;
            for (const slot of shuffledSlots) {
                const key = `${slot.matchIndex}:${slot.slot}`;
                if (byeSlotKeys.has(key)) continue; // It's a BYE

                const player = shuffledPlayers[playerIndex++] || null;
                if (!player) continue;
                const m = matches[slot.matchIndex];
                m[slot.slot] = player;
            }

            // Fix winners
            for (let i = 0; i < matches.length; i++) {
                const m = matches[i];
                const p1 = hasRealPlayer(m.player1) ? m.player1 : null;
                const p2 = hasRealPlayer(m.player2) ? m.player2 : null;
                if (p1 && !p2) m.winner = "player1";
                else if (!p1 && p2) m.winner = "player2";
                else m.winner = null;
            }
        }

        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .update({
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
            message: "BYE placement randomized"
        });

    } catch (err) {
        console.error("RANDOMIZE BYES ERROR:", err);
        return res.status(500).json({ message: "Failed to randomize BYEs", error: err.message });
    }
};

/**
 * Assign BYE to unranked player (manual BYE assignment)
 */
export const assignByeToPlayer = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, matchId, playerId } = req.body || {};

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }
        if (!matchId || !playerId) {
            return res.status(400).json({ message: "matchId and playerId are required" });
        }

        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (categoryId) {
            query = query.eq("category_id", categoryId);
        } else if (categoryLabel) {
            query = query.eq("category", categoryLabel);
        }

        const { data: brackets, error: fetchError } = await query;
        if (fetchError) throw fetchError;
        if (!brackets || brackets.length === 0) {
            return res.status(404).json({ message: "Bracket not found" });
        }

        const bracket = brackets[0];
        if (bracket.published === true) {
            return res.status(400).json({ message: "Unpublish bracket before assigning BYEs" });
        }

        const bracketData = bracket.bracket_data || { rounds: [], players: [] };
        const rounds = Array.isArray(bracketData.rounds) ? bracketData.rounds : [];
        if (rounds.length === 0) {
            return res.status(400).json({ message: "No rounds in bracket" });
        }

        const firstRound = rounds[0];
        const matches = Array.isArray(firstRound.matches) ? firstRound.matches : [];
        const matchIndex = matches.findIndex(m => String(m?.id || "").trim() === String(matchId).trim());

        if (matchIndex === -1) {
            return res.status(404).json({ message: "Match not found in Round 1" });
        }

        const match = matches[matchIndex];
        const p1 = hasRealPlayer(match.player1) ? match.player1 : null;
        const p2 = hasRealPlayer(match.player2) ? match.player2 : null;

        const isCurrentlyBye = (p1 && !p2) || (!p1 && p2);
        if (!isCurrentlyBye) {
            return res.status(400).json({ message: "Match must be a BYE (one player, one empty slot)" });
        }

        const firstRoundName = firstRound.name;
        if (isRankedBye(match, bracketData, firstRoundName)) {
            return res.status(403).json({
                message: "Cannot modify ranked BYE. Ranked BYEs are locked.",
                code: "RANKED_BYE_LOCKED"
            });
        }

        // Check if existing player is ranked
        const existingPlayerId = p1 ? (p1.id || p1.player_id) : (p2 ? (p2.id || p2.player_id) : null);
        if (existingPlayerId && getSeedValue(existingPlayerId, bracketData, firstRoundName) != null) {
            return res.status(400).json({ message: "Cannot modify BYE assigned to ranked player" });
        }

        // Verify new player is unranked
        if (getSeedValue(playerId, bracketData, firstRoundName) != null) {
            return res.status(400).json({ message: "Cannot assign ranked player to BYE. Ranked players get BYEs automatically." });
        }

        // Verify player uniqueness
        for (const r of rounds) {
            for (const m of (r.matches || [])) {
                if (m.id === matchId) continue;
                const mp1 = hasRealPlayer(m.player1) ? m.player1 : null;
                const mp2 = hasRealPlayer(m.player2) ? m.player2 : null;
                const mp1Id = mp1 ? (mp1.id || mp1.player_id) : null;
                const mp2Id = mp2 ? (mp2.id || mp2.player_id) : null;
                if (mp1Id === playerId || mp2Id === playerId) {
                    return res.status(400).json({ message: "Player is already assigned to another match" });
                }
            }
        }

        // Fetch user data
        let playerObj = null;
        try {
            const { data: reg, error: regError } = await supabaseAdmin
                .from("event_registrations")
                .select("id, player_id, player_name, team_name, is_team")
                .eq("event_id", eventId)
                .eq("id", playerId)
                .single();

            if (!regError && reg) {
                playerObj = {
                    id: reg.id,
                    playerId: reg.player_id,
                    name: reg.player_name || reg.team_name || `Player ${reg.player_id || reg.id}`,
                    isTeam: reg.is_team || false
                };
            } else {
                return res.status(404).json({ message: "Player not found in registrations" });
            }
        } catch (err) {
            return res.status(500).json({ message: "Failed to fetch player data", error: err.message });
        }

        // Swap: replace existing player with new one, keep other slot empty (BYE persists)
        // The new player gets the BYE (free pass to next round)
        if (p1) {
            match.player1 = playerObj;
            match.player2 = null;
            match.winner = "player1";
        } else {
            match.player1 = null;
            match.player2 = playerObj;
            match.winner = "player2";
        }
        match.isManualBye = true;

        // Save
        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .update({
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
            message: "BYE assigned to player"
        });

    } catch (err) {
        console.error("ASSIGN BYE ERROR:", err);
        res.status(500).json({ message: "Failed to assign BYE", error: err.message });
    }
};

/**
 * Finalize BYE positions (lock them)
 */
export const finalizeByes = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;

        if (!eventId || !isUuid(categoryId)) {
            return res.status(400).json({ message: "Event ID and valid category ID required" });
        }

        const { data: bracket } = await supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("category_id", categoryId)
            .single();

        if (!bracket) {
            return res.status(404).json({ message: "Bracket not found" });
        }

        const updated = {
            ...bracket,
            bracket_data: {
                ...bracket.bracket_data,
                byesFinalized: true,
                finalizedAt: new Date().toISOString()
            }
        };

        await supabaseAdmin
            .from("event_brackets")
            .update({ bracket_data: updated.bracket_data })
            .eq("id", bracket.id);

        return res.status(200).json({
            message: "BYEs finalized",
            byesFinalized: true
        });

    } catch (error) {
        console.error("Error finalizing BYEs:", error);
        return res.status(500).json({ message: "Failed to finalize BYEs", error: error.message });
    }
};

export default {
    calculateByeCount,
    reserveByeSlots,
    assignByeWinners,
    randomizeRound1Byes,
    assignByeToPlayer,
    finalizeByes
};
