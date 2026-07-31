import { supabaseAdmin } from "../config/supabaseClient.js";
import { validateBracketIntegrity } from "../middleware/bracketValidation.js";
import { createNotification } from "../services/notificationService.js";
import { uploadBase64 } from "../utils/uploadHelper.js";
import { invalidateMatchesCache } from "../utils/matchesCache.js";

// Simple UUID v4 validator (relaxed - checks standard 36-char UUID format)
const isUuid = (value) => {
    if (!value || typeof value !== "string") return false;
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        value.trim()
    );
};

// Backward-compat: legacy schema has round_name NOT NULL. Our v2 is per-category,
// so we store a stable value in round_name to satisfy the constraint.
const LEGACY_ROUND_NAME_MEDIA = "Draws";
const LEGACY_ROUND_NAME_BRACKET = "Bracket";

/** Helper to get seed source from bracketData */
const getSeedSource = (bracketData, roundName) => {
    const bd = bracketData || {};
    const global =
        (bd.playerRanks && typeof bd.playerRanks === "object" ? bd.playerRanks : null) ||
        (bd.player_ranks && typeof bd.player_ranks === "object" ? bd.player_ranks : null) ||
        {};
    
    let byRound = {};
    if (roundName && (bd.playerRanksByRound || bd.player_ranks_by_round)) {
        const map = bd.playerRanksByRound || bd.player_ranks_by_round;
        if (map[roundName]) {
            byRound = map[roundName];
        } else {
            const lower = String(roundName).trim().toLowerCase();
            const key = Object.keys(map).find(k => String(k).trim().toLowerCase() === lower);
            if (key) byRound = map[key];
        }
    }
    return { global, byRound };
};

/** Helper to get seed value for a player */
const getSeedValue = (playerId, bracketData, roundName) => {
    if (!playerId) return null;
    const seedSource = getSeedSource(bracketData, roundName);
    const k = String(playerId).trim();
    if (!k) return null;
    const v = seedSource.byRound?.[k] ?? seedSource.global?.[k];
    const n = typeof v === "string" ? parseInt(v, 10) : v;
    return Number.isFinite(n) && n > 0 ? n : null;
};

/** Helper to shuffle array (Fisher-Yates) */
const shuffle = (arr) => {
    const a = Array.isArray(arr) ? [...arr] : [];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};

/** Normalize round name for consistent matching (trim + lowercase). */
const normalizeRoundName = (s) => String(s ?? "").trim().toLowerCase();

/** Return true if bracket has structured knockout (feeder/winnerTo linkage). Adding matches would break index mapping. */
const isStructuredKnockout = (bracketData) => {
    const rounds = bracketData?.rounds || [];
    if (rounds.length <= 1) return false;
    const firstRound = rounds[0];
    const firstMatch = firstRound?.matches?.[0];
    return !!(firstMatch && (firstMatch.winnerTo != null || firstMatch.feederMatch1 != null));
};

const inferRoundLabelFromMatchCount = (matchCount, fallbackIndex, roundIndex, totalRounds) => {
    // Calculate number of competitors in this round (each match = 2 competitors)
    const numCompetitors = matchCount * 2;
    const roundsRemaining = totalRounds - roundIndex;  // Including current round
    
    // CRITICAL: Reserve standard tournament names ONLY for final rounds
    // This ensures unique names and prevents confusing misnaming of early rounds
    
    // Last round (1 remaining) = Final
    if (roundsRemaining === 1) return "Final";
    
    // Second-to-last (2 remaining) = Semifinal
    if (roundsRemaining === 2) return "Semifinal";
    
    // Third-to-last (4 remaining) = Quarterfinal
    if (roundsRemaining === 3) return "Quarterfinal";
    
    // For all other rounds, use "Round of X" format
    // This applies to: all earlier rounds (Round of 64, Round of 32, Round of 16, etc.)
    // Examples: "Round of 64", "Round of 32", "Round of 16"
    return `Round of ${numCompetitors}`;
};

// Helper to create empty match structure for bracket visualization
// NOTE: score: null is for structure only - authoritative scores are in matches table
const makeEmptyMatch = (idOverride) => ({
    id: idOverride || `match-${Date.now()}-${Math.random()}`,
    player1: null,
    player2: null,
    winner: null,
    score: null // Structure only - not authoritative
});

// Compute next power of two >= n (used for full bracket sizing)
const nextPowerOfTwo = (n) => {
    if (!n || n <= 1) return 1;
    let p = 1;
    while (p < n) p <<= 1;
    return p;
};

/**
 * Generate certified professional seeding order (slot order).
 * Returns the SEED NUMBER for each slot (index 0 = Slot 0, index 1 = Slot 1...).
 * MUST be IDENTICAL to the frontend generateCertifiedSeedingOrder in BracketBuilderTab.tsx.
 *
 * Rules: Seed 1 always Slot 0; Seed 2 always last slot; Seeds 3/4 symmetric certified positions.
 * For 16-draw: [1,16,8,9,4,13,5,12,3,14,6,11,7,10,15,2]
 * For  8-draw: [1,8,4,5,3,6,7,2]
 */
const generateCertifiedSeedingOrder = (n) => {
    if (n === 1) return [1];
    if (n === 2) return [1, 2];
    if (n === 4) return [1, 4, 3, 2];
    if (n === 8) return [1, 8, 4, 5, 3, 6, 7, 2];
    if (n === 16) return [1, 16, 8, 9, 5, 12, 13, 4, 3, 14, 6, 11, 7, 10, 15, 2];
    // Recursive expansion for larger sizes (32, 64, ...)
    const prev = generateCertifiedSeedingOrder(n / 2);
    const result = [];
    for (const seed of prev) {
        result.push(seed);
        result.push(n + 1 - seed);
    }
    // Seed 2 must always be in last slot
    const idx2 = result.indexOf(2);
    if (idx2 !== -1 && idx2 !== result.length - 1) {
        result[idx2] = result[result.length - 1];
        result[result.length - 1] = 2;
    }
    return result;
};

/** BYE must NEVER propagate. Return true if player is a fake BYE object (e.g. { name: "BYE" }). */
const isFakeByePlayer = (p) => {
    if (!p) return true;
    if (typeof p === "string") return String(p).trim().toLowerCase() === "bye";
    if (typeof p === "object") {
        const name = (p.name || "").toString().trim().toUpperCase();
        const id = (p.id ?? p.player_id ?? p.playerId ?? "").toString().trim().toLowerCase();
        return name === "BYE" || id === "bye";
    }
    return false;
};

/** Check if a player is real (not null, not fake BYE, has valid ID) */
const hasRealPlayer = (p) => p && !isFakeByePlayer(p) && (p.id || p.player_id);

/** Helper to get seed source from bracketData */
// const getSeedSource = (bracketData, roundName) => {
//     const bd = bracketData || {};
//     const global =
//         (bd.playerRanks && typeof bd.playerRanks === "object" ? bd.playerRanks : null) ||
//         (bd.player_ranks && typeof bd.player_ranks === "object" ? bd.player_ranks : null) ||
//         {};
//     const byRound =
//         (roundName && bd.playerRanksByRound && bd.playerRanksByRound[roundName]) ||
//         (roundName && bd.player_ranks_by_round && bd.player_ranks_by_round[roundName]) ||
//         {};
//     return { global, byRound };
// };

// /** Helper to get seed value for a player */
// const getSeedValue = (playerId, bracketData, roundName) => {
//     if (!playerId) return null;
//     const seedSource = getSeedSource(bracketData, roundName);
//     const k = String(playerId).trim();
//     if (!k) return null;
//     const v = seedSource.byRound?.[k] ?? seedSource.global?.[k];
//     const n = typeof v === "string" ? parseInt(v, 10) : v;
//     return Number.isFinite(n) && n > 0 ? n : null;
// };

/** Check if player is seeded (has a rank value) */
const isSeededLocal = (player, bracketData, roundName) => {
    if (!player) return false;
    const playerId = player.id || player.player_id;
    return getSeedValue(playerId, bracketData, roundName) != null;
};

/** Check if a match is a ranked BYE (must be locked) */
const isRankedBye = (match, bracketData, firstRoundName) => {
    if (!match || !bracketData || !firstRoundName) return false;

    const hasRealPlayer = (p) => p && !isFakeByePlayer(p) && (p.id || p.player_id);
    const p1 = hasRealPlayer(match.player1) ? match.player1 : null;
    const p2 = hasRealPlayer(match.player2) ? match.player2 : null;

    // Must be a BYE (one player, one empty)
    const isBye = (p1 && !p2) || (!p1 && p2);
    if (!isBye) return false;

    // Get seed source
    const seedSource = (() => {
        const bd = bracketData || {};
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

    const getSeedValue = (pid) => {
        if (!pid) return null;
        const k = String(pid).trim();
        if (!k) return null;
        const v = seedSource.byRound?.[k] ?? seedSource.global?.[k];
        const n = typeof v === "string" ? parseInt(v, 10) : v;
        return Number.isFinite(n) && n > 0 ? n : null;
    };

    const existingPlayerId = p1 ? (p1.id || p1.player_id || p1.playerId) : (p2 ? (p2.id || p2.player_id || p2.playerId) : null);
    return existingPlayerId && getSeedValue(existingPlayerId) != null;
};

/**
 * Bracket Data Structure:
 * {
 *   rounds: [
 *     {
 *       name: "Round of 32",
 *       matches: [
 *         {
 *           id: "match-1",
 *           player1: { id: "user-id", name: "Player Name", seed?: number },
 *           player2: { id: "user-id", name: "Player Name", seed?: number },
 *           winner?: "player1" | "player2",
 *           score?: { player1: 21, player2: 18 },
 *           scheduledAt?: "2026-01-29T12:20:00Z"
 *         }
 *       ]
 *     }
 *   ],
 *   players: [
 *     { id: "user-id", name: "Player Name", seed: 1, eliminated: false }
 *   ]
 * }
 */

/**
 * Get draw/bracket for a specific category
 * GET /api/admin/events/:id/categories/:categoryId/draw
 */
export const getCategoryDraw = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const categoryLabel = req.query.categoryLabel || req.query.category;

        if (!eventId) return res.status(400).json({ message: "Event ID required" });

        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId);

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else if (categoryId && !isUuid(categoryId)) {
            // Synthetic IDs MUST take precedence over categoryLabel to avoid polluting base categories
            query = query.eq("category", categoryId);
        } else if (categoryLabel) {
            // Try exact match last
            query = query.eq("category", categoryLabel);
        } else {
            return res.status(400).json({ message: "Category ID or label required" });
        }

        let { data, error } = await query.order("created_at", { ascending: true });

        if (error) throw error;

        // Group by mode - prioritize BRACKET over MEDIA if both exist
        const mediaDraw = data.find(b => b.mode === 'MEDIA');
        const bracketDraw = data.find(b => b.mode === 'BRACKET');
        // LEAGUE_PLACEHOLDER is created by generateLeagueMatches
        const leaguePlaceholderRow = data.find(b => b.mode === 'LEAGUE_PLACEHOLDER' || b.mode === null || !b.mode);

        // Determine mode: BRACKET takes priority if it exists
        // Only return MEDIA mode if the mediaDraw actually has media files (media_urls or pdf_url)
        const hasActualMedia = mediaDraw && ((mediaDraw.media_urls && mediaDraw.media_urls.length > 0) || mediaDraw.pdf_url);
        const mode = bracketDraw ? 'BRACKET' : (hasActualMedia ? 'MEDIA' : null);

        // Top-level published: true if ANY row for this category is published
        // NOTE: mediaDraw.published is checked regardless of hasActualMedia because
        // Pool/League publish creates MEDIA rows WITHOUT actual media files.
        const isAnyPublished = Boolean(
            (bracketDraw && bracketDraw.published) ||
            (mediaDraw && mediaDraw.published) ||
            (leaguePlaceholderRow && leaguePlaceholderRow.published)
        );

        res.json({
            success: true,
            draw: {
                categoryId: categoryId || null,
                categoryLabel: categoryLabel || data[0]?.category,
                mode: mode,
                // Top-level published flag covers ALL modes (BRACKET, MEDIA, LEAGUE_SCOREBOARD)
                published: isAnyPublished,
                media: mediaDraw && hasActualMedia ? {
                    id: mediaDraw.id,
                    urls: mediaDraw.media_urls || [],
                    pdfUrl: mediaDraw.pdf_url,
                    published: mediaDraw.published
                } : null,
                bracket: bracketDraw ? {
                    id: bracketDraw.id,
                    roundStructure: bracketDraw.round_structure || [],
                    bracketData: bracketDraw.bracket_data || {},
                    published: bracketDraw.published
                } : null
            }
        });
    } catch (err) {
        console.error("GET CATEGORY DRAW ERROR:", err);
        res.status(500).json({ message: "Failed to fetch category draw", error: err.message });
    }
};

/**
 * Get a lightweight draw summary for EVERY category of an event in one request.
 * GET /api/admin/events/:id/draws
 *
 * The Draws tab used to fire one getCategoryDraw per category on open — N round
 * trips just to render the mode badge and decide which categories to list. This
 * answers all of them from a single query and deliberately omits `bracket_data`:
 * only `createdFrom` / `sourceRound` (the two fields the tab reads to detect
 * pool/league-converted brackets) are kept. The full bracket is still loaded by
 * getCategoryDraw when a category is actually selected.
 */
