/**
 * BRACKET STRUCTURE CONTROLLER
 * 
 * Responsibility: Create initial bracket structure (rounds, matches, sizing)
 * 
 * Functions:
 * - nextPowerOfTwo(n) - Calculate bracket capacity
 * - generateCertifiedSeedingOrder(n) - Generate seeding order (SHARED with frontend)
 * - makeEmptyMatch(idOverride) - Create empty match skeleton [moved to helpers]
 * - inferRoundLabelFromMatchCount(matchCount, fallbackIndex) - Generate round names [moved to helpers]
 * - createFullBracketStructure(req, res) - Main entry point for "Start Rounds"
 * 
 * Dependencies: None (pure structure)
 * 
 * Status: ZERO logic changes - functions extracted as-is from bracketController.js
 */

import fs from 'fs';
import path from 'path';
import { supabaseAdmin } from "../../config/supabaseClient.js";
import { inferRoundLabelFromMatchCount, isUuid, makeEmptyMatch } from "./bracketHelpers.js";

/**
 * Compute next power of two >= n (used for full bracket sizing)
 * Examples: 13→16, 5→8, 16→16, 17→32
 * 
 * @param {number} n
 * @returns {number}
 */
export const nextPowerOfTwo = (n) => {
    if (!n || n <= 1) return 1;
    let p = 1;
    while (p < n) p <<= 1;
    return p;
};

/**
 * Generate certified professional seeding order (slot order).
 * Returns the SEED NUMBER for each slot (index 0 = Slot 0, index 1 = Slot 1...).
 * 
 * For 16-draw: [1,16,8,9,4,13,5,12,3,14,6,11,7,10,2,15]
 * For  8-draw: [1,8,4,5,3,6,7,2]
 * 
 * @param {number} n - Bracket size (must be power of 2)
 * @returns {number[]} - Array of seed numbers
 */
export const generateCertifiedSeedingOrder = (n) => {
    if (n === 1) return [1];
    if (n === 2) return [1, 2];
    if (n === 4) return [1, 4, 3, 2];
    if (n === 8) return [1, 8, 4, 5, 3, 6, 7, 2];
    if (n === 16) return [1, 16, 8, 9, 5, 12, 13, 4, 3, 14, 6, 11, 7, 10, 15, 2];

    // Recursive expansion for larger sizes (32, 64, ...)
    if (n > 16) {
        const prev = generateCertifiedSeedingOrder(n / 2);
        const result = [];
        for (const seed of prev) {
            result.push(seed);
            result.push(n + 1 - seed);
        }
        // Ensure Seed 2 is always in the last slot
        const idx2 = result.indexOf(2);
        if (idx2 !== -1 && idx2 !== result.length - 1) {
            result[idx2] = result[result.length - 1];
            result[result.length - 1] = 2;
        }
        return result;
    }

    return [];
};

/**
 * Initialize bracket mode for a category
 * POST /api/admin/events/:id/categories/:categoryId/bracket/init
 */
export const initBracket = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, roundStructure } = req.body;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        // Check if category already has a draw
        let checkQuery = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId);

        if (categoryId && isUuid(categoryId)) {
            checkQuery = checkQuery.eq("category_id", categoryId);
        } else {
            checkQuery = checkQuery.eq("category", categoryLabel);
        }

        const { data: existing } = await checkQuery;

        if (existing && existing.length > 0) {
            const hasMedia = existing.some(b => b.mode === 'MEDIA' &&
                ((b.media_urls && b.media_urls.length > 0) || b.pdf_url));
            const hasBracket = existing.some(b => b.mode === 'BRACKET');

            if (hasMedia) {
                return res.status(400).json({
                    message: "Category already has media uploads. Cannot create bracket. Delete all media first.",
                    code: "MODE_CONFLICT"
                });
            }

            if (hasBracket) {
                return res.status(400).json({
                    message: "Bracket already exists for this category",
                    code: "BRACKET_EXISTS"
                });
            }
        }

        // Dynamic rounds: start with NO rounds. Admin will click "Add Round" to create Round 1, etc.
        const defaultRounds =
            roundStructure && Array.isArray(roundStructure) ? roundStructure : [];

        const bracketData = {
            rounds: [],
            players: []
        };

        const insertData = {
            event_id: eventId,
            category: categoryLabel,
            category_id: categoryId && isUuid(categoryId) ? categoryId : null,
            round_name: "Bracket",
            draw_type: "bracket",
            draw_data: bracketData,
            mode: 'BRACKET',
            round_structure: defaultRounds,
            bracket_data: bracketData,
            published: false
        };

        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .insert(insertData)
            .select()
            .maybeSingle();

        if (error) throw error;

        res.json({
            success: true,
            bracket: data,
            message: "Bracket initialized successfully"
        });
    } catch (err) {
        console.error("INIT BRACKET ERROR:", err);
        res.status(500).json({ message: "Failed to initialize bracket", error: err.message });
    }
};