export const getEventDrawsSummary = async (req, res) => {
    try {
        const { id: eventId } = req.params;
        if (!eventId) return res.status(400).json({ message: "Event ID required" });

        // bracket_data is read but never returned: the flags below are derived from
        // it here so the response stays small, while `hasBracket` keeps the exact
        // semantics its callers relied on when they parsed the full draw themselves.
        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .select("id, category, category_id, mode, published, media_urls, pdf_url, bracket_data")
            .eq("event_id", eventId)
            .order("created_at", { ascending: true });

        if (error) throw error;

        // Group rows into categories exactly the way getCategoryDraw looks them up:
        // by category_id when the row carries one, by the stored label otherwise.
        // (Some legacy rows store the UUID itself in `category`, so a UUID-keyed
        // category can own both a "<uuid>" row and a human-labelled one.)
        const groups = new Map();
        for (const row of data || []) {
            const key = row.category_id ? `id:${row.category_id}` : `label:${row.category || ""}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(row);
        }

        const draws = [];
        for (const rows of groups.values()) {
            const mediaDraw = rows.find(b => b.mode === "MEDIA");
            const bracketDraw = rows.find(b => b.mode === "BRACKET");
            const leaguePlaceholderRow = rows.find(b => b.mode === "LEAGUE_PLACEHOLDER" || !b.mode);
            const hasActualMedia = mediaDraw && ((mediaDraw.media_urls && mediaDraw.media_urls.length > 0) || mediaDraw.pdf_url);
            const bd = bracketDraw?.bracket_data || null;

            // Prefer a human-readable label over a row that stored the raw UUID.
            // Prefer a human-readable label over a row that stored the raw UUID.
            const labelRow = rows.find(r => r.category && !isUuid(r.category)) || rows[0];
            const catStr = labelRow?.category || "";
            // Detect synthetic IDs (e.g., "1785400000042" or "1785400000042_R2")
            const isSyntheticId = catStr && /^\d+/.test(catStr) && !catStr.includes(" ");

            draws.push({
                categoryId: rows.find(r => r.category_id)?.category_id || (isSyntheticId ? catStr : null),
                categoryLabel: isSyntheticId ? null : catStr,
                mode: bracketDraw ? "BRACKET" : (hasActualMedia ? "MEDIA" : null),
                published: Boolean(
                    (bracketDraw && bracketDraw.published) ||
                    (mediaDraw && mediaDraw.published) ||
                    (leaguePlaceholderRow && leaguePlaceholderRow.published)
                ),
                media: mediaDraw && hasActualMedia ? {
                    id: mediaDraw.id,
                    urls: mediaDraw.media_urls || [],
                    pdfUrl: mediaDraw.pdf_url,
                    published: mediaDraw.published
                } : null,
                bracket: bracketDraw ? {
                    id: bracketDraw.id,
                    published: bracketDraw.published,
                    // Same test EventDetail used to run on the full draw: a bracket
                    // "exists" if it has rounds OR carries a players/playerPool array.
                    hasBracket: (() => {
                        const bd = bracketDraw.bracket_data || {};
                        const rounds = Array.isArray(bd.rounds) ? bd.rounds : [];
                        return rounds.length > 0 || Array.isArray(bd.players) || Array.isArray(bd.playerPool);
                    })(),
                    // Origin markers only — NOT the rounds/players payload.
                    bracketData: {
                        createdFrom: bd?.createdFrom ?? bd?.created_from ?? null,
                        sourceRound: bd?.sourceRound ?? bd?.source_round ?? null
                    }
                } : null
            });
        }

        res.json({ success: true, draws });
    } catch (err) {
        console.error("GET EVENT DRAWS SUMMARY ERROR:", err);
        res.status(500).json({ message: "Failed to fetch event draws", error: err.message });
    }
};

/**
 * Validate bracket integrity (for Semifinal safety / admin tools)
 * GET /api/admin/events/:id/categories/:categoryId/draw/validate
 * Query: categoryLabel (if no categoryId)
 */
export const validateBracketDraw = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const categoryLabel = req.query.categoryLabel || req.query.category;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and category (ID or label) required" });
        }

        let query = supabaseAdmin
            .from("event_brackets")
            .select("id, bracket_data")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else if (categoryId && !isUuid(categoryId)) {
            query = query.eq("category", categoryId);
        } else {
            query = query.eq("category", categoryLabel);
        }

        const { data: list, error } = await query.limit(1);
        if (error) throw error;
        const row = Array.isArray(list) ? list[0] : list;
        if (!row || !row.bracket_data) {
            return res.status(404).json({ message: "Bracket not found", valid: false, errors: ["No bracket data"] });
        }

        const result = validateBracketIntegrity(row.bracket_data);
        return res.json({
            success: true,
            valid: result.valid,
            errors: result.errors
        });
    } catch (err) {
        console.error("Validate bracket error:", err);
        res.status(500).json({ success: false, valid: false, errors: [err.message] });
    }
};

/**
 * Initialize bracket mode for a category
 * POST /api/admin/events/:id/categories/:categoryId/bracket/init
 */
export const initBracket = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, roundStructure, bracketData: incomingBracketData, players: incomingPlayers, createdFrom } = req.body;

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
        } else if (categoryId && !isUuid(categoryId)) {
            checkQuery = checkQuery.eq("category", categoryId);
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

        // POOL BRACKET FIX: Preserve player list and metadata from frontend
        const bracketData = {
            rounds: [],
            players: (incomingPlayers && Array.isArray(incomingPlayers)) ? incomingPlayers : (incomingBracketData?.players || []),
            ...(incomingBracketData && typeof incomingBracketData === "object" ? incomingBracketData : {}),
            ...(createdFrom ? { createdFrom } : {}),
            // Store the frontend category ID for traceability (even if not a UUID)
            // This helps debug cross-category contamination issues
            ...(categoryId ? { sourceCategoryId: String(categoryId) } : {}),
        };

        // Also store body-level categoryId if params categoryId is not UUID
        // The body may also carry a categoryId (from useLeagueBracketGeneration),
        // which we record in bracket_data for cross-ref.
        if (req.body?.categoryId && !isUuid(categoryId)) {
            bracketData.sourceCategoryId = String(req.body.categoryId);
        }

        const insertData = {
            event_id: eventId,
            category: (categoryId && !isUuid(categoryId)) ? categoryId : categoryLabel,
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
 * Start Rounds - create full bracket structure (all rounds + matches) in one shot.
 * POST /api/admin/events/:id/categories/:categoryId/bracket/start
 *
 * Request body (shape negotiated with frontend):
 * {
 *   categoryLabel: "U-15 (Male) - Singles",
 *   seedingMode: "AUTO" | "MANUAL",
 *   rounds: [
 *     { name: "Round of 16", minSets: 1, maxSets: 3 },
 *     { name: "Quarterfinal", minSets: 3, maxSets: 5 },
 *     ...
 *   ]
 * }
 */
export const createFullBracketStructure = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, seedingMode = "AUTO", rounds: roundConfigs, playerIds } = req.body || {};

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        // Fetch existing bracket row (must be initialized first)
        let bracketQuery = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (categoryId && isUuid(categoryId)) {
            bracketQuery = bracketQuery.eq("category_id", categoryId);
        } else if (categoryLabel) {
            bracketQuery = bracketQuery.eq("category", categoryLabel);
        }

        const { data: brackets, error: fetchError } = await bracketQuery;
        if (fetchError) throw fetchError;
        if (!brackets || brackets.length === 0) {
            return res.status(404).json({ message: "Bracket not found. Initialize bracket first." });
        }

        const bracket = brackets[0];
        if (bracket.published === true) {
            return res.status(400).json({
                message: "Cannot modify a published bracket. Unpublish first.",
                code: "BRACKET_PUBLISHED"
            });
        }

        // SAFEGUARD: Check if matches already exist for this bracket to prevent duplicates
        // Query the matches table directly to see actual state
        const { data: existingMatches, error: matchCheckError } = await supabaseAdmin
            .from("matches")
            .select("id, round_name")
            .eq("bracket_id", bracket.id)
            .limit(1);
        
        if (matchCheckError && matchCheckError.code !== 'PGRST116') {
            console.warn("Warning checking existing matches:", matchCheckError);
        }
        
        if (existingMatches && existingMatches.length > 0) {
            return res.status(400).json({
                message: "This bracket already has rounds created. Please delete the bracket and create a new one to change the structure.",
                code: "ROUNDS_EXIST"
            });
        }

        // POOL BRACKET FIX: If playerIds are provided (pool brackets), use ONLY those players
        // Otherwise fetch verified registrations for this event + category (to know player pool size)
        let registrations = [];
        
        if (playerIds && Array.isArray(playerIds) && playerIds.length > 0) {
            // Pool bracket: use only the specified playerIds
            let registrationsQuery = supabaseAdmin
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
                .eq("status", "verified");

            const { data: allRegs, error: regError } = await registrationsQuery;
            if (regError) throw regError;

            // Filter to ONLY the specified playerIds
            // playerIds from frontend are pool team/player codes like 'REG-FB-GoaGla-c8e0'
            // These don't match registration UUIDs, so we need a fallback strategy
            // First try: Exact match on IDs
            let matchedRegs = (allRegs || []).filter(reg => {
                const registrationId = String(reg.id || '');
                const userId = String((Array.isArray(reg.users) ? reg.users[0]?.id : reg.users?.id) || reg.player_id || '');
                const teamId = String(reg.team_id || '');
                const playerIdStrings = playerIds.map(pid => String(pid || ''));
                
                return playerIdStrings.some(pid => 
                    pid === registrationId || 
                    pid === userId || 
                    pid === teamId
                );
            });
            
            // Fallback: If IDs don't match, try matching by team name fragments
            // This handles cases where frontend sends pool team codes instead of registration UUIDs
            if (matchedRegs.length === 0 && playerIds.length > 0) {
                matchedRegs = (allRegs || []).filter(reg => {
                    const teamName = (Array.isArray(reg.player_teams) ? reg.player_teams[0]?.team_name : reg.player_teams?.team_name) || '';
                    
                    return playerIds.some(pid => {
                        const pidStr = String(pid || '').toLowerCase();
                        // Extract team name indicators from pool codes like 'REG-FB-GoaGla-c8e0'
                        const parts = pidStr.split('-');
                        const indicator = parts.slice(2, -1).join('-').toLowerCase(); // 'GoaGla' from 'REG-FB-GoaGla-c8e0'
                        
                        // Extract individual words from team name
                        const teamWords = teamName.toLowerCase().split(/\s+/);
                        
                        // Check various matching strategies
                        // 1. Exact word match: 'Mumbai' matches 'Mumbai Strikers'
                        if (teamWords.some(w => w === indicator)) {
                            return true;
                        }
                        
                        // 2. Prefix match: 'Bangal' matches any word starting with 'Bangal'
                        if (teamWords.some(w => w.startsWith(indicator))) {
                            return true;
                        }
                        
                        // 3. Reverse - indicator contains team word: 'GoaGla' matches 'Goa' (first 3 chars)
                        if (teamWords.some(w => indicator.startsWith(w.substring(0, 3)))) {
                            return true;
                        }
                        
                        // 4. Combined abbreviation: join first N chars of each word
                        // 'GoaGla' should match 'Goa Gladiators'
                        const abbrev = teamWords.map(w => w.substring(0, 3)).join('').substring(0, 6);
                        if (abbrev.startsWith(indicator.substring(0, 4))) {
                            return true;
                        }
                        
                        return false;
                    });
                });
                
            }
            
            registrations = matchedRegs;
        } else {
            // Normal bracket: fetch all verified registrations for this event + category
            let registrationsQuery = supabaseAdmin
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
                .eq("status", "verified");

            const { data: regData, error: regError } = await registrationsQuery;
            if (regError) throw regError;
            registrations = regData || [];
        }

        // Filter registrations matching this category (reuse existing robust matching logic)
        // For pool brackets, we already filtered by playerIds, so skip category filtering
        const registrationsForCategory = (() => {
            if (!registrations || registrations.length === 0) return [];
            
            // If specific playerIds were provided (pool bracket), don't filter by category again
            if (playerIds && Array.isArray(playerIds) && playerIds.length > 0) {
                return registrations; // Already filtered to these playerIds
            }
            
            const label = categoryLabel || bracket.category || "";
            const parts = label.split(" - ");
            const drawCatName = parts[0] || "";

            const matchesCategory = (reg) => {
                const regCats = Array.isArray(reg.categories) ? reg.categories : (reg.category ? [reg.category] : []);

                return regCats.some((c) => {
                    // Primary: category id exact match (if available)
                    if (categoryId && isUuid(categoryId) && typeof c === "object" && c.id) {
                        if (String(c.id) === String(categoryId)) return true;
                    }

                    const regCatName = (typeof c === "object" ? (c.name || c.category) : String(c || "")).trim();
                    const regGender = (typeof c === "object" ? c.gender : null) || reg.gender;
                    const regMatchType = typeof c === "object" ? (c.match_type || c.matchType) : null;

                    const nDrawName = drawCatName.toLowerCase().trim();
                    const nRegName = regCatName.toLowerCase().trim();
                    const nameMatch =
                        nDrawName === nRegName ||
                        nDrawName.startsWith(nRegName) ||
                        nDrawName.includes(nRegName) ||
                        nRegName.includes(nDrawName);
                    if (!nameMatch) return false;

                    const nameGenderMatch = drawCatName.match(/\((Male|Female|Mixed)\)/i);
                    const nameGender = nameGenderMatch ? nameGenderMatch[1] : null;
                    const explicitDrawGender = nameGender || parts[1];
                    const isDrawMixed =
                        (explicitDrawGender && explicitDrawGender.toLowerCase() === "mixed") ||
                        nDrawName.includes("mixed");

                    if (!isDrawMixed && explicitDrawGender && explicitDrawGender !== "Open") {
                        const pGender = (regGender || "").toLowerCase();
                        const dGender = String(explicitDrawGender || "").toLowerCase();
                        if (pGender && !pGender.includes("mixed") && pGender !== dGender) return false;
                    }

                    const drawMatchType = parts[2];
                    if (drawMatchType && regMatchType) {
                        if (drawMatchType.toLowerCase() !== String(regMatchType).toLowerCase()) return false;
                    }
                    return true;
                });
            };

            return registrations.filter(matchesCategory);
        })();

        // Extract players (teams or individuals)
        const players = [];
        const seen = new Set();
        for (const reg of registrationsForCategory) {
            if (reg.team_id && reg.player_teams) {
                const team = Array.isArray(reg.player_teams) ? reg.player_teams[0] : reg.player_teams;
                if (team && team.id && !seen.has(String(team.id))) {
                    seen.add(String(team.id));
                    players.push({
                        id: team.id,
                        name: team.team_name || team.captain_name || "Team",
                        type: "team"
                    });
                }
            } else if (reg.player_id && reg.users) {
                const user = Array.isArray(reg.users) ? reg.users[0] : reg.users;
                if (user && user.id && !seen.has(String(user.id))) {
                    seen.add(String(user.id));
                    const playerName =
                        user.name ||
                        `${user.first_name || ""} ${user.last_name || ""}`.trim() ||
                        "Player";
                    players.push({
                        id: user.id,
                        name: playerName,
                        player_id: user.player_id,
                        type: "player"
                    });
                }
            }
        }

        // POOL/LEAGUE BRACKET FIX: When playerIds are explicitly provided, use playerIds.length
        // as the authoritative player count for bracket sizing. The registration matching may
        // fail or return wrong counts (e.g., ID format mismatch), but the frontend already
        // knows exactly how many promoted players there are. This ensures 8 promoted players
        // always produce a 3-round bracket (QF/SF/Final), not a 6-round "Round of 64".
        const playerCount = (playerIds && Array.isArray(playerIds) && playerIds.length >= 2)
            ? playerIds.length
            : players.length;
        
        console.log(`[START ROUNDS] DIAGNOSTIC: playerIds=${playerIds?.length || 0}, matchedRegistrations=${registrations.length}, registrationsForCategory=${registrationsForCategory.length}, extractedPlayers=${players.length}, effectivePlayerCount=${playerCount}`);
        
        if (playerCount < 2) {
            return res.status(400).json({
                message: "At least 2 players are required to start rounds for this category.",
                code: "INSUFFICIENT_PLAYERS"
            });
        }
        
        const bracketSize = nextPowerOfTwo(playerCount); // e.g. 13 -> 16
        const roundCount = Math.max(1, Math.log2(bracketSize));

        // console.log(`[START ROUNDS] bracketSize=${bracketSize}, roundCount=${roundCount}, playerCount=${playerCount}, bracketId=${bracket.id}`);
        // console.log(`[START ROUNDS] Bracket existing rounds in bracket_data:`, bracket.bracket_data?.rounds?.length || 0, 
        //     bracket.bracket_data?.rounds?.map(r => `${r.name}(${r.matches?.length || 0})`) || 'none');

        // Use provided round configs if present, otherwise infer simple names
        const effectiveRoundConfigs = [];
        for (let i = 0; i < roundCount; i++) {
            const cfg = (Array.isArray(roundConfigs) && roundConfigs[i]) || {};
            const matchCount = bracketSize / Math.pow(2, i + 1);
            const fallbackName = inferRoundLabelFromMatchCount(matchCount, i, i, roundCount);
            effectiveRoundConfigs.push({
                // CRITICAL: Always use calculated fallbackName (not cfg.name) to ensure uniqueness
                // The frontend may send duplicate names like "Semifinal" for different rounds
                // This causes unique constraint violations in the database
                name: fallbackName,
                minSets: cfg.minSets || 1,
                maxSets: cfg.maxSets || 7
            });
        }
        
        // Build rounds + fully linked matches
        const bracketData = bracket.bracket_data || { rounds: [], players: [] };
        const newRounds = [];

        for (let r = 0; r < roundCount; r++) {
            const cfg = effectiveRoundConfigs[r];
            const matchCount = bracketSize / Math.pow(2, r + 1);
            //console.log(`[START ROUNDS]   Round ${r + 1} (${cfg.name}): ${matchCount} matches`);
            const round = {
                name: cfg.name,
                matches: [],
                setsConfig: {
                    minSets: cfg.minSets,
                    maxSets: cfg.maxSets
                },
                seedingMode: r === 0 ? (seedingMode === "MANUAL" ? "MANUAL" : "AUTO") : "AUTO"
            };
            
            for (let m = 1; m <= matchCount; m++) {
                const matchId = `R${r + 1}-M${m}`;
                const match = makeEmptyMatch(matchId);

                match.roundName = cfg.name;
                match.matchNumber = m;

                // Linkage: feeder matches (for rounds > 1)
                if (r === 0) {
                    match.feederMatch1 = null;
                    match.feederMatch2 = null;
                } else {
                    const prevRoundIndex = r - 1;
                    const feeder1Number = (m - 1) * 2 + 1;
                    const feeder2Number = (m - 1) * 2 + 2;
                    match.feederMatch1 = `R${prevRoundIndex + 1}-M${feeder1Number}`;
                    match.feederMatch2 = `R${prevRoundIndex + 1}-M${feeder2Number}`;
                }

                // Linkage: where does winner go?
                if (r === roundCount - 1) {
                    // Final round - champion, no downstream
                    match.winnerTo = null;
                    match.winnerToSlot = null;
                } else {
                    const nextRoundIndex = r + 1;
                    const nextMatchNumber = Math.ceil(m / 2);
                    match.winnerTo = `R${nextRoundIndex + 1}-M${nextMatchNumber}`;
                    match.winnerToSlot = m % 2 === 1 ? "player1" : "player2";
                }

                round.matches.push(match);
            }

            newRounds.push(round);
        }
        // Seed players into first round (AUTO) or leave empty (MANUAL)
        // CRITICAL: Only Round 1 placement + BYE assignment is handled here.
        // All feeder mapping / later rounds remain untouched.
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

        // STEP E: Propagate BYE winners from Round 1 to downstream rounds
        // Without this, Round 2 matches have null players for slots fed by BYE matches.
        // The frontend's handleFinalizeScores skips BYE matches (no scores to enter),
        // so these winners must already be in bracket_data when matches are generated.
        if (newRounds.length >= 2) {
            const firstRound = newRounds[0];
            for (const match of firstRound.matches) {
                if (!match.winner || !match.winnerTo || !match.winnerToSlot) continue;
                const hasP1 = match.player1 && typeof match.player1 === "object" && match.player1.id;
                const hasP2 = match.player2 && typeof match.player2 === "object" && match.player2.id;
                const isBye = (hasP1 && !hasP2) || (!hasP1 && hasP2);
                if (!isBye) continue;

                const winnerPlayer = match.winner === "player1" ? match.player1 : match.player2;
                if (!winnerPlayer) continue;

                const targetId = String(match.winnerTo).trim();
                const targetSlot = match.winnerToSlot;

                // Find target match across all downstream rounds
                for (const round of newRounds) {
                    for (const m of round.matches) {
                        if (m && String(m.id).trim() === targetId) {
                            m[targetSlot] = winnerPlayer;
                            console.log(`[START ROUNDS] BYE winner propagated: ${match.id} → ${targetId}.${targetSlot}`);
                        }
                    }
                }
            }
        }

        // FIRST: Delete all existing matches for this bracket BEFORE updating bracket_data
        // This prevents constraint violations when inserting new matches
        const { error: deleteError, count: deleteCount } = await supabaseAdmin
            .from("matches")
            .delete()
            .eq("bracket_id", bracket.id);
        
        //console.log(`[START ROUNDS] Deleted ${deleteCount || 0} existing matches for bracket ${bracket.id}`);
        
        if (deleteError && deleteError.code !== 'PGRST116') {  // PGRST116 = no rows deleted (ok)
            console.warn("Warning: Failed to clean up existing matches:", deleteError);
            // Continue anyway - we'll handle constraint errors during insert
        }

        // SECOND: Prepare bracket_data with new rounds (keep any existing players metadata)
        bracketData.rounds = newRounds;
        // IMPORTANT: Preserve players array (populated by initBracket from frontend)
        // Don't overwrite it - just keep it as-is
        if (!bracketData.players || !Array.isArray(bracketData.players)) {
            bracketData.players = players.map(p => ({
                id: p.id,
                name: p.name,
                type: p.type
            }));
        }
        
        // THIRD: Update bracket record with new rounds structure
        const { data: updatedBracket, error: updateError } = await supabaseAdmin
            .from("event_brackets")
            .update({
                round_name: bracket.round_name || LEGACY_ROUND_NAME_BRACKET,
                draw_type: "bracket",
                draw_data: bracketData,
                bracket_data: bracketData,
                round_structure: newRounds.map((r) => ({
                    name: r.name,
                    slots: (r.matches?.length || 0) * 2
                })),
                updated_at: new Date().toISOString()
            })
            .eq("id", bracket.id)
            .select()
            .maybeSingle();

        if (updateError) throw updateError;
        
        // Generate matches table entries for ALL rounds (Option B)
        // CRITICAL: Do NOT create DB match rows for Round 1 BYE matches (single player).
        const allInserts = [];
        //console.log(`[START ROUNDS] Building allInserts from ${newRounds.length} rounds:`);
        for (const [rIndex, round] of newRounds.entries()) {
            //console.log(`[START ROUNDS]   Round ${rIndex} (${round.name}): Processing ${round.matches?.length || 0} matches`);
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
            // FOURTH: Insert matches into database (all old matches deleted above)
            //console.log(`[START ROUNDS] Inserting ${allInserts.length} matches into database`);
            // console.log(`[START ROUNDS]   Match breakdown by round:`, allInserts.reduce((acc, m) => {
            //     acc[m.round_name] = (acc[m.round_name] || 0) + 1;
            //     return acc;
            // }, {}));

            const { error: insertError } = await supabaseAdmin
                .from("matches")
                .insert(allInserts);

            if (insertError) {
                console.error("START ROUNDS - CRITICAL: Match insertion failed after delete:", insertError);
                
                // If we get a duplicate key error here, it means something re-created the matches after we deleted them
                if (insertError.code === '23505') {  // Unique constraint violation
                    throw new Error("DUPLICATE_MATCH_ERROR: Matches were recreated after deletion. Possible race condition or pool bracket interference.");
                }
                
                // Re-throw other database errors
                throw insertError;
            }
        }

        await invalidateMatchesCache(eventId);
        return res.json({
            success: true,
            bracket: updatedBracket,
            message: "Full bracket structure created successfully",
            debug: {
                bracketSize,
                playerCount,
                roundCount,
                totalMatches: allInserts.length
            }
        });
    } catch (err) {
        console.error("CREATE FULL BRACKET STRUCTURE ERROR:", err);
        res.status(500).json({
            message: "Failed to create full bracket structure",
            error: err.message
        });
    }
};

/**
 * Upload media for a category (Image/PDF)
 * POST /api/admin/events/:id/categories/:categoryId/media
 */
export const uploadCategoryMedia = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, files, pdfFile } = req.body;
        const hasPdfField = Object.prototype.hasOwnProperty.call(req.body || {}, "pdfFile");

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        // Check if bracket exists
        let checkQuery = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId);

        if (categoryId && isUuid(categoryId)) {
            checkQuery = checkQuery.eq("category_id", categoryId);
        } else if (categoryId && !isUuid(categoryId)) {
            checkQuery = checkQuery.eq("category", categoryId);
        } else {
            checkQuery = checkQuery.eq("category", categoryLabel);
        }

        const { data: existing } = await checkQuery;

        if (existing && existing.length > 0) {
            const hasBracket = existing.some(b => b.mode === 'BRACKET');
            if (hasBracket) {
                return res.status(400).json({
                    message: "Category already has bracket. Cannot upload media. Delete bracket first.",
                    code: "MODE_CONFLICT"
                });
            }
        }

        // Upload files
        const uploadedMedia = [];

        if (files && Array.isArray(files)) {
            for (const file of files) {
                if (file.url && file.url.startsWith('data:')) {
                    const uploadedUrl = await uploadBase64(file.url, 'event-assets', 'draws');
                    uploadedMedia.push({
                        id: file.id || `img-${Date.now()}-${Math.random()}`,
                        url: uploadedUrl,
                        type: 'image',
                        description: file.description || ''
                    });
                } else if (file.url) {
                    uploadedMedia.push({
                        id: file.id || `img-${Date.now()}-${Math.random()}`,
                        url: file.url,
                        type: 'image',
                        description: file.description || ''
                    });
                }
            }
        }

        // pdfFile semantics:
        // - if pdfFile field is omitted => do not change existing pdf_url
        // - if pdfFile is null => clear pdf_url
        // - if pdfFile is a string => upload (data:) or store as url
        let pdfUrl = null;
        if (typeof pdfFile === "string" && pdfFile.length > 0) {
            if (pdfFile.startsWith("data:")) {
                pdfUrl = await uploadBase64(pdfFile, "event-assets", "draws");
            } else {
                pdfUrl = pdfFile;
            }
        } else if (pdfFile === null) {
            pdfUrl = null;
        }

        // Get existing media or create new
        const existingMedia = existing?.find(b => b.mode === 'MEDIA');

        if (existingMedia) {
            // Update existing
            const existingUrls = existingMedia.media_urls || [];
            const newUrls = [...existingUrls, ...uploadedMedia];
            const finalPdfUrl = hasPdfField ? pdfUrl : existingMedia.pdf_url;

            // Check if all media is deleted (no media URLs and no PDF)
            const hasNoMedia = (!newUrls || newUrls.length === 0) && !finalPdfUrl;

            const updatePayload = {
                updated_at: new Date().toISOString()
            };

            if (hasNoMedia) {
                // Clear mode and all media-related fields to allow bracket creation
                updatePayload.mode = null;
                updatePayload.media_urls = null;
                updatePayload.pdf_url = null;
                updatePayload.draw_data = null;
                updatePayload.draw_type = null;
            } else {
                // Update with media
                updatePayload.round_name = existingMedia.round_name || LEGACY_ROUND_NAME_MEDIA;
                updatePayload.draw_type = "image";
                updatePayload.draw_data = { images: newUrls.map((m) => ({ id: m.id, url: m.url, description: m.description || "" })) };
                updatePayload.media_urls = newUrls;
                updatePayload.pdf_url = finalPdfUrl;
            }

            const { data, error } = await supabaseAdmin
                .from("event_brackets")
                .update(updatePayload)
                .eq("id", existingMedia.id)
                .select()
                .maybeSingle();

            if (error) throw error;
            res.json({
                success: true,
                draw: data,
                modeCleared: hasNoMedia
            });
        } else {
            // Create new
            const insertData = {
                event_id: eventId,
                category: (categoryId && !isUuid(categoryId)) ? categoryId : categoryLabel,
                category_id: categoryId && isUuid(categoryId) ? categoryId : null,
                // legacy required column
                round_name: LEGACY_ROUND_NAME_MEDIA,
                // legacy compatibility
                draw_type: "image",
                draw_data: { images: uploadedMedia.map((m) => ({ id: m.id, url: m.url, description: m.description || "" })) },
                mode: 'MEDIA',
                media_urls: uploadedMedia,
                pdf_url: hasPdfField ? pdfUrl : null,
                published: false
            };

            const { data, error } = await supabaseAdmin
                .from("event_brackets")
                .insert(insertData)
                .select()
                .maybeSingle();

            if (error) throw error;
            res.json({ success: true, draw: data });
        }
    } catch (err) {
        console.error("UPLOAD MEDIA ERROR:", err);
        res.status(500).json({ message: "Failed to upload media", error: err.message });
    }
};

/**
 * Add/Update match in bracket
 * POST /api/admin/events/:id/categories/:categoryId/bracket/match
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
            winner: bodyWinner,
            matchIndex,
            deleteMatch,
            updatePlayerRanks,
            // Legacy flat rankings (pre per-round)
            playerRanks,
            enableRanking,
            // New per-round ranking maps
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
        } else if (categoryId && !isUuid(categoryId)) {
            query = query.eq("category", categoryId);
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
            // --- Per-round ranking (new structure) ---
            const incomingByRound =
                playerRanksByRound ||
                player_ranks_by_round ||
                null;

            if (incomingByRound && typeof incomingByRound === "object") {
                // Overwrite per-round map with payload
                bracketData.playerRanksByRound = incomingByRound;
                bracketData.player_ranks_by_round = incomingByRound;
            }

            const incomingToggleByRound =
                enableRankingByRound ||
                enable_ranking_by_round ||
                null;

            if (incomingToggleByRound && typeof incomingToggleByRound === "object") {
                bracketData.enableRankingByRound = incomingToggleByRound;
                bracketData.enable_ranking_by_round = incomingToggleByRound;
            }

            // --- Legacy flat fields (backwards compatibility) ---
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

        // HARDENED: Prevent Add Match on structured knockout rounds (breaks prevMatches[2*i] mapping)
        if (foundMatchIndex === -1 && isStructuredKnockout(bracketData)) {
            return res.status(400).json({
                message: "Cannot add matches to a knockout bracket. Match order is fixed; use the existing structure.",
                code: "KNOCKOUT_STRUCTURE_LOCKED"
            });
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

            // Delete the match from matches table if it exists
            // Match might be identified by matchId or by player combination + round
            try {
                const matchToDelete = round.matches[foundMatchIndex];
                const matchIdToDelete = matchToDelete?.id || matchId;

                // Try to find and delete the match from matches table
                // First, try by match ID if it's a UUID or stored reference
                if (matchIdToDelete) {
                    // Check if matchId looks like a UUID (from matches table)
                    if (isUuid(matchIdToDelete)) {
                        const { error: deleteMatchError } = await supabaseAdmin
                            .from('matches')
                            .delete()
                            .eq('id', matchIdToDelete);

                        if (deleteMatchError) {
                            console.error("Error deleting match from matches table:", deleteMatchError);
                        }
                    } else {
                        // Match ID is a bracket structure ID, try to find by round + players
                        // Fetch matches for this round and category
                        let matchQuery = supabaseAdmin
                            .from('matches')
                            .select('id, player_a, player_b, round_name')
                            .eq('event_id', eventId)
                            .eq('round_name', roundName);

                        if (categoryId && isUuid(categoryId)) {
                            matchQuery = matchQuery.eq('category_id', categoryId);
                        } else if (categoryLabel) {
                            // Try to match by categoryLabel if categoryId not available
                            matchQuery = matchQuery.eq('category_id', categoryLabel);
                        }

                        const { data: matchesInRound, error: fetchMatchesError } = await matchQuery;

                        if (!fetchMatchesError && matchesInRound && matchesInRound.length > 0) {
                            // Try to match by player IDs
                            const p1Id = matchToDelete?.player1?.id || matchToDelete?.player1;
                            const p2Id = matchToDelete?.player2?.id || matchToDelete?.player2;

                            const matchingMatch = matchesInRound.find(m => {
                                const ma = m.player_a?.id || m.player_a;
                                const mb = m.player_b?.id || m.player_b;
                                return (ma === p1Id && mb === p2Id) || (ma === p2Id && mb === p1Id);
                            });

                            if (matchingMatch) {
                                const { error: deleteMatchError } = await supabaseAdmin
                                    .from('matches')
                                    .delete()
                                    .eq('id', matchingMatch.id);

                                if (deleteMatchError) {
                                    console.error("Error deleting match from matches table:", deleteMatchError);
                                }
                            }
                        }
                    }
                }
            } catch (matchDeleteErr) {
                console.error("Error during match deletion:", matchDeleteErr);
                // Continue with bracket match deletion even if matches table deletion fails
            }

            round.matches.splice(foundMatchIndex, 1);
            bracketData.rounds[roundIndex] = round;

            const { data, error } = await supabaseAdmin
                .from("event_brackets")
                .update({
                    // legacy compatibility
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

            await invalidateMatchesCache(eventId);
            return res.json({
                success: true,
                bracket: data,
                message: "Match deleted successfully"
            });
        }

        if (foundMatchIndex === -1) {
            // Create new match structure in bracket_data
            // NOTE: score: null is for structure only - authoritative scores are in matches table
            const newMatch = {
                id: matchId || `match-${Date.now()}-${Math.random()}`,
                player1: (player1 && !isFakeByePlayer(player1)) ? player1 : null,
                player2: (player2 && !isFakeByePlayer(player2)) ? player2 : null,
                winner: null,
                score: null // Structure only - not authoritative
            };
            round.matches.push(newMatch);
        } else {
            // Update existing match
            const match = round.matches[foundMatchIndex];
            const firstRoundName = bracketData.rounds?.[0]?.name;

            // Block modification of ranked BYEs — but ALLOW filling the empty BYE side
            if (isRankedBye(match, bracketData, firstRoundName)) {
                const hasRealPlayer = (p) => p && !isFakeByePlayer(p) && (p.id || p.player_id);
                const p1Exists = hasRealPlayer(match.player1);
                const p2Exists = hasRealPlayer(match.player2);

                // Determine which side is being updated
                const isFillingEmptySide =
                    (player1 !== undefined && !p1Exists && p2Exists) ||  // Filling empty P1 when P2 exists
                    (player2 !== undefined && !p2Exists && p1Exists);    // Filling empty P2 when P1 exists

                // Allow fill — block any other modification (replacing ranked player, clearing, etc.)
                if (!isFillingEmptySide) {
                    return res.status(403).json({
                        message: "Cannot modify ranked BYE. Ranked BYEs are locked.",
                        code: "RANKED_BYE_LOCKED"
                    });
                }
            }

            // BYE = player2 null, never store fake { name: "BYE" } as player
            const safeP1 = (player1 && !isFakeByePlayer(player1)) ? player1 : null;
            const safeP2 = (player2 && !isFakeByePlayer(player2)) ? player2 : null;

            // Validate: Player cannot appear twice in same round
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

            if (player2) {
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

            // If a player is cleared/changed, clear winner to avoid stale results.
            // Also honour explicit bodyWinner===null from frontend (race-condition guard:
            // the frontend detected a BYE→non-BYE transition even if bracket_data on the
            // server hasn't recorded the BYE winner yet due to a concurrent recordResult).
            // NOTE: Scores are NOT stored in bracket_data - they belong in matches table only
            const shouldClearWinner = !!match.winner || (bodyWinner === null && 'winner' in req.body);
            if (shouldClearWinner) {
                match.winner = null;

                // CRITICAL: Also clear the stale winner in the `matches` DB table.
                // When a BYE match (1 player) had its winner auto-set via recordResult,
                // the matches table got winner="A" + status="COMPLETED". When the second
                // player is placed (making it a non-BYE), we clear bracket_data.winner
                // above, but we must also reset the DB match row so that displayWinner
                // in BracketBuilder doesn't read a stale winner from dbMatch.
                const bracketMatchId = matchId || match.id;
                if (bracketMatchId) {
                    try {
                        await supabaseAdmin
                            .from("matches")
                            .update({
                                winner: null,
                                status: "SCHEDULED",
                                score: null,
                                updated_at: new Date().toISOString()
                            })
                            .eq("bracket_match_id", String(bracketMatchId).trim())
                            .eq("event_id", eventId);
                    } catch (clearErr) {
                        console.warn("[updateBracketMatch] Failed to clear stale winner in matches table:", clearErr.message);
                    }
                }
            }
        }

        // Sync player_a / player_b in the matches table so DB matches stay current
        // with whatever the admin placed in the bracket structure.
        const bracketMatchIdForSync = matchId || (round.matches[foundMatchIndex] && round.matches[foundMatchIndex].id);
        if (bracketMatchIdForSync && (player1 !== undefined || player2 !== undefined)) {
            try {
                const syncPayload = { updated_at: new Date().toISOString() };
                if (player1 !== undefined) syncPayload.player_a = player1 && !isFakeByePlayer(player1) ? player1 : null;
                if (player2 !== undefined) syncPayload.player_b = player2 && !isFakeByePlayer(player2) ? player2 : null;
                await supabaseAdmin
                    .from("matches")
                    .update(syncPayload)
                    .eq("bracket_match_id", String(bracketMatchIdForSync).trim())
                    .eq("event_id", eventId);
            } catch (syncErr) {
                console.warn("[updateBracketMatch] Failed to sync players in matches table:", syncErr.message);
            }
        }

        // Update bracket data
        bracketData.rounds[roundIndex] = round;

        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .update({
                // legacy compatibility
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

/**
 * Replace entire round's matches in one shot (bulk seed for 100+ players).
 * POST /api/admin/events/:id/categories/:categoryId/bracket/round/replace
 * Body: { roundName, matches: [{ id, player1?, player2?, winner?, score? }, ...] }
 */
export const replaceRoundMatches = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, roundName, matches: incomingMatches } = req.body;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }
        if (!roundName || !Array.isArray(incomingMatches)) {
            return res.status(400).json({ message: "roundName and matches array required" });
        }

        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else if (categoryId && !isUuid(categoryId)) {
            query = query.eq("category", categoryId);
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
        const roundNameNorm = normalizeRoundName(roundName);
        const roundIndex = bracketData.rounds.findIndex(r => normalizeRoundName(r?.name) === roundNameNorm);
        if (roundIndex === -1) {
            return res.status(400).json({ message: `Round "${roundName}" not found` });
        }

        const round = bracketData.rounds[roundIndex];
        // Build a lookup of existing matches by id so we can preserve linkage fields
        const existingMatchesMap = new Map();
        for (const em of (round.matches || [])) {
            if (em && em.id) existingMatchesMap.set(String(em.id).trim(), em);
        }
        const existingMatchIds = (round.matches || []).map(m => m && m.id);
        const newMatches = incomingMatches.map((m, idx) => {
            const id = m && (m.id || existingMatchIds[idx]) || `R1-M${idx + 1}`;
            const player1 = m && m.player1 && !isFakeByePlayer(m.player1) ? m.player1 : null;
            const player2 = m && m.player2 && !isFakeByePlayer(m.player2) ? m.player2 : null;

            // Preserve structural linkage fields from the existing bracket match.
            // These fields (winnerTo, winnerToSlot, feederMatch1/2, roundName, matchNumber)
            // are set during startRounds and must NOT be stripped when the frontend
            // sends a REPLACE_ROUND request (e.g. player swaps, manual seeding).
            const existing = existingMatchesMap.get(String(id).trim());

            return {
                id,
                player1: player1 || null,
                player2: player2 || null,
                winner: m && m.winner ? m.winner : null,
                score: m && m.score ? m.score : null,
                // Linkage fields — prefer incoming values if present, else keep existing
                winnerTo: (m && m.winnerTo) || (existing && existing.winnerTo) || null,
                winnerToSlot: (m && m.winnerToSlot) || (existing && existing.winnerToSlot) || null,
                feederMatch1: (m && m.feederMatch1) || (existing && existing.feederMatch1) || null,
                feederMatch2: (m && m.feederMatch2) || (existing && existing.feederMatch2) || null,
                roundName: (m && m.roundName) || (existing && existing.roundName) || null,
                matchNumber: (m && m.matchNumber != null) ? m.matchNumber : (existing && existing.matchNumber != null ? existing.matchNumber : null),
            };
        });

        bracketData.rounds[roundIndex] = { ...round, matches: newMatches };

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
            message: "Round updated successfully"
        });
    } catch (err) {
        console.error("REPLACE ROUND MATCHES ERROR:", err);
        res.status(500).json({ message: "Failed to replace round matches", error: err.message });
    }
};

/**
 * Set match result and advance winner
 * POST /api/admin/events/:id/categories/:categoryId/bracket/result
 */
export const setMatchResult = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, roundName, matchId, winner, score } = req.body;

        if (!eventId || !roundName || !matchId || !winner) {
            return res.status(400).json({ message: "Missing required fields" });
        }

        // Get bracket
        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else if (categoryId && !isUuid(categoryId)) {
            query = query.eq("category", categoryId);
        } else {
            query = query.eq("category", categoryLabel);
        }

        const { data: brackets, error: fetchError } = await query;

        if (fetchError) throw fetchError;
        if (!brackets || brackets.length === 0) {
            return res.status(404).json({ message: "Bracket not found" });
        }

        const bracket = brackets[0];
        const bracketData = bracket.bracket_data || { rounds: [], players: [] };

        // Find round and match (normalize round name for consistent matching)
        const roundNameNorm = normalizeRoundName(roundName);
        const roundIndex = bracketData.rounds.findIndex(r => normalizeRoundName(r?.name) === roundNameNorm);
        if (roundIndex === -1) {
            return res.status(400).json({ message: `Round "${roundName}" not found` });
        }

        const round = bracketData.rounds[roundIndex];
        const matchIdTrim = String(matchId || "").trim();
        const matchIndex = round.matches.findIndex(m => m && String(m.id).trim() === matchIdTrim);
        if (matchIndex === -1) {
            return res.status(400).json({ message: "Match not found" });
        }

        const match = round.matches[matchIndex];

        // Validate winner
        if (winner !== 'player1' && winner !== 'player2') {
            return res.status(400).json({ message: "Winner must be 'player1' or 'player2'" });
        }

        const winnerPlayer = match[winner];
        if (!winnerPlayer) {
            return res.status(400).json({ message: "Winner player not found in match" });
        }
        if (isFakeByePlayer(winnerPlayer)) {
            return res.status(400).json({ message: "Cannot set BYE as winner - BYE must not propagate" });
        }

        // Update match
        match.winner = winner;

        // Advance winner: use ONLY winnerTo/winnerToSlot when present (hardened propagation)
        if (roundIndex < bracketData.rounds.length - 1) {
            const nextRound = bracketData.rounds[roundIndex + 1];
            let targetId = match.winnerTo != null ? String(match.winnerTo).trim() : null;
            let targetSlot = match.winnerToSlot || null;
            if (!targetId || !targetSlot) {
                const nextMatchIndex = Math.floor(matchIndex / 2);
                targetSlot = (matchIndex % 2 === 0) ? "player1" : "player2";
                if (nextRound?.matches?.[nextMatchIndex]?.id) {
                    targetId = String(nextRound.matches[nextMatchIndex].id).trim();
                }
            }
            if (targetId && targetSlot && nextRound?.matches) {
                const nextMatch = nextRound.matches.find(m => m && String(m.id).trim() === targetId);
                if (nextMatch) {
                    nextMatch[targetSlot] = winnerPlayer;
                }
            }
        }

        bracketData.rounds[roundIndex] = round;

        // Update bracket
        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .update({
                // legacy compatibility
                round_name: bracket.round_name || LEGACY_ROUND_NAME_BRACKET,
                draw_type: "bracket",
                draw_data: bracketData,
                round_structure: bracket.round_structure || bracket.round_structure,
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
            message: "Match result saved and winner advanced"
        });
    } catch (err) {
        console.error("SET MATCH RESULT ERROR:", err);
        res.status(500).json({ message: "Failed to set match result", error: err.message });
    }
};

/**
 * Add a new round to a bracket (dynamic rounds)
 * POST /api/admin/events/:id/categories/:categoryId/bracket/round/add
 */
export const addBracketRound = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, autoSeed = true, roundName, setsConfig } = req.body;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else if (categoryId && !isUuid(categoryId)) {
            query = query.eq("category", categoryId);
        } else {
            query = query.eq("category", categoryLabel);
        }

        const { data: brackets, error: fetchError } = await query;
        if (fetchError) throw fetchError;
        if (!brackets || brackets.length === 0) {
            return res.status(404).json({ message: "Bracket not found. Initialize bracket first." });
        }

        const bracket = brackets[0];
        if (bracket.published === true) {
            return res.status(400).json({ message: "Cannot modify a published bracket. Unpublish first.", code: "BRACKET_PUBLISHED" });
        }

        const bracketData = bracket.bracket_data || { rounds: [], players: [] };
        const currentRounds = Array.isArray(bracketData.rounds) ? bracketData.rounds : [];

        // Helper: choose the effective name for the new round.
        // - If admin provided `roundName` from UI, prefer that.
        // - Otherwise fall back to inferred label based on match count (existing behavior).
        const getNextRoundName = (nextMatchCount, fallbackIndex) => {
            if (roundName && typeof roundName === "string" && roundName.trim()) {
                return roundName.trim();
            }
            return inferRoundLabelFromMatchCount(nextMatchCount, fallbackIndex);
        };

        // If no rounds exist, create first round with explicit/derived name
        if (currentRounds.length === 0) {
            const initialName = getNextRoundName(0, 0) || "Round 1";
            const firstRound = {
                name: initialName,
                matches: [],
                // Store sets configuration for this round
                setsConfig: setsConfig && typeof setsConfig === 'object' ? {
                    minSets: setsConfig.minSets || 1,
                    maxSets: setsConfig.maxSets || 7
                } : null
            };

            // If autoSeed is true, fetch registrations and seed players into matches
            if (autoSeed) {
                try {
                    // Fetch registrations for this event and category
                    let registrationsQuery = supabaseAdmin
                        .from('event_registrations')
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
                        .eq('event_id', eventId)
                        .eq('status', 'verified'); // Only verified registrations

                    const { data: registrations, error: regError } = await registrationsQuery;

                    if (!regError && registrations && registrations.length > 0) {
                        // Filter registrations by category - match frontend logic
                        const parts = categoryLabel ? categoryLabel.split(" - ") : [];
                        const drawCatName = parts[0] || "";

                        const categoryRegistrations = registrations.filter(reg => {
                            const regCats = Array.isArray(reg.categories) ? reg.categories : (reg.category ? [reg.category] : []);

                            return regCats.some(cat => {
                                // PRIMARY CHECK: ID Match
                                if (categoryId && isUuid(categoryId)) {
                                    const catId = typeof cat === 'object' ? (cat?.id || null) : cat;
                                    if (catId && String(catId) === String(categoryId)) {
                                        return true;
                                    }
                                }

                                // SECONDARY CHECK: Fuzzy String Match
                                const regCatNameRaw = typeof cat === "object" ? (cat?.name || cat?.category || null) : String(cat || "");
                                const regCatName = regCatNameRaw ? String(regCatNameRaw).trim() : "";
                                if (!regCatName) return false;

                                const regGender = (typeof cat === "object" ? (cat?.gender || null) : null) || reg.gender;
                                const regMatchType = typeof cat === "object" ? (cat?.match_type || cat?.matchType || null) : null;

                                const nDrawName = drawCatName.toLowerCase().trim();
                                const nRegName = regCatName.toLowerCase().trim();

                                const nameMatch = nDrawName === nRegName ||
                                    nDrawName.startsWith(nRegName) ||
                                    nDrawName.includes(nRegName) ||
                                    nRegName.includes(nDrawName);

                                if (!nameMatch) return false;

                                // Gender matching
                                const nameGenderMatch = drawCatName.match(/\((Male|Female|Mixed)\)/i);
                                const nameGender = nameGenderMatch ? nameGenderMatch[1] : null;
                                const explicitDrawGender = nameGender || (parts[1] || "");

                                const isDrawMixed = (explicitDrawGender && explicitDrawGender.toLowerCase() === "mixed") ||
                                    nDrawName.includes("mixed");

                                if (!isDrawMixed && explicitDrawGender && explicitDrawGender !== "Open") {
                                    const pGender = (regGender || "").toLowerCase();
                                    const dGender = String(explicitDrawGender || "").toLowerCase();
                                    if (pGender && !pGender.includes("mixed") && pGender !== dGender) return false;
                                }

                                // Match type matching
                                const drawMatchType = parts[2];
                                if (drawMatchType && regMatchType) {
                                    if (drawMatchType.toLowerCase() !== String(regMatchType).toLowerCase()) return false;
                                }

                                return true;
                            });
                        });

                        // Extract players from registrations - handle teams and individual players
                        const players = [];
                        const seenPlayerIds = new Set();

                        for (const reg of categoryRegistrations) {
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

                        // Calculate number of matches needed (ceil of players/2)
                        const matchCount = Math.max(1, Math.ceil(players.length / 2));

                        // Create matches and seed players
                        const matches = [];
                        for (let i = 0; i < matchCount; i++) {
                            const player1Index = i * 2;
                            const player2Index = player1Index + 1;

                            const match = {
                                id: `match-${Date.now()}-${i}`,
                                player1: player1Index < players.length ? players[player1Index] : null,
                                player2: player2Index < players.length ? players[player2Index] : null,
                                winner: null,
                                score: null
                            };

                            // Auto-mark BYE winners (single-player matches)
                            if (match.player1 && !match.player2) {
                                match.winner = "player1";
                            } else if (!match.player1 && match.player2) {
                                match.player1 = match.player2;
                                match.player2 = null;
                                match.winner = "player1";
                            }

                            matches.push(match);
                        }

                        firstRound.matches = matches;
                    }
                } catch (seedError) {
                    console.error("Failed to auto-seed first round:", seedError);
                    // Continue with empty matches if seeding fails
                }
            }

            currentRounds.push(firstRound);
        } else {
            const prevRound = currentRounds[currentRounds.length - 1];
            const prevMatches = Array.isArray(prevRound.matches) ? prevRound.matches : [];

            // Check if all matches have winners in bracket_data
            // Also check matches table for completed matches as fallback
            const allHaveWinnersInBracket = prevMatches.length > 0 && prevMatches.every((m) => m && m.winner && m[m.winner]);

            // If bracket_data doesn't have all winners, check matches table
            if (!allHaveWinnersInBracket && prevRound.name) {
                try {
                    // Fetch completed matches for the previous round from matches table
                    let completedMatchesQuery = supabaseAdmin
                        .from('matches')
                        .select('*')
                        .eq('event_id', eventId)
                        .eq('round_name', prevRound.name)
                        .eq('status', 'COMPLETED');

                    // Filter by categoryId if available (to avoid cross-category matches)
                    if (categoryId && isUuid(categoryId)) {
                        completedMatchesQuery = completedMatchesQuery.eq('category_id', categoryId);
                    } else if (categoryId) {
                        completedMatchesQuery = completedMatchesQuery.eq('category_id', categoryId);
                    }

                    const { data: completedMatches } = await completedMatchesQuery;

                    // Check if all non-BYE matches have winners in matches table
                    const nonByeMatches = prevMatches.filter(m => {
                        const hasPlayer1 = m.player1 && (m.player1.id || m.player1);
                        const hasPlayer2 = m.player2 && (m.player2.id || m.player2);
                        return hasPlayer1 && hasPlayer2; // Non-BYE matches have both players
                    });

                    if (completedMatches && completedMatches.length >= nonByeMatches.length) {
                        // All matches are completed in matches table, allow adding next round
                        // Winners will be synced from matches table during auto-seed
                    } else {
                        return res.status(400).json({
                            message: "Finish all match winners in the previous round before adding a new round.",
                            code: "PREV_ROUND_INCOMPLETE"
                        });
                    }
                } catch (err) {
                    // Fall back to bracket_data check if matches table check fails
                    if (!allHaveWinnersInBracket) {
                        return res.status(400).json({
                            message: "Finish all match winners in the previous round before adding a new round.",
                            code: "PREV_ROUND_INCOMPLETE"
                        });
                    }
                }
            } else if (!allHaveWinnersInBracket) {
                return res.status(400).json({
                    message: "Finish all match winners in the previous round before adding a new round.",
                    code: "PREV_ROUND_INCOMPLETE"
                });
            }

            // If previous round already produced a single champion, do not allow another round
            const winners = prevMatches
                .map((m) => (m && m.winner ? m[m.winner] : null))
                .filter(Boolean);
            if (winners.length === 1) {
                return res.status(400).json({
                    message: "Final round is already completed. Champion is decided.",
                    code: "CHAMPION_DECIDED"
                });
            }

            const nextMatchCount = Math.max(1, Math.ceil(prevMatches.length / 2));
            const nextName = getNextRoundName(nextMatchCount, currentRounds.length);

            // Round index for next round (1-based for match IDs: R2-M1, R2-M2, etc.)
            const nextRoundNum = currentRounds.length + 1;

            // If autoSeed is false, create a completely empty round (no matches yet).
            // Admin will add matches manually from the UI. This avoids showing
            // placeholder "TBD vs TBD" matches when the intent is a blank round.
            // Use stable match IDs (R2-M1, R2-M2, ...) for feeder linkage consistency.
            const nextRound = {
                name: nextName,
                matches: autoSeed ? Array.from({ length: nextMatchCount }, (_, idx) => {
                    const matchId = `R${nextRoundNum}-M${idx + 1}`;
                    const m = makeEmptyMatch(matchId);
                    m.roundName = nextName;
                    m.matchNumber = idx + 1;
                    // Add feeder linkage for winner propagation (matches finalizeRoundMatches logic)
                    const f1 = prevMatches[idx * 2];
                    const f2 = prevMatches[idx * 2 + 1];
                    m.feederMatch1 = f1?.id ? String(f1.id) : `R${nextRoundNum - 1}-M${idx * 2 + 1}`;
                    m.feederMatch2 = f2?.id ? String(f2.id) : `R${nextRoundNum - 1}-M${idx * 2 + 2}`;
                    return m;
                }) : []
            };

            if (autoSeed) {
                // CRITICAL: Populate next round using FEEDER LINKS only — never rank-based logic.
                // Winners flow strictly from bracket feeder structure (winnerTo/winnerToSlot).
                // Ranking applies ONLY to Round 1 placement; rounds 2+ are pure winner progression.
                const winnerByPrevMatchId = new Map(); // bracketMatchId -> winner player object

                // Build winner map from bracket_data first
                for (const m of prevMatches) {
                    const winnerPlayer = m && m.winner ? m[m.winner] : null;
                    if (winnerPlayer && m.id) {
                        winnerByPrevMatchId.set(String(m.id), winnerPlayer);
                    }
                }

                // If bracket_data doesn't have all winners, fetch from matches table
                if (winnerByPrevMatchId.size < prevMatches.length && prevRound.name) {
                    try {
                        let completedMatchesQuery = supabaseAdmin
                            .from('matches')
                            .select('*')
                            .eq('event_id', eventId)
                            .eq('round_name', prevRound.name)
                            .eq('status', 'COMPLETED');

                        if (categoryId && isUuid(categoryId)) {
                            completedMatchesQuery = completedMatchesQuery.eq('category_id', categoryId);
                        } else if (categoryId) {
                            completedMatchesQuery = completedMatchesQuery.eq('category_id', categoryId);
                        }

                        const { data: completedMatches } = await completedMatchesQuery;

                        if (completedMatches && completedMatches.length > 0) {
                            for (const bracketMatch of prevMatches) {
                                const bracketMatchId = bracketMatch?.id ? String(bracketMatch.id) : null;
                                if (!bracketMatchId) continue;

                                // Prefer bracket_match_id (reliable); fallback to match_index for legacy
                                const matchIndex = prevMatches.indexOf(bracketMatch);
                                const matchData = completedMatches.find(m => m.bracket_match_id && String(m.bracket_match_id) === bracketMatchId) ||
                                    completedMatches.find(m => typeof m.match_index === 'number' && m.match_index === matchIndex);

                                if (matchData && matchData.winner) {
                                    const winnerId = typeof matchData.winner === 'object'
                                        ? (matchData.winner.id || matchData.winner.player_id || matchData.winner)
                                        : matchData.winner;

                                    // Prefer authoritative players from matches table (player_a / player_b),
                                    // then fall back to bracket_data player1 / player2 if needed.
                                    const mP1 = matchData.player_a;
                                    const mP2 = matchData.player_b;
                                    const mP1Id = mP1 && (mP1.id || mP1.player_id || mP1);
                                    const mP2Id = mP2 && (mP2.id || mP2.player_id || mP2);

                                    let winnerPlayer = null;
                                    if (mP1Id && String(mP1Id) === String(winnerId)) {
                                        winnerPlayer = mP1;
                                    } else if (mP2Id && String(mP2Id) === String(winnerId)) {
                                        winnerPlayer = mP2;
                                    }

                                    if (!winnerPlayer) {
                                        const bracketPlayer1Id = bracketMatch.player1?.id || bracketMatch.player1;
                                        const bracketPlayer2Id = bracketMatch.player2?.id || bracketMatch.player2;

                                        if (bracketPlayer1Id && String(bracketPlayer1Id) === String(winnerId)) {
                                            winnerPlayer = bracketMatch.player1;
                                        } else if (bracketPlayer2Id && String(bracketPlayer2Id) === String(winnerId)) {
                                            winnerPlayer = bracketMatch.player2;
                                        } else if (matchData.winner && typeof matchData.winner === 'object') {
                                            winnerPlayer = matchData.winner;
                                        }
                                    }

                                    if (winnerPlayer && !isFakeByePlayer(winnerPlayer)) {
                                        winnerByPrevMatchId.set(bracketMatchId, winnerPlayer);
                                    } else {
                                        const bracketWinner = bracketMatch.winner ? bracketMatch[bracketMatch.winner] : null;
                                        if (bracketWinner && !isFakeByePlayer(bracketWinner)) winnerByPrevMatchId.set(bracketMatchId, bracketWinner);
                                    }
                                } else {
                                    const bracketWinner = bracketMatch.winner ? bracketMatch[bracketMatch.winner] : null;
                                    if (bracketWinner && !isFakeByePlayer(bracketWinner)) winnerByPrevMatchId.set(bracketMatchId, bracketWinner);
                                }
                            }
                        }
                    } catch (err) {
                        // If matches table fetch fails, bracket_data winners already in map
                    }
                }

                // Populate next round using FEEDER order only (prevMatches index order = bracket structure)
                // NO sort by rank; NO reordering; exact same as non-ranking mode
                for (let i = 0; i < prevMatches.length; i++) {
                    const prevMatch = prevMatches[i];
                    const winnerPlayer = prevMatch?.id ? winnerByPrevMatchId.get(String(prevMatch.id)) : null;
                    if (!winnerPlayer) continue;

                    const idx = Math.floor(i / 2);
                    const slot = i % 2 === 0 ? 'player1' : 'player2';
                    if (!nextRound.matches[idx]) nextRound.matches[idx] = makeEmptyMatch(`R${nextRoundNum}-M${idx + 1}`);
                    nextRound.matches[idx][slot] = winnerPlayer;
                }

                // BYE exists ONLY in Round 1. Round 2+ single-player slot = waiting for other feeder, NOT a BYE.
                // Only normalize slot (player2 -> player1) for structure; do NOT auto-set winner when one slot empty.
                for (const nm of nextRound.matches) {
                    if (!nm.player1 && nm.player2) {
                        nm.player1 = nm.player2;
                        nm.player2 = null;
                        // Do NOT set winner - other feeder may not have played yet
                    }
                    // When nm.player1 && !nm.player2: leave winner null (TBD). Never propagate "BYE" to Round 2+.
                }
            }

            // Ensure prev round matches have winnerTo/winnerToSlot for finalizeRoundMatches propagation
            if (autoSeed && nextRound.matches && nextRound.matches.length > 0) {
                for (let i = 0; i < prevMatches.length; i++) {
                    const prevMatch = prevMatches[i];
                    if (!prevMatch) continue;
                    const downstreamIdx = Math.floor(i / 2);
                    const downstreamMatch = nextRound.matches[downstreamIdx];
                    if (downstreamMatch?.id) {
                        prevMatch.winnerTo = String(downstreamMatch.id);
                        prevMatch.winnerToSlot = i % 2 === 0 ? 'player1' : 'player2';
                    }
                }
            }

            currentRounds.push(nextRound);
        }

        bracketData.rounds = currentRounds;

        const roundStructure = Array.isArray(bracket.round_structure) ? bracket.round_structure : [];
        const lastRound = currentRounds[currentRounds.length - 1];
        if (!roundStructure.find((r) => r?.name === lastRound.name)) {
            roundStructure.push({ name: lastRound.name, slots: (lastRound.matches?.length || 0) * 2 });
        }

        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .update({
                // legacy compatibility
                round_name: bracket.round_name || LEGACY_ROUND_NAME_BRACKET,
                draw_type: "bracket",
                draw_data: bracketData,
                round_structure: roundStructure,
                bracket_data: bracketData,
                updated_at: new Date().toISOString()
            })
            .eq("id", bracket.id)
            .select()
            .maybeSingle();

        if (error) throw error;

        return res.json({ success: true, bracket: data, message: "Round added successfully" });
    } catch (err) {
        console.error("ADD ROUND ERROR:", err);
        res.status(500).json({ message: "Failed to add round", error: err.message });
    }
};

/**
 * Publish/Unpublish draw
 * POST /api/admin/events/:id/categories/:categoryId/publish
 */
export const publishCategoryDraw = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const published = req.body?.published;
        const categoryLabel = req.body?.categoryLabel || req.query?.categoryLabel;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        if (typeof published !== 'boolean') {
            return res.status(400).json({ message: "Published must be boolean" });
        }

        let findQuery = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId);

        if (categoryId && isUuid(categoryId)) {
            findQuery = findQuery.eq("category_id", categoryId);
        } else if (categoryId && !isUuid(categoryId)) {
            // Synthetic IDs MUST be isolated from base category label updates
            findQuery = findQuery.eq("category", categoryId);
        } else if (categoryLabel) {
            findQuery = findQuery.eq("category", categoryLabel);
        } else {
            return res.status(400).json({ message: "Valid Category ID or Category Label required" });
        }

        console.log(`[publishCategoryDraw] eventId=${eventId}, categoryId=${categoryId}, categoryLabel=${categoryLabel}, published=${published}`);

        // DIRECT APPROACH: Update ALL rows matching this category in one shot.
        // This covers ALL modes (MEDIA, BRACKET, LEAGUE_SCOREBOARD, etc.)
        // and prevents ANY stale published=true rows from being missed.
        
        let updateCount = 0;

        if (categoryId && isUuid(categoryId)) {
            // Update by category_id (UUID column)
            const { data: d1, error: e1 } = await supabaseAdmin
                .from("event_brackets")
                .update({ published, updated_at: new Date().toISOString() })
                .eq("event_id", eventId)
                .eq("category_id", categoryId)
                .select("id");
            if (e1) throw e1;
            updateCount += (d1 || []).length;

            // Also update rows where category TEXT = UUID string (legacy rows with null category_id)
            const { data: d2, error: e2 } = await supabaseAdmin
                .from("event_brackets")
                .update({ published, updated_at: new Date().toISOString() })
                .eq("event_id", eventId)
                .eq("category", categoryId)
                .select("id");
            if (e2) throw e2;
            updateCount += (d2 || []).length;
        } else if (categoryId) {
            // Synthetic ID like uuid_R2 — update by category text
            const { data: d1, error: e1 } = await supabaseAdmin
                .from("event_brackets")
                .update({ published, updated_at: new Date().toISOString() })
                .eq("event_id", eventId)
                .eq("category", categoryId)
                .select("id");
            if (e1) throw e1;
            updateCount += (d1 || []).length;
        } else if (categoryLabel) {
            const { data: d1, error: e1 } = await supabaseAdmin
                .from("event_brackets")
                .update({ published, updated_at: new Date().toISOString() })
                .eq("event_id", eventId)
                .eq("category", categoryLabel)
                .select("id");
            if (e1) throw e1;
            updateCount += (d1 || []).length;
        }

        console.log(`[publishCategoryDraw] Updated ${updateCount} rows to published=${published}`);

        // If no rows existed, insert a stub
        let resultData = null;
        if (updateCount === 0) {
            const { data, error } = await supabaseAdmin
                .from("event_brackets")
                .insert({
                    event_id: eventId,
                    category_id: (categoryId && isUuid(categoryId)) ? categoryId : null,
                    category: (categoryId && !isUuid(categoryId)) ? categoryId : (categoryLabel || categoryId),
                    published: published,
                    mode: 'MEDIA',
                    round_name: 'LEAGUE',
                    updated_at: new Date().toISOString()
                })
                .select();
            if (error) throw error;
            resultData = data;
        }

        res.json({
            success: true,
            message: published ? "Draw published successfully" : "Draw unpublished",
            draws: resultData
        });
    } catch (err) {
        console.error("PUBLISH DRAW ERROR:", err);
        res.status(500).json({ message: "Failed to publish draw", error: err.message });
    }
};

/**
 * Delete media from category
 * DELETE /api/admin/events/:id/categories/:categoryId/media/:mediaId
 */
export const deleteCategoryMedia = async (req, res) => {
    try {
        const { id: eventId, categoryId, mediaId } = req.params;
        const categoryLabel = req.query.categoryLabel || req.query.category;

        if (!eventId || !mediaId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Missing required parameters" });
        }

        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "MEDIA");

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else if (categoryId && !isUuid(categoryId)) {
            query = query.eq("category", categoryId);
        } else {
            query = query.eq("category", categoryLabel);
        }

        const { data: draws, error: fetchError } = await query;

        if (fetchError) throw fetchError;
        if (!draws || draws.length === 0) {
            return res.status(404).json({ message: "Media draw not found" });
        }

        const draw = draws[0];
        const mediaUrls = draw.media_urls || [];
        const filteredMedia = mediaUrls.filter(m => m.id !== mediaId);
        const pdfUrl = draw.pdf_url;

        // Check if all media is deleted (no media URLs and no PDF)
        const hasNoMedia = (!filteredMedia || filteredMedia.length === 0) && !pdfUrl;

        // If all media is deleted, clear the mode to allow switching to BRACKET mode
        const updatePayload = {
            updated_at: new Date().toISOString()
        };

        if (hasNoMedia) {
            // Clear mode and all media-related fields to allow bracket creation
            updatePayload.mode = null;
            updatePayload.media_urls = null;
            updatePayload.pdf_url = null;
            updatePayload.draw_data = null;
            updatePayload.draw_type = null;
        } else {
            // Update with remaining media
            updatePayload.draw_type = "image";
            updatePayload.draw_data = { images: filteredMedia.map((m) => ({ id: m.id, url: m.url, description: m.description || "" })) };
            updatePayload.media_urls = filteredMedia;
        }

        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .update(updatePayload)
            .eq("id", draw.id)
            .select()
            .maybeSingle();

        if (error) throw error;

        res.json({
            success: true,
            draw: data,
            message: hasNoMedia
                ? "All media deleted. You can now create brackets for this category."
                : "Media deleted successfully",
            modeCleared: hasNoMedia
        });
    } catch (err) {
        console.error("DELETE MEDIA ERROR:", err);
        res.status(500).json({ message: "Failed to delete media", error: err.message });
    }
};

/**
 * Reset bracket (delete all matches, keep structure)
 * POST /api/admin/events/:id/categories/:categoryId/bracket/reset
 */
export const resetBracket = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel } = req.body;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else if (categoryId && !isUuid(categoryId)) {
            query = query.eq("category", categoryId);
        } else {
            query = query.eq("category", categoryLabel);
        }

        const { data: brackets, error: fetchError } = await query;

        if (fetchError) throw fetchError;
        if (!brackets || brackets.length === 0) {
            return res.status(404).json({ message: "Bracket not found" });
        }

        const bracket = brackets[0];
        // Dynamic reset: clear all rounds + structure (admin will add rounds again)
        const resetBracketData = {
            rounds: [],
            players: []
        };

        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .update({
                // legacy compatibility
                round_name: bracket.round_name || LEGACY_ROUND_NAME_BRACKET,
                draw_type: "bracket",
                draw_data: resetBracketData,
                round_structure: [],
                bracket_data: resetBracketData,
                published: false,
                updated_at: new Date().toISOString()
            })
            .eq("id", bracket.id)
            .select()
            .maybeSingle();

        if (error) throw error;

        res.json({
            success: true,
            bracket: data,
            message: "Bracket reset successfully"
        });
    } catch (err) {
        console.error("RESET BRACKET ERROR:", err);
        res.status(500).json({ message: "Failed to reset bracket", error: err.message });
    }
};

/**
 * Delete bracket for a category (hard delete the BRACKET row)
 * DELETE /api/admin/events/:id/categories/:categoryId/bracket
 */
export const deleteCategoryBracket = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const categoryLabel = req.query.categoryLabel || req.query.category;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        const { data: allBrackets, error: fetchError } = await supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (fetchError) throw fetchError;
        const normalizedParamId = String(categoryId || "").trim();
        const normalizedLabel = String(categoryLabel || "").trim().toLowerCase();

        const brackets = (allBrackets || []).filter((row) => {
            if (categoryId && isUuid(categoryId)) {
                return String(row.category_id || "").trim() === normalizedParamId;
            }

            const rowCategory = String(row.category || "").trim().toLowerCase();
            const sourceCategoryId = String(
                row?.bracket_data?.sourceCategoryId ||
                row?.draw_data?.sourceCategoryId ||
                ""
            ).trim();

            if (normalizedLabel && rowCategory === normalizedLabel) return true;
            if (normalizedParamId && sourceCategoryId === normalizedParamId) return true;
            return false;
        });

        if (!brackets || brackets.length === 0) {
            return res.status(404).json({ message: "Bracket not found" });
        }

        // Check if ANY bracket is published
        const publishedBracket = brackets.find(b => b.published === true);
        if (publishedBracket) {
            return res.status(400).json({
                message: "Cannot delete a published bracket. Unpublish first.",
                code: "BRACKET_PUBLISHED"
            });
        }

        // Delete ALL brackets for this category (handles duplicates)
        const bracketIds = brackets.map(b => b.id);

        // CRITICAL: Also delete all matches that belong to these brackets (by bracket_id)
        // This is safer than a category-wide match delete which would wipe league/pool matches too
        try {
            const { error: matchDelError, count: matchDelCount } = await supabaseAdmin
                .from("matches")
                .delete()
                .in("bracket_id", bracketIds);
            if (matchDelError && matchDelError.code !== 'PGRST116') {
                console.warn("[deleteCategoryBracket] Warning: Failed to delete bracket matches:", matchDelError);
            } else {
                console.log(`[deleteCategoryBracket] Deleted ${matchDelCount || 0} match(es) for bracket(s)`);
            }
        } catch (matchErr) {
            console.warn("[deleteCategoryBracket] Warning: Match cleanup failed:", matchErr);
            // Continue with bracket deletion even if match cleanup fails
        }

        const { error: deleteError } = await supabaseAdmin
            .from("event_brackets")
            .delete()
            .in("id", bracketIds);

        if (deleteError) throw deleteError;

        console.log("[deleteCategoryBracket] Deleted", bracketIds.length, "bracket(s) for category", categoryId || categoryLabel);
        await invalidateMatchesCache(eventId);
        return res.json({ success: true, message: `Deleted ${bracketIds.length} bracket(s) successfully` });
    } catch (err) {
        console.error("DELETE BRACKET ERROR:", err);
        res.status(500).json({ message: "Failed to delete bracket", error: err.message });
    }
};

/**
 * Delete a specific round from a bracket (only last round, unpublished)
 * POST /api/admin/events/:id/categories/:categoryId/bracket/round/delete
 */
export const deleteBracketRound = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, roundName } = req.body;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else if (categoryId && !isUuid(categoryId)) {
            query = query.eq("category", categoryId);
        } else {
            query = query.eq("category", categoryLabel);
        }

        const { data: brackets, error: fetchError } = await query;
        if (fetchError) throw fetchError;
        if (!brackets || brackets.length === 0) {
            return res.status(404).json({ message: "Bracket not found" });
        }

        const bracket = brackets[0];
        if (bracket.published === true) {
            return res.status(400).json({
                message: "Cannot delete round from a published bracket. Unpublish first.",
                code: "BRACKET_PUBLISHED"
            });
        }

        const bracketData = bracket.bracket_data || { rounds: [], players: [] };
        const rounds = Array.isArray(bracketData.rounds) ? bracketData.rounds : [];
        if (rounds.length === 0) {
            return res.status(400).json({ message: "No rounds to delete" });
        }

        const targetIndex = roundName
            ? rounds.findIndex((r) => r && r.name === roundName)
            : rounds.length - 1;

        if (targetIndex === -1) {
            return res.status(404).json({ message: "Round not found" });
        }

        // Only allow deleting the last round to keep bracket progression consistent
        if (targetIndex !== rounds.length - 1) {
            return res.status(400).json({
                message: "Only the last round can be deleted.",
                code: "ONLY_LAST_ROUND_DELETABLE"
            });
        }

        const deletedRound = rounds[targetIndex];
        const deletedRoundName = deletedRound?.name || roundName;

        // Delete all matches for this round from the matches table
        // This ensures scoreboard data is completely removed when a round is deleted
        // Admin can then regenerate matches from the bracket structure if needed
        let deletedMatchCount = 0;
        try {
            // First, fetch ALL matches for this event to filter safely in memory
            // This is more reliable than trying to match round_name exactly in the query
            const { data: allEventMatches, error: fetchAllError } = await supabaseAdmin
                .from('matches')
                .select('id, category_id, event_id, round_name')
                .eq('event_id', eventId);

            if (fetchAllError) {
                console.error("Error fetching all matches for deletion:", fetchAllError);
            } else if (allEventMatches && allEventMatches.length > 0) {
                // Filter matches in memory by category and round name (case-insensitive, trimmed)
                const normalizedDeletedRoundName = String(deletedRoundName || '').trim();

                const safeMatchesToDelete = allEventMatches.filter(match => {
                    const matchCategoryId = match.category_id;
                    const matchRoundName = String(match.round_name || '').trim();

                    // Round name must match (case-insensitive)
                    const roundMatches = matchRoundName.toLowerCase() === normalizedDeletedRoundName.toLowerCase();
                    if (!roundMatches) {
                        return false;
                    }

                    // Category must match
                    if (!matchCategoryId) {
                        return false;
                    }

                    // Exact category match - try multiple strategies like deleteCategoryMatches does
                    let categoryMatches = false;

                    // Strategy 1: Exact UUID match (most reliable)
                    if (categoryId && isUuid(categoryId)) {
                        categoryMatches = String(matchCategoryId) === String(categoryId);
                    }
                    // Strategy 2: Exact text/numeric match (categoryId as text or number)
                    else if (categoryId) {
                        categoryMatches = matchCategoryId == categoryId || String(matchCategoryId) === String(categoryId);
                    }
                    // Strategy 3: Category name exact match (if category_id stores the full label)
                    else if (categoryLabel) {
                        categoryMatches = matchCategoryId === categoryLabel || String(matchCategoryId) === String(categoryLabel);
                    }

                    return categoryMatches;
                });

                // Delete matching matches
                if (safeMatchesToDelete.length > 0) {
                    const matchIds = safeMatchesToDelete.map(m => m.id);
                    const { error: deleteMatchesError, data: deletedData } = await supabaseAdmin
                        .from('matches')
                        .delete()
                        .in('id', matchIds)
                        .select();

                    if (deleteMatchesError) {
                        console.error("Error deleting matches for round:", deleteMatchesError);
                        // Don't fail the whole operation if match deletion fails, but log it
                    } else {
                        deletedMatchCount = deletedData?.length || safeMatchesToDelete.length;
                    }
                }
            }
        } catch (matchDeleteErr) {
            console.error("Error during match deletion for round:", matchDeleteErr);
            // Continue with round deletion even if match deletion fails
        }

        rounds.splice(targetIndex, 1);
        bracketData.rounds = rounds;

        const roundStructure = Array.isArray(bracket.round_structure) ? bracket.round_structure : [];
        const updatedStructure = roundStructure.filter((r) => r?.name !== deletedRound?.name);

        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .update({
                round_name: bracket.round_name || LEGACY_ROUND_NAME_BRACKET,
                draw_type: "bracket",
                draw_data: bracketData,
                round_structure: updatedStructure,
                bracket_data: bracketData,
                updated_at: new Date().toISOString()
            })
            .eq("id", bracket.id)
            .select()
            .maybeSingle();

        if (error) throw error;

        // Return success with info about match deletion
        const matchDeletionMessage = deletedMatchCount > 0
            ? `Round "${deletedRoundName}" deleted successfully. ${deletedMatchCount} match(es) removed from scoreboard.`
            : `Round "${deletedRoundName}" deleted successfully. No matches found for this round.`;

        await invalidateMatchesCache(eventId);
        return res.json({
            success: true,
            bracket: data,
            deletedMatchCount,
            message: matchDeletionMessage
        });
    } catch (err) {
        console.error("DELETE ROUND ERROR:", err);
        res.status(500).json({ message: "Failed to delete round", error: err.message });
    }
};

/**
 * Randomize BYE placement in Round 1
 * POST /api/admin/events/:id/categories/:categoryId/bracket/round/randomize-byes
 */
/**
 * Randomize BYE placement in Round 1
 * POST /api/admin/events/:id/categories/:categoryId/bracket/round/randomize-byes
 */
export const randomizeRound1Byes = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, expectedTotalPlayers } = req.body || {};

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
        const bracketData = bracket.bracket_data || { rounds: [], players: [] };
        const { rounds = [] } = bracketData;

        if (rounds.length === 0) {
            return res.status(400).json({ message: "Bracket not initialized" });
        }

        const firstRound = rounds[0];
        const firstRoundName = firstRound.name;
        const matches = Array.isArray(firstRound.matches) ? firstRound.matches : [];

        if (matches.length === 0) {
            return res.status(400).json({ message: "Round 1 has no matches" });
        }

        // Calculate player count and BYE count
        const slotCount = matches.length * 2;
        let totalPlayers = 0;
        const seededSlots = [];
        const unseededPlayers = [];

        const seedSource = getSeedSource(bracketData, firstRoundName);
        const isSeeded = (p) => {
            if (!p) return false;
            const playerId = p.id || p.player_id;
            const v = seedSource.byRound?.[playerId] ?? seedSource.global?.[playerId];
            return v != null;
        };

        for (let i = 0; i < matches.length; i++) {
            const m = matches[i];
            const p1 = m.player1 && !isFakeByePlayer(m.player1) ? m.player1 : null;
            const p2 = m.player2 && !isFakeByePlayer(m.player2) ? m.player2 : null;

            if (p1) {
                totalPlayers++;
                if (isSeeded(p1)) {
                    const seed = getSeedValue(p1.id || p1.player_id, bracketData, firstRoundName) || 9999;
                    seededSlots.push({ matchIndex: i, slot: "player1", player: p1, seed });
                } else {
                    unseededPlayers.push(p1);
                }
            }
            if (p2) {
                totalPlayers++;
                if (isSeeded(p2)) {
                    const seed = getSeedValue(p2.id || p2.player_id, bracketData, firstRoundName) || 9999;
                    seededSlots.push({ matchIndex: i, slot: "player2", player: p2, seed });
                } else {
                    unseededPlayers.push(p2);
                }
            }
        }

        let effectiveTotalPlayers = totalPlayers;
        if (expectedTotalPlayers && Number(expectedTotalPlayers) > 0) {
            effectiveTotalPlayers = Number(expectedTotalPlayers);
        }

        let byesTotal = Math.max(0, slotCount - effectiveTotalPlayers);
        if (effectiveTotalPlayers >= slotCount) byesTotal = 0;

        // Calculate locked top-seed BYEs
        const seededSortedView = [...seededSlots].sort((a, b) => (a.seed || 0) - (b.seed || 0));
        const topNForByes = Math.min(byesTotal, seededSortedView.length);
        const topSeedValues = seededSortedView.slice(0, topNForByes).map(s => s.seed);
        const topSeedValueSet = new Set(topSeedValues.map(s => Number(s)));
        const lockedTopSeedValues = new Set();

        if (byesTotal <= 0) {
            return res.status(200).json({
                success: true,
                message: "Full bracket (no BYEs needed). No changes made."
            });
        }

        // Reshuffle logic
        const unseededPlayersPool = [];
        const unlockedSlots = [];

        for (let i = 0; i < matches.length; i++) {
            const m = matches[i];
            const p1 = m.player1 && !isFakeByePlayer(m.player1) ? m.player1 : null;
            const p2 = m.player2 && !isFakeByePlayer(m.player2) ? m.player2 : null;

            if (m.isManualBye === true) continue;

            const seed1 = p1 && isSeeded(p1);
            const seed2 = p2 && isSeeded(p2);
            const seedVal1 = seed1 ? (getSeedValue(p1.id || p1.player_id, bracketData, firstRoundName) || 9999) : null;
            const seedVal2 = seed2 ? (getSeedValue(p2.id || p2.player_id, bracketData, firstRoundName) || 9999) : null;

            const seedHasBye = (seed1 && !p2) || (seed2 && !p1);
            const byeLockedHere = (seed1 && !p2 && topSeedValueSet.has(Number(seedVal1))) || (seed2 && !p1 && topSeedValueSet.has(Number(seedVal2)));

            if (seedHasBye && byeLockedHere) {
                if (seedVal1) lockedTopSeedValues.add(Number(seedVal1));
                if (seedVal2) lockedTopSeedValues.add(Number(seedVal2));
                continue;
            }

            m.winner = null;

            if (!isSeeded(p1)) {
                if (p1) unseededPlayersPool.push(p1);
                unlockedSlots.push({ matchIndex: i, slot: "player1" });
                m.player1 = null;
            }

            if (!isSeeded(p2)) {
                if (p2) unseededPlayersPool.push(p2);
                unlockedSlots.push({ matchIndex: i, slot: "player2" });
                m.player2 = null;
            }
        }

        const shuffledSlots = shuffle(unlockedSlots);
        const shuffledPlayers = shuffle(unseededPlayersPool);
        
        const unlockedKeySet = new Set(unlockedSlots.map(s => `${s.matchIndex}:${s.slot}`));
        const byeSlotKeys = new Set();
        const byesToAssign = Math.max(0, byesTotal - lockedTopSeedValues.size);

        // Priority: Give BYEs to top seeds first
        const preferredByeKeys = [];
        for (const s of seededSlots) {
            if (!topSeedValueSet.has(Number(s.seed))) continue;
            if (lockedTopSeedValues.has(Number(s.seed))) continue;
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
            if (byeSlotKeys.has(key)) continue;

            const player = shuffledPlayers[playerIndex++] || null;
            if (!player) continue;
            const m = matches[slot.matchIndex];
            m[slot.slot] = player;
        }

        // Auto-assign winners for BYE matches
        for (let i = 0; i < matches.length; i++) {
            const m = matches[i];
            const p1 = m.player1 && !isFakeByePlayer(m.player1) ? m.player1 : null;
            const p2 = m.player2 && !isFakeByePlayer(m.player2) ? m.player2 : null;
            if (p1 && !p2) m.winner = "player1";
            else if (!p1 && p2) m.winner = "player2";
            else m.winner = null;
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
 * PATCH /api/admin/events/:id/categories/:categoryId/bracket/round1/assign-bye
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
        const allPlayers = Array.isArray(bracketData.players) ? bracketData.players : [];
        const playerToAssign = allPlayers.find(p => (p.id || p.player_id) === playerId);

        if (!playerToAssign) {
            return res.status(404).json({ message: "Player not found" });
        }

        const p1 = match.player1 && !isFakeByePlayer(match.player1) ? match.player1 : null;
        const p2 = match.player2 && !isFakeByePlayer(match.player2) ? match.player2 : null;
        const isBye = (p1 && !p2) || (!p1 && p2);

        if (!isBye) {
            return res.status(400).json({ message: "Match is not a BYE (both slots occupied or both empty)" });
        }

        const slotToFill = p1 ? "player2" : "player1";
        match[slotToFill] = playerToAssign;
        match.winner = p1 ? "player1" : "player2";

        // Mark as manual BYE
        match.isManualBye = true;

        await supabaseAdmin
            .from("event_brackets")
            .update({
                bracket_data: bracketData,
                draw_data: bracketData,
                updated_at: new Date().toISOString()
            })
            .eq("id", bracket.id);

        return res.status(200).json({
            success: true,
            message: `Player assigned to match ${matchId}. BYE winner auto-advanced.`,
            match
        });

    } catch (error) {
        console.error("Error assigning BYE:", error);
        return res.status(500).json({ message: "Failed to assign BYE", error: error.message });
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

/**
 * Record a match result (score + winner)
 * POST /api/admin/events/:id/categories/:categoryId/bracket/result
 */
export const recordResult = async (req, res) => {
    //console.log("[recordResult] Called with params:", { eventId: req.params.id, categoryId: req.params.categoryId }, "body:", { matchId: req.body?.matchId, winner: req.body?.winner, roundName: req.body?.roundName, categoryLabel: req.body?.categoryLabel });
    try {
        let { id: eventId, categoryId } = req.params;
        const { matchId, winner, score, sets, roundName, categoryLabel } = req.body;

        if (!eventId) {
            return res.status(400).json({ message: "Event ID required" });
        }

        if (!categoryId && !categoryLabel) {
            return res.status(400).json({ message: "Valid category ID or categoryLabel required" });
        }

        if (!matchId || !winner) {
            return res.status(400).json({ message: "Missing matchId or winner" });
        }

        // Fetch bracket - select the most recent in case of duplicates.
        //
        // This used to resolve a non-UUID categoryId through a table called
        // `event_categories` — which does not exist in this schema (categories live
        // in the events.categories jsonb column). Every category created by the
        // event form has a numeric-string id, so that lookup ALWAYS failed with
        // `Category "..." not found for event`, and the bracket's own bracket_data
        // never received the winner. The matches table still got updated further
        // down by the scoreboard, which is why BracketRenderer looked correct while
        // the bracket editor kept showing TBD.
        //
        // Resolve the same way every other bracket endpoint does: by category_id
        // when it is a UUID, otherwise by the stored category label.
        let bracketQuery = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId);

        if (categoryId && isUuid(categoryId)) {
            bracketQuery = bracketQuery.eq("category_id", categoryId);
        } else if (categoryLabel) {
            bracketQuery = bracketQuery.eq("category", categoryLabel);
        } else {
            // Non-UUID id with no label: legacy rows store the id in `category`.
            bracketQuery = bracketQuery.eq("category", String(categoryId));
        }

        const { data: brackets, error: bracketError } = await bracketQuery
            .order("created_at", { ascending: false })
            .limit(1);

        if (bracketError) {
            console.error("[recordResult] Bracket fetch error:", { eventId, categoryId, error: bracketError });
            return res.status(404).json({ message: "Bracket not found", error: bracketError.message });
        }

        if (!brackets || brackets.length === 0) {
            console.error("[recordResult] No bracket found for:", { eventId, categoryId });
            return res.status(404).json({ message: "Bracket not found" });
        }

        const bracket = brackets[0];

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

        // Determine winner player object and extract actual player UUID.
        // CRITICAL: Store the real player UUID instead of "A"/"B" to avoid
        // semantic ambiguity. "A"/"B" was historically interpreted as
        // "DB player_a/player_b" by some frontend code but actually meant
        // "bracket player1/player2" here, causing cross-contamination bugs.
        const winnerPlayer = winner === "player1" ? match.player1 : match.player2;
        const getPlayerId = (p) => {
            if (!p) return null;
            if (typeof p === "string") return p;
            return p.id || p.player_id || p.playerId || null;
        };
        const winnerPlayerId = getPlayerId(winnerPlayer);

        // Update matches table (authoritative)
        // Prefer actual UUID; fall back to "A"/"B" only if player id is missing.
        const matchesUpdate = {
            winner: winnerPlayerId || (winner === "player1" ? "A" : "B"),
            score: score,
            sets: sets,
            status: "COMPLETED",
            updated_at: new Date().toISOString()
        };

        // bracket_match_id ("R1-M1") repeats across every category of an event, so the
        // category filter is required here. It must accept BOTH keys: matches.category_id
        // holds either the category id or its label depending on which screen created
        // the round, and filtering on just one silently updated zero rows.
        const matchCategoryKeys = Array.from(new Set(
            [categoryId, categoryLabel, bracket.category_id, bracket.category]
                .map((v) => (v == null ? "" : String(v).trim()))
                .filter((v) => v.length > 0)
        ));

        let matchesUpdateQuery = supabaseAdmin
            .from("matches")
            .update(matchesUpdate)
            .eq("bracket_match_id", matchId)
            .eq("event_id", eventId);

        matchesUpdateQuery = matchCategoryKeys.length === 1
            ? matchesUpdateQuery.eq("category_id", matchCategoryKeys[0])
            : matchesUpdateQuery.in("category_id", matchCategoryKeys);

        await matchesUpdateQuery;

        // Update bracket_data (sync)
        match.winner = winner;
        if (score) match.score = score;
        if (sets) match.sets = sets;

        // ── Winner propagation to next round ──
        // If the bracket match has winnerTo/winnerToSlot, propagate the winning
        // player/team to the downstream match. Also supports legacy index-based
        // propagation for older bracket structures.
        try {
            const rounds = bracketData.rounds || [];
            const currentRoundIdx = rounds.findIndex(r => normalizeRoundName(r?.name) === normalizedRound);
            const currentRoundMatches = rounds[currentRoundIdx]?.matches || [];
            const matchIdx = currentRoundMatches.findIndex(m => m?.id === matchId);

            // Determine the winning player/team object
            const winnerPlayer = winner === "player1" ? match.player1 : match.player2;

            if (winnerPlayer && currentRoundIdx >= 0 && matchIdx >= 0) {
                let targetId = match.winnerTo != null ? String(match.winnerTo).trim() : null;
                let targetSlot = match.winnerToSlot || null;

                // Legacy fallback: derive from match index
                if ((!targetId || !targetSlot) && currentRoundIdx < rounds.length - 1) {
                    const nextRound = rounds[currentRoundIdx + 1];
                    const nextMatchIdx = Math.floor(matchIdx / 2);
                    const slot = (matchIdx % 2 === 0) ? "player1" : "player2";
                    if (nextRound?.matches?.[nextMatchIdx]) {
                        targetId = String(nextRound.matches[nextMatchIdx].id);
                        targetSlot = slot;
                    }
                }

                if (targetId && targetSlot) {
                    // Find and update the downstream match
                    for (const r of rounds) {
                        for (const m of (r.matches || [])) {
                            if (m && String(m.id).trim() === targetId) {
                                m[targetSlot] = winnerPlayer;
                                console.log(`[recordResult] Propagated winner to ${targetId} slot ${targetSlot}:`, typeof winnerPlayer === 'object' ? winnerPlayer.name || winnerPlayer.id : winnerPlayer);
                            }
                        }
                    }
                }
            }
        } catch (propErr) {
            console.warn("[recordResult] Winner propagation failed (non-fatal):", propErr.message);
        }

        const { data: updatedBracket, error: updateError } = await supabaseAdmin
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

        await invalidateMatchesCache(eventId);
        return res.json({
            success: true,
            message: "Result recorded successfully",
            match,
            bracket: updatedBracket
        });

    } catch (err) {
        console.error("RECORD RESULT ERROR:", err);
        return res.status(500).json({ message: "Failed to record result", error: err.message });
    }
};

/**
 * Send promotion notifications to winning players
 * POST /api/admin/events/:id/categories/:categoryId/bracket/notify-promotions
 * Body: { categoryLabel, completedRoundName, nextRoundName, promotions: [{winnerId, winnerName, opponentName, score, winnerIsPlayer1}, ...] }
 */
export const notifyBracketPromotions = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params; // Map route params
        const { categoryLabel, completedRoundName, nextRoundName, promotions } = req.body;

        if (!eventId) {
            return res.status(400).json({ message: "Event ID required" });
        }

        if (!Array.isArray(promotions) || promotions.length === 0) {
            return res.json({ success: true, notified: 0 });
        }

        const extractScores = (scoreObj) => {
            if (!scoreObj || typeof scoreObj !== "object") {
                return { player1: null, player2: null };
            }

            const toNum = (v) => {
                const n = Number(v);
                return Number.isFinite(n) ? n : null;
            };

            let p1 = toNum(scoreObj.player1 ?? scoreObj.player_a ?? scoreObj.playerA);
            let p2 = toNum(scoreObj.player2 ?? scoreObj.player_b ?? scoreObj.playerB);

            if ((p1 == null || p2 == null) && Array.isArray(scoreObj.sets) && scoreObj.sets.length > 0) {
                let setP1 = 0;
                let setP2 = 0;
                let hasAny = false;

                for (const set of scoreObj.sets) {
                    const s1 = toNum(set?.player1 ?? set?.player_a ?? set?.playerA);
                    const s2 = toNum(set?.player2 ?? set?.player_b ?? set?.playerB);
                    if (s1 != null || s2 != null) {
                        hasAny = true;
                        setP1 += s1 ?? 0;
                        setP2 += s2 ?? 0;
                    }
                }

                if (hasAny) {
                    p1 = setP1;
                    p2 = setP2;
                }
            }

            return { player1: p1, player2: p2 };
        };

        // For each promotion, look up the player's registered user id in event_registrations.
        // NOTE: In this schema, `player_id` stores the user UUID (there is no `user_id` column).
        const notificationPromises = promotions.map(async (promotion) => {
            try {
                const { winnerId, winnerName, opponentName, score, winnerIsPlayer1 } = promotion;
                if (!winnerId) {
                    return { status: "skipped" };
                }

                // Look up player_id from event_registrations (acts as user id for notifications)
                const { data: registration, error: regError } = await supabaseAdmin
                    .from("event_registrations")
                    .select("player_id")
                    .eq("event_id", eventId)
                    .eq("player_id", winnerId)
                    .order("created_at", { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (regError) {
                    console.error(`[notifyBracketPromotions] Lookup error for player ${winnerId}:`, regError);
                }

                const userId = registration?.player_id || winnerId;
                if (!userId) {
                    return { status: "skipped" };
                }

                const normalizedScore = extractScores(score);
                const yourScore = winnerIsPlayer1 ? normalizedScore.player1 : normalizedScore.player2;
                const opponentScore = winnerIsPlayer1 ? normalizedScore.player2 : normalizedScore.player1;
                const scoreText = (yourScore != null && opponentScore != null)
                    ? `${yourScore}–${opponentScore}`
                    : "N/A";

                const title = `🏆 You're Promoted to the ${nextRoundName}!`;
                const message = `You won your ${completedRoundName} match against ${opponentName} with a score of ${scoreText}. Get ready for the ${nextRoundName}!`;

                const categoryKey = categoryId || categoryLabel || "unknown-category";
                const dedupeLink = `promotion:${eventId}:${categoryKey}:${completedRoundName}:${nextRoundName}:${winnerId}`;

                const { data: existingRows, error: existingError } = await supabaseAdmin
                    .from("notifications")
                    .select("id")
                    .eq("user_id", userId)
                    .eq("link", dedupeLink)
                    .order("created_at", { ascending: false })
                    .limit(1);

                if (existingError) {
                    console.error(`[notifyBracketPromotions] Dedupe check failed for ${winnerId}:`, existingError);
                }

                if (Array.isArray(existingRows) && existingRows.length > 0) {
                    return { status: "duplicate", userId };
                }

                await createNotification(userId, title, message, 'success', dedupeLink);
                return { status: "sent", userId };
            } catch (err) {
                console.error("[notifyBracketPromotions] Error creating notification:", err);
                return { status: "error" };
            }
        });

        const results = await Promise.allSettled(notificationPromises);
        const fulfilled = results
            .filter((r) => r.status === "fulfilled")
            .map((r) => r.value || {});

        const notified = fulfilled.filter((r) => r.status === "sent").length;
        const duplicates = fulfilled.filter((r) => r.status === "duplicate").length;

        return res.json({ success: true, notified, duplicates });
    } catch (err) {
        console.error("[notifyBracketPromotions] Error:", err);
        return res.status(500).json({ message: "Failed to send notifications", error: err.message });
    }
};