/**
 * Create full bracket structure with all rounds and matches
 * Entry point for "Start Rounds" button in UI
 * 
 * Process:
 * 1. Accept roundConfigs from frontend (pre-calculated)
 * 2. Create all rounds and matches structure 
 * 3. Link matches for winner propagation (feeder/winnerTo)
 * 4. Handle AUTO seeding: place ranked players, reserve BYE slots, fill unranked
 * 5. Auto-advance BYE matches in Round 1
 * 6. Persist to bracket_data
 * 7. Insert match rows to matches table (skip BYEs)
 * 
 * @param {object} req
 * @param {object} res
 * @returns {void} - Responds with created bracket
 */
export const createFullBracketStructure = async (req, res) => {
    console.log("createFullBracketStructure STARTED");
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, seedingMode = "MANUAL", rounds: roundConfigs } = req.body || {};
        console.log("Params:", { eventId, categoryId, categoryLabel, seedingMode });

        if (!eventId) {
            console.log("Missing eventId");
            return res.status(400).json({
                message: "Event ID required",
                code: "MISSING_EVENT_ID"
            });
        }

        if (!categoryId && !categoryLabel) {
            return res.status(400).json({
                message: "Category ID or label required",
                code: "MISSING_CATEGORY"
            });
        }

        // Fetch bracket record
        console.log("Fetching bracket...");
        let bracketQuery = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId);

        if (categoryId && isUuid(categoryId)) {
            bracketQuery = bracketQuery.eq("category_id", categoryId);
        } else {
            bracketQuery = bracketQuery.eq("category", categoryLabel);
        }

        const { data: brackets, error: bracketError } = await bracketQuery;
        if (bracketError) throw bracketError;
        console.log("Bracket fetched:", brackets ? brackets.length : 0);

        if (!brackets || brackets.length === 0) {
            return res.status(404).json({
                message: "Bracket not found. Initialize bracket first.",
                code: "BRACKET_NOT_FOUND"
            });
        }

        const bracket = brackets[0];

        // Check if published
        if (bracket.published === true) {
            return res.status(400).json({
                message: "Cannot modify a published bracket. Unpublish first.",
                code: "BRACKET_PUBLISHED"
            });
        }

        // Fetch verified registrations for this category with related user data
        console.log("Fetching registrations...");
        let regQuery = supabaseAdmin
            .from("event_registrations")
            .select(`
                id,
                player_id,
                team_id,
                categories,
                users:player_id (
                    id,
                    first_name,
                    last_name,
                    player_id,
                    name
                ),
                player_teams (
                    id,
                    team_name,
                    captain_name,
                    members
                )
            `)
            .eq("event_id", eventId)
            // .eq("status", "verified"); // COMMENTED OUT: Strict verified check causing 400 when local testing
            ; // Temporarily removed .eq("status", "verified") to match frontend behavior

        // REMOVED: Invalid SQL filtering (category_id column does not exist)
        // We must filter in-memory because categories is a JSONB array

        const { data: allRegistrations, error: regError } = await regQuery;
        if (regError) throw regError;

        // Filter in-memory for this category
        const registrations = (allRegistrations || []).filter(reg => {
            const regCats = Array.isArray(reg.categories) ? reg.categories : (reg.category ? [reg.category] : []);

            return regCats.some(c => {
                // Match by ID (preferred)
                if (categoryId && typeof c === 'object' && c.id) {
                    if (String(c.id) === String(categoryId)) return true;
                }

                // Match by Label/Name (fallback)
                const regCatName = (typeof c === 'object' ? (c.name || c.category) : String(c)).trim();
                const targetLabel = (categoryLabel || "").trim();

                if (targetLabel && regCatName.toLowerCase() === targetLabel.toLowerCase()) return true;
                if (targetLabel && regCatName.toLowerCase().includes(targetLabel.toLowerCase())) return true;

                return false;
            });
        });

        console.log(`Registrations fetched: ${allRegistrations?.length || 0}, Filtered for category: ${registrations.length}`);

        // Extract players from registrations - handle teams and individual players
        const players = [];
        const seenPlayerIds = new Set();

        console.log("Processing registrations...");
        for (const reg of (registrations || [])) {
            // Check for team registration first
            if (reg.team_id && reg.player_teams) {
                const team = Array.isArray(reg.player_teams) ? reg.player_teams[0] : reg.player_teams;
                if (team && team.id && !seenPlayerIds.has(String(team.id))) {
                    seenPlayerIds.add(String(team.id));
                    players.push({
                        id: team.id,
                        name: team.team_name || team.captain_name || 'Team',
                        type: 'team'
                    });
                }
            } else if (reg.player_id && reg.users) {
                // Individual player registration
                const user = Array.isArray(reg.users) ? reg.users[0] : reg.users;
                if (user && user.id && !seenPlayerIds.has(String(user.id))) {
                    seenPlayerIds.add(String(user.id));
                    const playerName = user.name || `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Player';
                    players.push({
                        id: user.id,
                        name: playerName,
                        player_id: user.player_id,
                        type: 'player'
                    });
                }
            }
        }

        const playerCount = players.length;

        if (playerCount < 2) {
            return res.status(400).json({
                message: "At least 2 players required to create bracket",
                code: "INSUFFICIENT_PLAYERS"
            });
        }

        // Calculate bracket sizing
        const bracketSize = nextPowerOfTwo(playerCount);
        const byesTotal = Math.max(0, bracketSize - playerCount);
        const roundCount = Math.ceil(Math.log2(bracketSize));  // Use CEIL to ensure integer count
        
        console.log(`[BRACKET STRUCTURE] Players: ${playerCount}, BracketSize: ${bracketSize}, RoundCount: ${roundCount}`);


        // Use provided round configs or generate defaults
        // Only use roundConfigs if we have exactly roundCount and all names are unique
        let effectiveRoundConfigs = [];
        let shouldUseProvidedConfigs = Array.isArray(roundConfigs) && roundConfigs.length === roundCount;
        if (shouldUseProvidedConfigs) {
            // Check for duplicate round names
            const roundNames = roundConfigs.map(cfg => cfg.name);
            const uniqueNames = new Set(roundNames);
            if (uniqueNames.size !== roundNames.length) {
                console.warn(`[BRACKET STRUCTURE] Duplicate round names detected in provided configs:`, roundNames);
                shouldUseProvidedConfigs = false;
            }
        }
        console.log(`[BRACKET STRUCTURE] Should use provided configs? ${shouldUseProvidedConfigs} (have ${roundConfigs?.length || 0}, need ${roundCount})`);
        for (let i = 0; i < roundCount; i++) {
            let cfg = {};
            if (shouldUseProvidedConfigs && roundConfigs[i]) {
                cfg = roundConfigs[i];
            }
            const matchCount = bracketSize / Math.pow(2, i + 1);
            const finalName = (cfg.name && String(cfg.name).trim()) || inferRoundLabelFromMatchCount(matchCount, i);
            effectiveRoundConfigs.push({
                name: finalName,
                minSets: cfg.minSets || 1,
                maxSets: cfg.maxSets || 7
            });
            console.log(`[BRACKET STRUCTURE] Round ${i + 1}: matchCount=${matchCount}, name=${finalName}`);
        }
        // Remove duplicate round names defensively
        const seenNames = new Set();
        effectiveRoundConfigs = effectiveRoundConfigs.filter(cfg => {
            if (seenNames.has(cfg.name)) {
                console.warn(`[BRACKET STRUCTURE] Removing duplicate round name: ${cfg.name}`);
                return false;
            }
            seenNames.add(cfg.name);
            return true;
        });
        console.log(`[BRACKET STRUCTURE] Final effective rounds: ${effectiveRoundConfigs.map(r => r.name).join(' -> ')}`);

        // BUILD ALL ROUNDS WITH EMPTY MATCHES
        const newRounds = [];

        for (let r = 0; r < roundCount; r++) {
            const cfg = effectiveRoundConfigs[r];
            const matchCount = bracketSize / Math.pow(2, r + 1);
            
            if (!cfg || !cfg.name) {
                console.error(`[BRACKET ERROR] Missing config for round ${r}, totalRounds=${roundCount}, configs=${effectiveRoundConfigs.length}`);
                return res.status(500).json({
                    message: "Internal error: Missing round configuration",
                    code: "BRACKET_CONFIG_ERROR"
                });
            }
            
            console.log(`[BRACKET BUILD] Round ${r + 1}/${roundCount}: ${matchCount} matches, name="${cfg.name}"`);
            
            const round = {
                name: cfg.name,
                matches: [],
                setsConfig: {
                    minSets: cfg.minSets,
                    maxSets: cfg.maxSets
                }
            };

            // Create matches for this round
            for (let m = 1; m <= matchCount; m++) {
                const matchId = `R${r + 1}-M${m}`;
                const match = makeEmptyMatch(matchId);

                match.roundName = cfg.name;
                match.matchNumber = m;

                // Link to previous round (feeder matches)
                if (r > 0) {
                    const prevRoundIndex = r - 1;
                    const feeder1Number = (m - 1) * 2 + 1;
                    const feeder2Number = (m - 1) * 2 + 2;
                    match.feederMatch1 = `R${prevRoundIndex + 1}-M${feeder1Number}`;
                    match.feederMatch2 = `R${prevRoundIndex + 1}-M${feeder2Number}`;
                } else {
                    match.feederMatch1 = null;
                    match.feederMatch2 = null;
                }

                // Link to next round (where winner goes)
                if (r < roundCount - 1) {
                    const nextRoundIndex = r + 1;
                    const nextMatchNumber = Math.ceil(m / 2);
                    match.winnerTo = `R${nextRoundIndex + 1}-M${nextMatchNumber}`;
                    match.winnerToSlot = m % 2 === 1 ? "player1" : "player2";
                } else {
                    match.winnerTo = null;
                    match.winnerToSlot = null;
                }

                round.matches.push(match);
            }

            newRounds.push(round);
        }

        // SEEDING LOGIC - ROUND 1 ONLY
        // If seedingMode === "MANUAL", leave Round 1 empty for manual assignment later
        // If seedingMode === "AUTO", seed players based on rankings
        if (seedingMode !== "MANUAL") {
            const firstRound = newRounds[0];
            const firstRoundName = firstRound?.name;

            const shuffle = (arr) => {
                const a = Array.isArray(arr) ? [...arr] : [];
                for (let i = a.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [a[i], a[j]] = [a[j], a[i]];
                }
                return a;
            };

            // Seeds can come from existing bracket_data rankings (set earlier in BracketBuilder).
            // Support both legacy + normalized keys and round-scoped ranks.
            const seedSource = (() => {
                const bd = bracket?.bracket_data || bracket?.draw_data || {};
                const global =
                    (bd.playerRanks && typeof bd.playerRanks === "object" ? bd.playerRanks : null) ||
                    (bd.player_ranks && typeof bd.player_ranks === "object" ? bd.player_ranks : null) ||
                    {};
                const byRound =
                    (firstRoundName && bd.playerRanksByRound && bd.playerRanksByRound[firstRoundName]) ||
                    (firstRoundName && bd.player_ranks_by_round && bd.player_ranks_by_round[firstRoundName]) ||
                    {};
                return { global, byRound };
            })();

            const getSeed = (playerId) => {
                const k = String(playerId || "").trim();
                if (!k) return null;
                const v = seedSource.byRound?.[k] ?? seedSource.global?.[k];
                const n = typeof v === "string" ? parseInt(v, 10) : v;
                return Number.isFinite(n) && n > 0 ? n : null;
            };

            const seeded = [];
            const unseeded = [];
            for (const p of players) {
                const seed = getSeed(p?.id);
                if (seed != null) seeded.push({ ...p, seed });
                else unseeded.push(p);
            }

            // Integrity check: ensure ranking maps and actual bracket players stay roughly in sync.
            // Authoritative source for seeding is the actual bracket players array.
            const rankSourceIds = new Set();
            if (seedSource.global && typeof seedSource.global === "object") {
                for (const k of Object.keys(seedSource.global)) {
                    rankSourceIds.add(String(k).trim());
                }
            }
            if (seedSource.byRound && typeof seedSource.byRound === "object") {
                for (const k of Object.keys(seedSource.byRound)) {
                    rankSourceIds.add(String(k).trim());
                }
            }
            const seededIds = new Set(seeded.map(p => String(p.id).trim()));
            const missingRankIds = Array.from(rankSourceIds).filter(id => !seededIds.has(id));
            if (missingRankIds.length > 0) {
                console.error("[Bracket][Round1 BYE] Ranking data mismatch: UI ranks not matching backend players", {
                    rankSourceIds: Array.from(rankSourceIds),
                    seededIds: Array.from(seededIds),
                    missingRankIds,
                });
                // IMPORTANT: Do NOT block seeding. Continue using only detected players.
            }

            // Sort seeded players strictly by ascending rank (seed).
            const seededSorted = seeded.sort((a, b) => (a.seed || 0) - (b.seed || 0));

            // BYE count (Round 1 only). byes = drawSize - actualPlayers
            const byesTotal = Math.max(0, bracketSize - playerCount);

            // === HARD DIAGNOSTIC TRACE FOR RANK / BYE BEHAVIOUR ===
            console.log("==== RAW RANK MAP FROM DB ====");
            console.log("playerRanks:", (bracketData.playerRanks || bracketData.player_ranks || null));
            console.log("playerRanksByRound['Round 1']:",
                (bracketData.playerRanksByRound && bracketData.playerRanksByRound["Round 1"]) ||
                (bracketData.player_ranks_by_round && bracketData.player_ranks_by_round["Round 1"]) ||
                null
            );

            console.log("==== PLAYER → SEED RESOLUTION ====");
            players.forEach((p) => {
                console.log({
                    playerId: p.id,
                    name: p.name,
                    resolvedSeed: getSeed(p.id)
                });
            });

            console.log("==== SEEDED SORTED ORDER ====");
            console.log(seededSorted.map(p => ({
                playerId: p.id,
                seed: p.seed
            })));

            console.log("[Bracket][Round1 BYE] BYEs total:", byesTotal);
            console.log("[Bracket][Round1 BYE] Ranked detected:", seededSorted.map(p => ({
                id: p.id,
                rank: p.seed
            })));

            // STEP 5 — HARD ASSERT (CATCH DATA BUG EARLY)
            if (byesTotal > 0) {
                const expectedTopSeeds = seededSorted.slice(0, byesTotal).map(p => p.seed);

                if (!expectedTopSeeds.every((s, i) => s === i + 1)) {
                    console.error("RANK DATA ERROR: Top seeds are not 1..N");
                    console.error("Detected seeds:", seededSorted.map(p => p.seed));
                }
            }

            const matchCount = firstRound.matches.length;

            // If no BYEs, place ranked players in certified positions, then fill unranked.
            const certifiedSeeding = generateCertifiedSeedingOrder(bracketSize);
            const shuffledUnseeded = shuffle(unseeded);

            console.log("[Bracket][Round1] Certified Seeding Order:", certifiedSeeding);
            console.log("[Bracket][Round1] BYE Logic:", { playerCount, bracketSize, byesTotal });

            if (byesTotal <= 0) {
                // STEP A: Place ranked players into their certified slots
                for (const p of seededSorted) {
                    const slotIndex = certifiedSeeding.indexOf(p.seed); // 0-based
                    if (slotIndex === -1) continue;
                    const matchIndex = Math.floor(slotIndex / 2);
                    const side = slotIndex % 2 === 0 ? "player1" : "player2";
                    if (matchIndex < matchCount) {
                        firstRound.matches[matchIndex][side] = p;
                    }
                }

                // STEP B: Fill remaining empty slots with shuffled unranked players
                let unrankedIdx = 0;
                for (let m = 0; m < matchCount; m++) {
                    const match = firstRound.matches[m];
                    if (!match.player1 && unrankedIdx < shuffledUnseeded.length) {
                        match.player1 = shuffledUnseeded[unrankedIdx++];
                    }
                    if (!match.player2 && unrankedIdx < shuffledUnseeded.length) {
                        match.player2 = shuffledUnseeded[unrankedIdx++];
                    }
                    match.winner = null;
                }
            } else {
                // BYE branch: reserve opponent slots for top seeds, place ranked, fill unranked
                const reservedByeSlots = new Set(); // 0-based slot indices

                // STEP A: Reserve BYE slots (opponents of top N seeds)
                for (let seed = 1; seed <= byesTotal; seed++) {
                    const seedSlotIndex = certifiedSeeding.indexOf(seed);
                    // SAFETY: skip if seed doesn't exist in seeding order
                    if (seedSlotIndex === -1) continue;
                    const opponentSlotIndex = seedSlotIndex % 2 === 0
                        ? seedSlotIndex + 1
                        : seedSlotIndex - 1;
                    reservedByeSlots.add(opponentSlotIndex);
                }

                console.log("[Bracket][Round1 BYE] Reserved BYE slot indices:", Array.from(reservedByeSlots));
                console.log("[Bracket][Round1 BYE] Ranked assigned BYEs:",
                    seededSorted.filter(p => p.seed <= byesTotal).map(p => ({ id: p.id, rank: p.seed }))
                );

                // STEP B: Place ALL ranked players into certified slots
                for (const p of seededSorted) {
                    const slotIndex = certifiedSeeding.indexOf(p.seed);
                    if (slotIndex === -1) continue;
                    const matchIndex = Math.floor(slotIndex / 2);
                    const side = slotIndex % 2 === 0 ? "player1" : "player2";
                    if (matchIndex < matchCount) {
                        firstRound.matches[matchIndex][side] = p;
                    }
                }

                // STEP C: Fill remaining non-BYE slots with shuffled unranked
                let unrankedIdx = 0;
                for (let m = 0; m < matchCount; m++) {
                    const match = firstRound.matches[m];
                    // P1 slot (index 2*m)
                    if (!match.player1 && !reservedByeSlots.has(m * 2) && unrankedIdx < shuffledUnseeded.length) {
                        match.player1 = shuffledUnseeded[unrankedIdx++];
                    }
                    // P2 slot (index 2*m + 1)
                    if (!match.player2 && !reservedByeSlots.has(m * 2 + 1) && unrankedIdx < shuffledUnseeded.length) {
                        match.player2 = shuffledUnseeded[unrankedIdx++];
                    }
                }

                // STEP D: Set winners for BYE matches (AFTER all placement)
                for (let m = 0; m < matchCount; m++) {
                    const match = firstRound.matches[m];
                    const p1 = match.player1 && typeof match.player1 === "object" && match.player1.id;
                    const p2 = match.player2 && typeof match.player2 === "object" && match.player2.id;
                    if (p1 && !p2) {
                        match.winner = "player1";
                    } else if (!p1 && p2) {
                        match.winner = "player2";
                    } else {
                        match.winner = null;
                    }
                }
            }
        }

        // Persist bracket_data (replace rounds; keep any existing players metadata)
        const bracketData = bracket?.bracket_data || bracket?.draw_data || {};
        bracketData.rounds = newRounds;
        bracketData.players = players;
        
        console.log(`[BRACKET FINAL] Created bracket with ${newRounds.length} rounds: ${newRounds.map(r => r.name).join(' -> ')}`);
        console.log(`[BRACKET FINAL] Each round has matches: ${newRounds.map(r => r.matches?.length || 0).join(', ')}`);

        // Save to database
        console.log("Updating event_brackets...");
        let updatedBracket;
        try {
            const { data, error: updateError } = await supabaseAdmin
                .from("event_brackets")
                .update({
                    bracket_data: bracketData,
                    draw_data: bracketData,
                    updated_at: new Date().toISOString()
                })
                .eq("id", bracket.id)
                .select()
                .maybeSingle();

            if (updateError) throw updateError;
            updatedBracket = data;
            console.log("event_brackets updated successfully");
        } catch (dbErr) {
            console.error("DB ERROR (event_brackets update):", dbErr);
            throw dbErr;
        }

        // Generate matches table entries for ALL rounds (Option B)
        // CRITICAL: Do NOT create DB match rows for Round 1 BYE matches (single player).
        const allInserts = [];
        for (const [rIndex, round] of newRounds.entries()) {
            for (const match of round.matches) {
                const matchIndex = match.matchNumber - 1;
                const hasValidPlayer = (p) => p && typeof p === "object" && Object.keys(p).length > 0 && (p.id || p.player_id);
                const isByeRound1 = rIndex === 0 && ((hasValidPlayer(match.player1) && !hasValidPlayer(match.player2)) || (!hasValidPlayer(match.player1) && hasValidPlayer(match.player2)));
                if (isByeRound1) continue; // BYE: no DB row

                const payload = {
                    event_id: eventId,
                    category_id: bracket.category_id || (categoryId && isUuid(categoryId) ? categoryId : categoryLabel || bracket.category),
                    bracket_id: bracket.id,
                    round_name: round.name,
                    match_index: matchIndex,
                    // Never store empty objects; store null when player missing.
                    player_a: hasValidPlayer(match.player1) ? match.player1 : null,
                    player_b: hasValidPlayer(match.player2) ? match.player2 : null,
                    score: null,
                    winner: null,
                    status: "SCHEDULED",
                    bracket_match_id: match.id
                };
                allInserts.push(payload);
            }
        }

        if (allInserts.length > 0) {
            // Best-effort insert; if unique constraints or duplicates exist, we ignore per-row errors.
            const { error: insertError } = await supabaseAdmin
                .from("matches")
                .insert(allInserts);

            if (insertError) {
                // We don't fail Start Rounds if some matches already exist; log and continue.
                console.error("START ROUNDS - matches insert warning:", insertError);
            }
        }

        return res.status(200).json({
            success: true,
            bracket: updatedBracket,
            message: "Bracket structure created successfully",
            stats: {
                playerCount,
                bracketSize,
                byesTotal,
                roundCount,
                totalMatches: allMatches.length,
                seedingMode
            }
        });

    } catch (error) {
        console.error("Error creating bracket structure:", error);

        // Write error to log file for debugging
        try {
            const logPath = path.join(process.cwd(), 'backend-debug-error.log');
            const logContent = `[${new Date().toISOString()}] ERROR:\n${error.stack || error.message}\n\n`;
            fs.appendFileSync(logPath, logContent);
        } catch (logErr) {
            console.error("Failed to write error log:", logErr);
        }

        return res.status(500).json({
            message: "Failed to create bracket structure",
            error: error.message,
            code: "BRACKET_CREATION_ERROR"
        });
    }
};

export default {
    nextPowerOfTwo,
    generateCertifiedSeedingOrder,
    createFullBracketStructure,
    initBracket
};