/**
 * Bulk fetch draws summary for multiple events
 * GET /api/admin/events/draws/summary?eventIds=1,2,3
 */
export const getBulkDrawSummary = async (req, res) => {
    try {
        const { eventIds } = req.query;
        if (!eventIds) return res.json({ success: true, summary: {} });

        const ids = eventIds.split(',').filter(Boolean);
        if (ids.length === 0) return res.json({ success: true, summary: {} });

        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .select("event_id, mode, media_urls, pdf_url, bracket_data, published")
            .in("event_id", ids);

        if (error) throw error;

        const summary = {};
        ids.forEach(id => {
            summary[id] = { drawsCount: 0, roundsCompleted: 0, drawsUploaded: false };
        });

        if (data) {
            data.forEach(row => {
                const eventId = String(row.event_id);
                if (!summary[eventId]) {
                    summary[eventId] = { drawsCount: 0, roundsCompleted: 0, drawsUploaded: false };
                }

                let hasDraw = false;

                if (row.mode === 'MEDIA') {
                    if ((row.media_urls && row.media_urls.length > 0) || row.pdf_url) {
                        hasDraw = true;
                    }
                } else if (row.mode === 'BRACKET') {
                    if (row.bracket_data) {
                        hasDraw = true;
                        const rounds = row.bracket_data.rounds || [];
                        const completedRounds = rounds.filter(r =>
                            r.matches && r.matches.length > 0 && r.matches.every(m => m.isComplete || m.is_complete)
                        ).length;
                        summary[eventId].roundsCompleted += completedRounds;
                    }
                } else if (row.mode === 'LEAGUE_PLACEHOLDER' || row.mode === 'LEAGUE') {
                    hasDraw = true;
                }

                if (hasDraw) {
                    summary[eventId].drawsCount++;
                    summary[eventId].drawsUploaded = true;
                }
            });
        }

        res.json({ success: true, summary });
    } catch (err) {
        console.error("Bulk Draw Summary Error:", err);
        res.status(500).json({ success: false, message: "Internal server error" });
    }
};
