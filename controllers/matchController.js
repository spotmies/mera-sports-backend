import { supabaseAdmin } from "../config/supabaseClient.js";
import { validateBracketIntegrity } from "../middleware/bracketValidation.js";
import { resolveEventIdByIdentifier } from "../utils/eventResolver.js";

// Helper function to check if string is UUID
const isUuid = (str) => {
    if (!str || typeof str !== 'string') return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
};

/** Normalize round name for consistent matching. ALWAYS use for any round_name comparison. */
const normalizeRoundName = (s) => String(s ?? "").trim().toLowerCase();
const MAX_SETS_PER_MATCH = 9;
const DB_ID_BATCH_SIZE = 500;
const MAX_ROUND_ROBIN_GROUP_SIZE = 16;

const chunkArray = (arr, size = DB_ID_BATCH_SIZE) => {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
};

const normalizeText = (value) => String(value || '').trim().toLowerCase();

const isLeagueCategoryPublishedForPublic = async ({ eventId, categoryId, categoryLabel }) => {
    const { data: publishedRows, error } = await supabaseAdmin
        .from('event_brackets')
        .select('category_id, category')
        .eq('event_id', eventId)
        .eq('published', true);

    if (error) throw error;
    if (!Array.isArray(publishedRows) || publishedRows.length === 0) return false;

    const targetId = String(categoryId || '').trim();
    const targetLabel = String(categoryLabel || '').trim();
    const targetIdNormalized = normalizeText(targetId);
    const targetLabelNormalized = normalizeText(targetLabel);

    return publishedRows.some((row) => {
        const rowCategoryId = String(row?.category_id || '').trim();
        const rowCategoryLabel = String(row?.category || '').trim();
        const rowCategoryIdNormalized = normalizeText(rowCategoryId);
        const rowCategoryLabelNormalized = normalizeText(rowCategoryLabel);

        if (targetId && isUuid(targetId) && rowCategoryId && rowCategoryId === targetId) return true;
        if (targetLabel && rowCategoryLabelNormalized && rowCategoryLabelNormalized === targetLabelNormalized) return true;
        if (targetId && !isUuid(targetId) && rowCategoryLabelNormalized && rowCategoryLabelNormalized === targetIdNormalized) return true;
        if (targetId && rowCategoryIdNormalized && rowCategoryIdNormalized === targetIdNormalized) return true;

        return false;
    });
};

const parseSetsPerMatch = (rawValue, fallback = 1) => {
    // Clamp the fallback itself so callers can't accidentally pass an out-of-range default.
    const safeFallback = Number.isInteger(fallback) && fallback >= 1 && fallback <= MAX_SETS_PER_MATCH
        ? fallback
        : 1;
    const parsed = Number.parseInt(String(rawValue ?? ""), 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SETS_PER_MATCH) return safeFallback;
    return parsed;
};

/**
 * Resolve the definitive sets-per-match count for a category/match.
 *
 * Priority order:
 *  1. `configuredSets` — value stored in the bracket round config (highest priority)
 *  2. `requestSets`    — raw value sent in the request body
 *  3. `observedSetsLength` — number of sets already recorded on the match
 *  4. 1 (minimum valid fallback)
 *
 * @param {Object} params
 * @param {number} [params.configuredSets=1]      - Sets count from the bracket round config.
 * @param {number|string} [params.requestSets]    - Raw sets value from the request body (will be parsed/clamped).
 * @param {number} [params.observedSetsLength=0]  - Count of set entries already present on the match record.
 * @returns {number} A valid integer in the range [1, MAX_SETS_PER_MATCH].
 */
const resolveSetsPerMatch = ({ configuredSets = 1, requestSets, observedSetsLength = 0 }) => {
    if (configuredSets > 1) return configuredSets;
    const parsedRequestSets = parseSetsPerMatch(requestSets, 1);
    if (parsedRequestSets > 1) return parsedRequestSets;
    if (Number.isInteger(observedSetsLength) && observedSetsLength > 1) return observedSetsLength;
    return 1;
};

// Generate Matches from Bracket Data (Knockout)
export const generateMatchesFromBracket = async (req, res) => {
    const { eventId, categoryId } = req.params;
    const categoryLabel = (req.query && req.query.categoryLabel) || (req.body && req.body.categoryLabel);
    const roundName = (req.query && req.query.roundName) || (req.body && req.body.roundName); // Optional: generate for specific round only
    const setsPerMatch = parseSetsPerMatch(req.body?.setsPerMatch, 1); // Sets configuration from round (optional)
    const winnerMode = req.body?.winnerMode || 'set_based'; // Winner mode: 'set_based', 'score_based', or 'match_based'

    try {
        // 1. Fetch Bracket Data with UUID-safe query
        let bracketQuery = supabaseAdmin
            .from('event_brackets')
            .select('*')
            .eq('event_id', eventId)
            .eq('mode', 'BRACKET');

        // Only filter by category_id if it's a valid UUID
        if (categoryId && isUuid(categoryId)) {
            bracketQuery = bracketQuery.eq('category_id', categoryId);
        } else if (categoryLabel) {
            // If not UUID, use categoryLabel from query/body
            bracketQuery = bracketQuery.eq('category', categoryLabel);
        } else if (categoryId && categoryId !== 'label') {
            // Fallback: try to match by categoryId as category name (for backward compatibility)
            bracketQuery = bracketQuery.eq('category', categoryId);
        }

        const { data: bracketData, error: bracketError } = await bracketQuery.maybeSingle();

        if (bracketError || !bracketData) {
            return res.status(404).json({
                success: false,
                message: `Bracket not found or not in BRACKET mode. Category: ${categoryLabel || categoryId}`,
                debug: {
                    categoryId,
                    categoryLabel,
                    error: bracketError?.message
                }
            });
        }

        const rounds = bracketData.bracket_data?.rounds || [];
        if (!rounds.length) {
            return res.status(400).json({ success: false, message: "No rounds found in bracket data" });
        }

        // If roundName is provided, only process that round
        const roundsToProcess = roundName
            ? rounds.filter(r => r.name === roundName)
            : rounds;

        if (roundName && roundsToProcess.length === 0) {
            return res.status(404).json({
                success: false,
                message: `Round "${roundName}" not found in bracket data`
            });
        }

        // Use the bracket's actual category_id for checking existing matches
        // This ensures we're checking the correct category, not a different one
        const bracketCategoryId = bracketData.category_id;
        const bracketCategoryLabel = bracketData.category;

        // NOTE: Do NOT early-return if matches already exist for a round.
        // Admin can add new bracket matches later; generation must be idempotent per match_index:
        // - insert missing matches
        // - update existing matches with fresh player data (unless COMPLETED)

        let createdCount = 0;
        let skippedCount = 0;
        let updatedCount = 0;

        // 2. Fetch existing matches for this bracket so we can preserve COMPLETED data
        const existingMatchIds = [];
        for (const round of roundsToProcess) {
            for (const matchData of (round.matches || [])) {
                if (matchData?.id) existingMatchIds.push(String(matchData.id).trim());
            }
        }

        let existingMatchesMap = new Map();
        if (existingMatchIds.length > 0) {
            const { data: existingMatches } = await supabaseAdmin
                .from('matches')
                .select('bracket_match_id, status, score, winner')
                .eq('bracket_id', bracketData.id)
                .in('bracket_match_id', existingMatchIds);
            if (existingMatches) {
                for (const m of existingMatches) {
                    existingMatchesMap.set(m.bracket_match_id, m);
                }
            }
        }

        // 3. Loop through rounds and matches
        // HARDENED: Bulk upsert DB rows for matches to ensure performance and atomicity.
        // match_index stays contiguous and bracket_match_id is the lookup key.
        const bulkPayload = [];

        for (const round of roundsToProcess) {
            const matches = round.matches || [];

            for (let i = 0; i < matches.length; i++) {
                const matchData = matches[i];
                const bracketMatchId = matchData?.id ? String(matchData.id).trim() : null;

                // REQUIRED: Every bracket match must have an id for propagation
                if (!bracketMatchId) {
                    skippedCount++;
                    continue;
                }

                // Check if players are valid (have id)
                const hasPlayer1 = matchData.player1 && (matchData.player1.id || matchData.player1.player_id);
                const hasPlayer2 = matchData.player2 && (matchData.player2.id || matchData.player2.player_id);
                const isBye = (hasPlayer1 && !hasPlayer2) || (!hasPlayer1 && hasPlayer2);
                const isEmpty = !hasPlayer1 && !hasPlayer2;

                const matchCategoryId = bracketCategoryId || categoryId;

                // Check if this match already exists and is COMPLETED
                const existingMatch = existingMatchesMap.get(bracketMatchId);
                const isCompleted = existingMatch && existingMatch.status === 'COMPLETED';

                // Only store player_a/player_b if they have valid ids (never store empty objects)
                // For COMPLETED matches: update players but preserve score, winner, and status
                const payload = {
                    event_id: eventId,
                    category_id: matchCategoryId,
                    bracket_id: bracketData.id,
                    round_name: round.name,
                    match_index: i,
                    player_a: hasPlayer1 ? matchData.player1 : null,
                    player_b: hasPlayer2 ? matchData.player2 : null,
                    bracket_match_id: bracketMatchId,
                    score: isCompleted ? existingMatch.score : null,
                    winner: isCompleted ? existingMatch.winner : null,
                    status: isCompleted ? 'COMPLETED' : (isBye ? 'BYE' : 'SCHEDULED')
                };

                if (existingMatch && !isCompleted) {
                    updatedCount++;
                }

                bulkPayload.push(payload);
            }
        }

        if (bulkPayload.length > 0) {
            const { data, error } = await supabaseAdmin
                .from('matches')
                .upsert(bulkPayload, {
                    onConflict: 'bracket_id,bracket_match_id',
                    ignoreDuplicates: false
                })
                .select();

            if (error) throw error;

            createdCount = data?.length || 0;
        }

        // If setsPerMatch is provided, update the round's setsConfig in bracket_data
        if (setsPerMatch > 0 && roundName) {
            try {
                const bracketDataObj = bracketData.bracket_data || bracketData.bracketData || {};
                const rounds = bracketDataObj.rounds || [];
                const roundIndex = rounds.findIndex((r) => r && r.name === roundName);
                
                if (roundIndex !== -1) {
                    // Update the round's setsConfig with the selected sets
                    if (!rounds[roundIndex].setsConfig) {
                        rounds[roundIndex].setsConfig = {};
                    }
                    // Store the selected sets (this will be used by scoreboard)
                    rounds[roundIndex].setsConfig.selectedSets = setsPerMatch;
                    // Store the winner mode (set_based or score_based)
                    rounds[roundIndex].setsConfig.winnerMode = winnerMode;
                    
                    // Update bracket_data in database
                    const updatedBracketData = {
                        ...bracketDataObj,
                        rounds: rounds
                    };
                    
                    await supabaseAdmin
                        .from('event_brackets')
                        .update({
                            bracket_data: updatedBracketData,
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', bracketData.id);
                }
            } catch (updateError) {
                console.error("Failed to update round setsConfig:", updateError);
                // Don't fail the whole operation if sets update fails
            }
        }

        return res.status(200).json({
            success: true,
            message: `Processed matches. Created/Updated: ${createdCount}, Skipped (no ID): ${skippedCount}, Updated (player changes): ${updatedCount}`,
            stats: { createdCount, skippedCount, updatedCount }
        });

    } catch (error) {
        console.error("Generate Matches Error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

// Update selected sets (Best of N) for a specific bracket round without regenerating matches
export const updateRoundSelectedSets = async (req, res) => {
    try {
        const { eventId, categoryId, categoryName, roundName, selectedSets, winnerMode } = req.body || {};

        if (!eventId || !roundName) {
            return res.status(400).json({
                success: false,
                message: "eventId and roundName are required"
            });
        }

        // Allow selectedSets=0 or null to CLEAR the stored value (used after deleting a round)
        const clearMode = selectedSets === 0 || selectedSets === null || selectedSets === undefined;
        const setsNum = clearMode ? 0 : Number(selectedSets);
        if (!clearMode && (!Number.isInteger(setsNum) || setsNum <= 0)) {
            return res.status(400).json({
                success: false,
                message: "selectedSets must be a positive integer (or 0/null to clear)"
            });
        }

        // Fetch bracket for this event/category
        let bracketQuery = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (categoryId && isUuid(categoryId)) {
            bracketQuery = bracketQuery.eq("category_id", categoryId);
        } else if (categoryName) {
            bracketQuery = bracketQuery.eq("category", categoryName);
        }

        const { data: bracketData, error: bracketError } = await bracketQuery.maybeSingle();

        if (bracketError || !bracketData) {
            return res.status(404).json({
                success: false,
                message: "Bracket not found for this event/category"
            });
        }

        const bracketDataObj = bracketData.bracket_data || bracketData.bracketData || {};
        const rounds = bracketDataObj.rounds || [];
        const roundIndex = rounds.findIndex((r) => r && r.name === roundName);

        if (roundIndex === -1) {
            return res.status(404).json({
                success: false,
                message: `Round "${roundName}" not found in bracket`
            });
        }

        if (!rounds[roundIndex].setsConfig) {
            rounds[roundIndex].setsConfig = {};
        }

        const cfg = rounds[roundIndex].setsConfig;

        if (clearMode) {
            // Clear: remove selectedSets so the sets picker shows again
            delete rounds[roundIndex].setsConfig.selectedSets;
        } else {
            if (cfg.minSets && setsNum < cfg.minSets) {
                return res.status(400).json({
                    success: false,
                    message: `selectedSets must be >= minSets (${cfg.minSets})`
                });
            }
            if (cfg.maxSets && setsNum > cfg.maxSets) {
                return res.status(400).json({
                    success: false,
                    message: `selectedSets must be <= maxSets (${cfg.maxSets})`
                });
            }
            // Validate that selectedSets is odd (except for 1 set which is allowed)
            if (setsNum !== 1 && setsNum % 2 !== 1) {
                return res.status(400).json({
                    success: false,
                    message: `selectedSets must be an odd number (1, 3, 5, or 7)`
                });
            }

            rounds[roundIndex].setsConfig.selectedSets = setsNum;
        }

        // Save winnerMode if provided
        if (winnerMode && (winnerMode === 'set_based' || winnerMode === 'score_based' || winnerMode === 'match_based')) {
            rounds[roundIndex].setsConfig.winnerMode = winnerMode;
        }

        const updatedBracketData = {
            ...bracketDataObj,
            rounds
        };

        const { error: updateError } = await supabaseAdmin
            .from("event_brackets")
            .update({
                bracket_data: updatedBracketData,
                updated_at: new Date().toISOString()
            })
            .eq("id", bracketData.id);

        if (updateError) {
            console.error("Failed to update round selectedSets:", updateError);
            return res.status(500).json({
                success: false,
                message: "Failed to update selected sets for round"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Selected sets updated for round",
            bracket: {
                ...bracketData,
                bracket_data: updatedBracketData,
                bracketData: updatedBracketData
            }
        });
    } catch (error) {
        console.error("Update Round Selected Sets Error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * Generate League (round-robin) matches from league blueprint
 * POST /api/admin/matches/generate-league/:eventId/:categoryId
 *
 * - Reads participants from 'leagues' table (dedicated league storage)
 * - Generates all unique pairs (each player vs every other player once)
 * - Inserts into matches table with round_name = 'LEAGUE'
 * - Idempotent: skips matches that already exist for this event/category/round
 */
export const generateLeagueMatches = async (req, res) => {
    const { eventId, categoryId } = req.params;
    const categoryLabel = (req.query && req.query.categoryLabel) || (req.body && req.body.categoryLabel);

    try {
        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({
                success: false,
                message: "Event ID and Category are required"
            });
        }

        // 1. Fetch League config from dedicated 'leagues' table
        // Try multiple matching strategies to find the league config

        // First, fetch all leagues for this event
        const { data: allLeagues, error: fetchAllError } = await supabaseAdmin
            .from('leagues')
            .select('*')
            .eq('event_id', eventId);

        if (fetchAllError) {
            throw fetchAllError;
        }

        // Try to find matching league config using multiple strategies
        let leagueConfig = null;

        if (allLeagues && allLeagues.length > 0) {
            // Strategy 1: Exact category_id match (UUID or string)
            if (categoryId) {
                leagueConfig = allLeagues.find(l => {
                    const lCatId = l.category_id;
                    if (!lCatId) return false;
                    return String(lCatId) === String(categoryId) || lCatId == categoryId;
                });
            }

            // Strategy 2: Exact category_label match
            if (!leagueConfig && categoryLabel) {
                leagueConfig = allLeagues.find(l => {
                    const lLabel = l.category_label;
                    if (!lLabel) return false;
                    // Exact match
                    if (String(lLabel).trim() === String(categoryLabel).trim()) {
                        return true;
                    }
                    // Case-insensitive match
                    if (String(lLabel).toLowerCase().trim() === String(categoryLabel).toLowerCase().trim()) {
                        return true;
                    }
                    return false;
                });
            }

            // Strategy 3: Normalized match (remove gender in parentheses, normalize spacing)
            if (!leagueConfig && categoryLabel) {
                // Normalize function: remove gender in parentheses, lowercase, trim
                const normalizeLabel = (label) => {
                    if (!label) return "";
                    return String(label)
                        .replace(/\s*\(Male|Female|Mixed\)/gi, "") // Remove (Male), (Female), (Mixed)
                        .replace(/\s*-\s*/g, " - ") // Normalize spacing around dashes
                        .toLowerCase()
                        .trim();
                };

                const normalizedSearchLabel = normalizeLabel(categoryLabel);
                leagueConfig = allLeagues.find(l => {
                    const lLabel = l.category_label;
                    if (!lLabel) return false;
                    const normalizedLLabel = normalizeLabel(lLabel);
                    // Exact normalized match
                    if (normalizedLLabel === normalizedSearchLabel) {
                        return true;
                    }
                    // Check if base category name matches (before matchType)
                    const searchBase = normalizedSearchLabel.split(" - ")[0];
                    const labelBase = normalizedLLabel.split(" - ")[0];
                    if (searchBase && labelBase && searchBase === labelBase) {
                        return true;
                    }
                    return false;
                });
            }

            // Strategy 4: Partial match (fallback - most lenient)
            if (!leagueConfig && categoryLabel) {
                const normalizedLabel = String(categoryLabel).toLowerCase().trim();
                leagueConfig = allLeagues.find(l => {
                    const lLabel = l.category_label;
                    if (!lLabel) return false;
                    const normalizedLLabel = String(lLabel).toLowerCase().trim();
                    // Extract base category name (before first " - ")
                    const searchBase = normalizedLabel.split(" - ")[0];
                    const labelBase = normalizedLLabel.split(" - ")[0];
                    // Match if base names are similar
                    if (searchBase && labelBase) {
                        if (searchBase === labelBase ||
                            searchBase.includes(labelBase) ||
                            labelBase.includes(searchBase)) {
                            return true;
                        }
                    }
                    // Also try full string contains
                    return normalizedLLabel.includes(normalizedLabel) || normalizedLabel.includes(normalizedLLabel);
                });
            }
        }

        if (!leagueConfig) {
            // Provide helpful debug info
            const availableCategories = allLeagues?.map(l => ({
                category_id: l.category_id,
                category_label: l.category_label
            })) || [];

            return res.status(404).json({
                success: false,
                message: `League configuration not found. Please configure participants first. Category: ${categoryLabel || categoryId}`,
                debug: {
                    categoryId,
                    categoryLabel,
                    searchedFor: {
                        categoryId: categoryId || null,
                        categoryLabel: categoryLabel || null
                    },
                    availableLeagues: availableCategories,
                    hint: "Make sure you've saved the league configuration with participants before generating matches."
                }
            });
        }

        const participants = Array.isArray(leagueConfig.participants) ? leagueConfig.participants : [];

        if (participants.length === 0) {
            return res.status(400).json({
                success: false,
                message: `League configuration found but no participants configured. Please add participants to category "${leagueConfig.category_label || categoryLabel || categoryId}" before generating matches.`,
                debug: {
                    categoryId,
                    categoryLabel,
                    leagueConfigId: leagueConfig.id,
                    participantsCount: 0
                }
            });
        }

        if (participants.length < 2) {
            return res.status(400).json({
                success: false,
                message: `At least two participants are required to generate league matches. Currently configured: ${participants.length} participant(s).`,
                debug: {
                    categoryId,
                    categoryLabel,
                    participantsCount: participants.length,
                    participants: participants.map(p => ({ id: p.id, name: p.name }))
                }
            });
        }

        // Use category_id from league config (can be UUID or string like "1767354643599")
        // Fallback to categoryId from params if not in config
        const leagueCategoryId = leagueConfig.category_id
            ? String(leagueConfig.category_id)
            : (categoryId ? String(categoryId) : null);

        // 2. Fetch existing LEAGUE matches for this event/category
        // Use category_id from league config (can be string or UUID)
        const matchCategoryId = leagueCategoryId || (categoryId ? String(categoryId) : null);

        // First, fetch all LEAGUE matches for this event (we'll filter by category_id in memory)
        // This handles cases where category_id might be TEXT vs UUID type mismatch
        const { data: allLeagueMatches, error: fetchError } = await supabaseAdmin
            .from('matches')
            .select('*')
            .eq('event_id', eventId)
            .eq('round_name', 'LEAGUE');

        if (fetchError) {
            throw fetchError;
        }

        // Filter by category_id in memory (handles both UUID and string IDs like "1767354643599")
        let existingMatches = allLeagueMatches || [];
        if (matchCategoryId) {
            existingMatches = existingMatches.filter(m => {
                const mCatId = m.category_id;
                if (!mCatId) return false;
                // Use == for type coercion and String() for exact match
                return String(mCatId) === String(matchCategoryId) || mCatId == matchCategoryId;
            });
        }

        // 2.5. Get or create placeholder bracket for league matches
        // League matches need a bracket_id due to NOT NULL constraint, but they don't use actual brackets
        const categoryLabelForBracket = leagueConfig.category_label || categoryLabel || `League - ${categoryId || 'Unknown'}`;

        // Check if any existing LEAGUE matches already have a bracket_id we can reuse
        let placeholderBracketId = null;
        if (existingMatches && existingMatches.length > 0) {
            const firstMatch = existingMatches[0];
            if (firstMatch.bracket_id) {
                placeholderBracketId = firstMatch.bracket_id;
            }
        }

        // If no existing bracket found, try to find or create a placeholder bracket
        if (!placeholderBracketId) {
            let bracketQuery = supabaseAdmin
                .from('event_brackets')
                .select('id')
                .eq('event_id', eventId)
                .eq('round_name', 'LEAGUE_PLACEHOLDER');

            // Try to match by category_id first (only if it's a valid UUID)
            // For string IDs like "1767354643599", we'll match by category label instead
            if (leagueCategoryId && isUuid(leagueCategoryId)) {
                bracketQuery = bracketQuery.eq('category_id', leagueCategoryId);
            } else {
                // Fallback to category label (works for both UUID and string category IDs)
                bracketQuery = bracketQuery.eq('category', categoryLabelForBracket);
            }

            const { data: existingPlaceholder, error: bracketFetchError } = await bracketQuery.maybeSingle();

            if (bracketFetchError && bracketFetchError.code !== "PGRST116") {
                throw bracketFetchError;
            }

            if (existingPlaceholder) {
                placeholderBracketId = existingPlaceholder.id;
            } else {
                // Create placeholder bracket for league matches
                // event_brackets.category_id is UUID type, so only set it if it's a valid UUID
                // For string IDs like "1767354643599", set category_id to null
                const bracketCategoryId = leagueCategoryId && isUuid(leagueCategoryId) ? leagueCategoryId : null;

                const { data: newPlaceholder, error: createBracketError } = await supabaseAdmin
                    .from('event_brackets')
                    .insert({
                        event_id: eventId,
                        category: categoryLabelForBracket,
                        category_id: bracketCategoryId, // Only set if it's a valid UUID
                        round_name: 'LEAGUE_PLACEHOLDER',
                        mode: 'MEDIA', // Use MEDIA mode for placeholder
                        draw_type: 'bracket',
                        bracket_data: {
                            rounds: [],
                            isPlaceholder: true,
                            note: 'Placeholder bracket for league matches'
                        }
                    })
                    .select('id')
                    .single();

                if (createBracketError) {
                    throw createBracketError;
                }

                placeholderBracketId = newPlaceholder.id;
            }
        }

        // Build a set of existing unordered pairs (playerA, playerB) per group
        const existingPairs = new Set();
        (existingMatches || []).forEach((m) => {
            const aId = m.player_a && (m.player_a.id || m.player_a.player_id || m.player_a);
            const bId = m.player_b && (m.player_b.id || m.player_b.player_id || m.player_b);
            const groupKey = (m.player_a && m.player_a.group) || (m.player_b && m.player_b.group) || "A";
            if (!aId || !bId) return;
            const [id1, id2] = [String(aId), String(bId)].sort();
            const key = `${groupKey}__${id1}__${id2}`;
            existingPairs.add(key);
        });

        // 3. Generate all unique pairs i < j within each group
        // OR use customMatches from request body (for team league draws)
        const customMatches = req.body && Array.isArray(req.body.customMatches) ? req.body.customMatches : null;
        const toInsert = [];

        if (customMatches && customMatches.length > 0) {
            // Team League mode: use admin-configured match pairs
            customMatches.forEach((cm) => {
                const groupKey = cm.group || "A";
                const pAId = String(cm.playerAId || cm.player_a_id || "");
                const pBId = String(cm.playerBId || cm.player_b_id || "");
                if (!pAId || !pBId) return;

                // Dedup check
                const [id1, id2] = [pAId, pBId].sort();
                const matchNum = cm.matchNumber || cm.match_number || 0;
                const teamMatchupId = cm.teamMatchupId || "";
                const key = `${groupKey}__${id1}__${id2}__${teamMatchupId}__${matchNum}`;
                if (existingPairs.has(key)) return;

                toInsert.push({
                    event_id: eventId,
                    category_id: matchCategoryId,
                    bracket_id: placeholderBracketId,
                    round_name: 'LEAGUE',
                    player_a: {
                        id: pAId,
                        name: cm.playerAName || cm.player_a_name || pAId,
                        group: groupKey,
                        ...(cm.teamAId ? { teamId: cm.teamAId, teamName: cm.teamAName || "" } : {}),
                        ...(teamMatchupId ? { teamMatchupId, matchNumber: matchNum } : {})
                    },
                    player_b: {
                        id: pBId,
                        name: cm.playerBName || cm.player_b_name || pBId,
                        group: groupKey,
                        ...(cm.teamBId ? { teamId: cm.teamBId, teamName: cm.teamBName || "" } : {}),
                        ...(teamMatchupId ? { teamMatchupId, matchNumber: matchNum } : {})
                    },
                    status: 'SCHEDULED',
                    score: null,
                    winner: null
                });

                existingPairs.add(key);
            });
        } else {
            // Normal League mode: auto-generate round-robin pairs
            const groupsMap = new Map();
            participants.forEach((p) => {
                const rawGroup = p.group || p.group_id || p.groupLabel || null;
                const groupKey = rawGroup ? String(rawGroup).trim().toUpperCase() : "A";
                if (!groupsMap.has(groupKey)) groupsMap.set(groupKey, []);
                groupsMap.get(groupKey).push(p);
            });

            // Hard safety check: block oversized single-group round-robin generation.
            // n(n-1)/2 growth creates massive match counts for large groups (e.g., 64 => 2016).
            const oversizedGroups = [];
            for (const [groupKey, groupParticipants] of groupsMap.entries()) {
                if (groupParticipants.length > MAX_ROUND_ROBIN_GROUP_SIZE) {
                    oversizedGroups.push({ groupKey, size: groupParticipants.length });
                }
            }

            if (oversizedGroups.length > 0) {
                const groupSummary = oversizedGroups
                    .map((g) => `${g.groupKey} (${g.size})`)
                    .join(", ");

                return res.status(400).json({
                    success: false,
                    message: `Cannot generate league matches. Oversized group(s): ${groupSummary}. Maximum ${MAX_ROUND_ROBIN_GROUP_SIZE} players per group is allowed.`
                });
            }

            for (const [groupKey, groupParticipants] of groupsMap.entries()) {
                const n = groupParticipants.length;
                for (let i = 0; i < n; i++) {
                    const p1 = groupParticipants[i];
                    const p1Id = p1 && p1.id;
                    if (!p1Id) continue;

                    for (let j = i + 1; j < n; j++) {
                        const p2 = groupParticipants[j];
                        const p2Id = p2 && p2.id;
                        if (!p2Id) continue;

                        const [id1, id2] = [String(p1Id), String(p2Id)].sort();
                        const key = `${groupKey}__${id1}__${id2}`;

                        if (existingPairs.has(key)) {
                            continue;
                        }

                        toInsert.push({
                            event_id: eventId,
                            category_id: matchCategoryId,
                            bracket_id: placeholderBracketId,
                            round_name: 'LEAGUE',
                            player_a: { id: String(p1Id), name: p1.name, group: groupKey },
                            player_b: { id: String(p2Id), name: p2.name, group: groupKey },
                            status: 'SCHEDULED',
                            score: null,
                            winner: null
                        });

                        existingPairs.add(key);
                    }
                }
            }
        }

        if (toInsert.length === 0) {
            return res.status(200).json({
                success: true,
                message: "League matches already generated for all participant pairs",
                createdCount: 0,
                skippedCount: existingMatches ? existingMatches.length : 0
            });
        }

        // 4. Determine starting match_index to append new matches
        // CRITICAL FIX: Filter by category_id to prevent conflicts with other league categories
        let startIndex = 0;

        // Use existingMatches (already filtered by category) to get max index
        // This is more efficient and ensures we only look at matches for this category
        if (existingMatches && existingMatches.length > 0) {
            const maxIndex = Math.max(...existingMatches.map(m => m.match_index || 0));
            startIndex = maxIndex + 1;
        } else {
            // No existing matches, check database with category filter as fallback
            // This handles edge case where existingMatches might be empty but matches exist
            let maxIndexQuery = supabaseAdmin
                .from('matches')
                .select('match_index, category_id')
                .eq('event_id', eventId)
                .eq('round_name', 'LEAGUE');

            const { data: allLeagueMatchesForIndex } = await maxIndexQuery;

            if (allLeagueMatchesForIndex && matchCategoryId) {
                // Filter by category_id in memory
                const categoryMatches = allLeagueMatchesForIndex.filter(m => {
                    const mCatId = m.category_id;
                    if (!mCatId) return false;
                    return String(mCatId) === String(matchCategoryId) || mCatId == matchCategoryId;
                });

                if (categoryMatches.length > 0) {
                    const maxIndex = Math.max(...categoryMatches.map(m => m.match_index || 0));
                    startIndex = maxIndex + 1;
                }
            } else if (allLeagueMatchesForIndex && allLeagueMatchesForIndex.length > 0) {
                // No category filter available, use all matches (fallback)
                const maxIndex = Math.max(...allLeagueMatchesForIndex.map(m => m.match_index || 0));
                startIndex = maxIndex + 1;
            }
        }

        const payloadWithIndex = toInsert.map((m, idx) => ({
            ...m,
            match_index: startIndex + idx
        }));

        const { error: insertError } = await supabaseAdmin
            .from('matches')
            .insert(payloadWithIndex);

        if (insertError) {
            throw insertError;
        }

        return res.status(201).json({
            success: true,
            message: `League matches generated. Created: ${payloadWithIndex.length}`,
            createdCount: payloadWithIndex.length
        });
    } catch (error) {
        console.error("Generate League Matches Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to generate league matches"
        });
    }
};

// Create Single Match Manually
export const createMatch = async (req, res) => {
    const { event_id, category_id, category_name, round_name, player_a, player_b, bracket_id: providedBracketId } = req.body;

    if (!event_id || !category_id || !round_name) {
        return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    try {
        let bracket_id = providedBracketId;

        // Lookup bracket_id if not provided
        // For manual matches, we can create matches even without a bracket
        // We'll use the first available bracket or create a placeholder reference
        if (!bracket_id) {
            let bracketData = null;
            let bracketError = null;

            if (isUuid(category_id)) {
                // Query by UUID category_id - get all brackets for this category
                const { data, error } = await supabaseAdmin
                    .from('event_brackets')
                    .select('id, mode')
                    .eq('event_id', event_id)
                    .eq('category_id', category_id)
                    .order('created_at', { ascending: false });

                if (!error && data && data.length > 0) {
                    // Prefer BRACKET mode, but accept any bracket
                    bracketData = data.find(b => b.mode === 'BRACKET') || data[0];
                } else {
                    bracketError = error;
                }
            } else if (category_name) {
                // Query by category label/name - get all brackets for this category
                const { data, error } = await supabaseAdmin
                    .from('event_brackets')
                    .select('id, mode')
                    .eq('event_id', event_id)
                    .eq('category', category_name)
                    .order('created_at', { ascending: false });

                if (!error && data && data.length > 0) {
                    // Prefer BRACKET mode, but accept any bracket
                    bracketData = data.find(b => b.mode === 'BRACKET') || data[0];
                } else {
                    bracketError = error;
                }
            } else {
                return res.status(400).json({
                    success: false,
                    message: "Non-UUID Category ID requires 'category_name' field"
                });
            }

            // If no bracket found, try to find ANY bracket for this event (even different category)
            // This is needed because bracket_id has NOT NULL constraint
            if (bracketData) {
                bracket_id = bracketData.id;
            } else {
                // Try to find any bracket for this event to use as reference
                const { data: anyBrackets, error: anyBracketError } = await supabaseAdmin
                    .from('event_brackets')
                    .select('id')
                    .eq('event_id', event_id)
                    .limit(1);

                if (!anyBracketError && anyBrackets && anyBrackets.length > 0) {
                    bracket_id = anyBrackets[0].id;
                } else {
                    // Last resort: Create a minimal placeholder bracket for manual matches
                    const { data: placeholderBracket, error: placeholderError } = await supabaseAdmin
                        .from('event_brackets')
                        .insert({
                            event_id: event_id,
                            category: category_name || `Manual Scoreboard - ${category_id}`,
                            category_id: isUuid(category_id) ? category_id : null,
                            mode: 'MEDIA', // Use MEDIA mode for placeholder
                            draw_type: 'bracket',
                            bracket_data: { rounds: [] },
                            round_name: 'Manual'
                        })
                        .select('id')
                        .single();

                    if (!placeholderError && placeholderBracket) {
                        bracket_id = placeholderBracket.id;
                    } else {
                        return res.status(500).json({
                            success: false,
                            message: "Could not create match. No bracket found and failed to create placeholder."
                        });
                    }
                }
            }
        }

        // Get Max Index for this round
        // If no bracket_id, we'll use event_id + category_id + round_name to get max index
        let nextIndex = 0;
        if (bracket_id) {
            const { data: maxIndexData } = await supabaseAdmin
                .from('matches')
                .select('match_index')
                .eq('bracket_id', bracket_id)
                .eq('round_name', round_name)
                .order('match_index', { ascending: false })
                .limit(1);
            nextIndex = (maxIndexData && maxIndexData.length > 0) ? maxIndexData[0].match_index + 1 : 0;
        } else {
            // For matches without bracket_id, get max index by event + category + round
            const { data: maxIndexData } = await supabaseAdmin
                .from('matches')
                .select('match_index')
                .eq('event_id', event_id)
                .eq('category_id', category_id)
                .eq('round_name', round_name)
                .order('match_index', { ascending: false })
                .limit(1);
            nextIndex = (maxIndexData && maxIndexData.length > 0) ? maxIndexData[0].match_index + 1 : 0;
        }

        const insertPayload = {
            event_id,
            category_id,
            round_name,
            match_index: nextIndex,
            player_a: player_a || {},
            player_b: player_b || {},
            status: 'SCHEDULED'
        };

        // Only include bracket_id if it exists (allows manual matches without brackets)
        if (bracket_id) {
            insertPayload.bracket_id = bracket_id;
        }

        const { data, error } = await supabaseAdmin
            .from('matches')
            .insert(insertPayload)
            .select()
            .single();

        if (error) {
            console.error("Create Match Insert Error:", error);
            throw error;
        }

        return res.status(201).json({ success: true, match: data });

    } catch (error) {
        console.error("Create Match Error:", error);
        return res.status(500).json({ success: false, message: "Failed to create match" });
    }
};

// Create many matches in a single API call
export const createMatchesBulk = async (req, res) => {
    const matches = Array.isArray(req.body?.matches) ? req.body.matches : [];

    if (matches.length === 0) {
        return res.status(400).json({ success: false, message: "matches[] is required" });
    }

    try {
        const keyMeta = new Map();

        const resolveBracketId = async ({ event_id, category_id, category_name, providedBracketId }) => {
            if (providedBracketId) return providedBracketId;

            let bracketData = null;

            if (isUuid(category_id)) {
                const { data, error } = await supabaseAdmin
                    .from('event_brackets')
                    .select('id, mode')
                    .eq('event_id', event_id)
                    .eq('category_id', category_id)
                    .order('created_at', { ascending: false });

                if (!error && data && data.length > 0) {
                    bracketData = data.find(b => b.mode === 'BRACKET') || data[0];
                }
            } else if (category_name) {
                const { data, error } = await supabaseAdmin
                    .from('event_brackets')
                    .select('id, mode')
                    .eq('event_id', event_id)
                    .eq('category', category_name)
                    .order('created_at', { ascending: false });

                if (!error && data && data.length > 0) {
                    bracketData = data.find(b => b.mode === 'BRACKET') || data[0];
                }
            }

            if (bracketData?.id) return bracketData.id;

            const { data: anyBrackets } = await supabaseAdmin
                .from('event_brackets')
                .select('id')
                .eq('event_id', event_id)
                .limit(1);

            if (anyBrackets && anyBrackets.length > 0) {
                return anyBrackets[0].id;
            }

            const { data: placeholderBracket, error: placeholderError } = await supabaseAdmin
                .from('event_brackets')
                .insert({
                    event_id: event_id,
                    category: category_name || `Manual Scoreboard - ${category_id}`,
                    category_id: isUuid(category_id) ? category_id : null,
                    mode: 'MEDIA',
                    draw_type: 'bracket',
                    bracket_data: { rounds: [] },
                    round_name: 'Manual'
                })
                .select('id')
                .single();

            if (placeholderError || !placeholderBracket?.id) {
                throw new Error("Could not resolve bracket_id for bulk create");
            }

            return placeholderBracket.id;
        };

        for (const m of matches) {
            const event_id = m?.event_id;
            const category_id = m?.category_id;
            const category_name = m?.category_name;
            const round_name = m?.round_name;

            if (!event_id || !category_id || !round_name) {
                return res.status(400).json({
                    success: false,
                    message: "Each match requires event_id, category_id, and round_name"
                });
            }

            const key = `${event_id}::${category_id}::${round_name}`;
            if (!keyMeta.has(key)) {
                const bracket_id = await resolveBracketId({
                    event_id,
                    category_id,
                    category_name,
                    providedBracketId: m?.bracket_id
                });

                const { data: maxIndexData } = await supabaseAdmin
                    .from('matches')
                    .select('match_index')
                    .eq('bracket_id', bracket_id)
                    .eq('round_name', round_name)
                    .order('match_index', { ascending: false })
                    .limit(1);

                const nextIndex = (maxIndexData && maxIndexData.length > 0)
                    ? (Number(maxIndexData[0].match_index) || 0) + 1
                    : 0;

                keyMeta.set(key, { bracket_id, nextIndex });
            }
        }

        const bulkPayload = matches.map((m) => {
            const key = `${m.event_id}::${m.category_id}::${m.round_name}`;
            const meta = keyMeta.get(key);
            const match_index = meta.nextIndex;
            meta.nextIndex += 1;

            return {
                event_id: m.event_id,
                category_id: m.category_id,
                bracket_id: meta.bracket_id,
                round_name: m.round_name,
                match_index,
                player_a: m.player_a || {},
                player_b: m.player_b || {},
                status: 'SCHEDULED'
            };
        });

        const { data, error } = await supabaseAdmin
            .from('matches')
            .insert(bulkPayload)
            .select();

        if (error) {
            console.error("Bulk Create Matches Insert Error:", error);
            throw error;
        }

        return res.status(201).json({
            success: true,
            createdCount: Array.isArray(data) ? data.length : 0,
            matches: data || []
        });
    } catch (error) {
        console.error("Bulk Create Matches Error:", error);
        return res.status(500).json({ success: false, message: "Failed to create matches in bulk" });
    }
};

// Helper: get effective player_a/player_b for a match (from match row or from bracket when empty)
// Returns null for players that don't exist (never returns {} empty object)
// allMatchesByBracketId is an optional map of bracket_match_id -> DB match row (used to resolve
// winners from previous rounds when bracket_data.winner is missing or stale).
const getMatchPlayers = (matchRow, bracketDataObj, allMatchesByBracketId = null) => {
    const hasValidPlayer = (p) => {
        if (!p) return false;
        if (typeof p === 'string' || typeof p === 'number') return String(p).trim().length > 0;
        if (typeof p === 'object') {
            // Empty object {} is not valid
            if (Object.keys(p).length === 0) return false;
            // Must have id or player_id
            return !!(p.id || p.player_id);
        }
        return false;
    };
    
    // If match row already has valid players, use them
    if (hasValidPlayer(matchRow.player_a) && hasValidPlayer(matchRow.player_b)) {
        return { playerA: matchRow.player_a, playerB: matchRow.player_b };
    }
    
    // Try to get from bracket if bracket_match_id exists
    if (bracketDataObj && matchRow.bracket_match_id) {
        const rounds = bracketDataObj.rounds || [];
        const bid = String(matchRow.bracket_match_id).trim();
        let foundMatch = null;
        
        for (const round of rounds) {
            const ms = round.matches || [];
            for (const m of ms) {
                if (!m) continue;
                // Try multiple ID fields: id, matchId, match_id
                const matchId = String(m.id || m.matchId || m.match_id || '').trim();
                if (matchId && matchId === bid) {
                    foundMatch = m;
                    break;
                }
            }
            if (foundMatch) break;
        }
        
        if (foundMatch) {
            // Helper: resolve the winner feeding into a specific side ("player1"/"player2")
            // for this bracket match, by looking at feeder matches with winnerTo === this id
            // and winnerToSlot === sideKey.
            // Prefer DB winners (via allMatchesByBracketId) and fall back to bracket_data.winner.
            const resolveWinnerForSide = (sideKey) => {
                const targetId = String(foundMatch.id || foundMatch.matchId || foundMatch.match_id || "").trim();
                if (!targetId) return null;
                const normId = (val) =>
                    !val
                        ? ""
                        : String(typeof val === "object" ? (val.id || val.player_id || val) : val).trim();

                for (const round of rounds) {
                    const ms = round.matches || [];
                    for (const m of ms) {
                        if (!m) continue;
                        const toId = String(m.winnerTo || "").trim();
                        const toSlot = String(m.winnerToSlot || "").trim().toLowerCase();
                        if (!toId || toId !== targetId) continue;

                        const sideMatch = toSlot === String(sideKey || "").toLowerCase();
                        if (!sideMatch) continue;

                        const p1 = m.player1;
                        const p2 = m.player2;

                        // 1) Primary: use DB winner for this feeder, if available
                        if (allMatchesByBracketId) {
                            const feederKey = String(m.id || m.matchId || m.match_id || "").trim();
                            const dbFeeder = feederKey ? allMatchesByBracketId[feederKey] : null;
                            if (dbFeeder && dbFeeder.winner) {
                                let winnerId = "";
                                const w = dbFeeder.winner;
                                if (typeof w === "object") {
                                    winnerId = normId(w);
                                } else {
                                    const raw = String(w).trim();
                                    const lower = raw.toLowerCase();
                                    if (lower === "player1" || lower === "a" || lower === "player_a") {
                                        winnerId = normId(p1);
                                    } else if (lower === "player2" || lower === "b" || lower === "player_b") {
                                        winnerId = normId(p2);
                                    } else {
                                        winnerId = raw;
                                    }
                                }

                                if (winnerId) {
                                    if (p1 && normId(p1) === winnerId && hasValidPlayer(p1)) return p1;
                                    if (p2 && normId(p2) === winnerId && hasValidPlayer(p2)) return p2;

                                    // As a last resort, scan all bracket matches for a player whose id matches winnerId.
                                    for (const r of rounds) {
                                        const ms2 = r.matches || [];
                                        for (const bm of ms2) {
                                            if (!bm) continue;
                                            if (bm.player1 && normId(bm.player1) === winnerId && hasValidPlayer(bm.player1)) {
                                                return bm.player1;
                                            }
                                            if (bm.player2 && normId(bm.player2) === winnerId && hasValidPlayer(bm.player2)) {
                                                return bm.player2;
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // 2) Secondary: fall back to bracket_data.winner if present
                        if (m.winner) {
                            const wNorm = String(m.winner).trim().toLowerCase();
                            let candidate = null;
                            if (wNorm === "player1" || wNorm === "a" || wNorm === "player_a") {
                                candidate = m.player1;
                            } else if (wNorm === "player2" || wNorm === "b" || wNorm === "player_b") {
                                candidate = m.player2;
                            }
                            if (hasValidPlayer(candidate)) {
                                return candidate;
                            }
                        }
                    }
                }
                return null;
            };

            // Found the match in bracket - start from its players and DB row
            let p1 = hasValidPlayer(foundMatch.player1) ? foundMatch.player1 : (hasValidPlayer(matchRow.player_a) ? matchRow.player_a : null);
            let p2 = hasValidPlayer(foundMatch.player2) ? foundMatch.player2 : (hasValidPlayer(matchRow.player_b) ? matchRow.player_b : null);

            // If a side is still missing, try to resolve from feeder winners so that
            // later‑round matches become playable once earlier winners are known.
            if (!p1) {
                const feederWinnerForP1 = resolveWinnerForSide("player1");
                if (hasValidPlayer(feederWinnerForP1)) {
                    p1 = feederWinnerForP1;
                }
            }
            if (!p2) {
                const feederWinnerForP2 = resolveWinnerForSide("player2");
                if (hasValidPlayer(feederWinnerForP2)) {
                    p2 = feederWinnerForP2;
                }
            }
            
            // Debug logging
            if (!p1 || !p2) {
                console.warn(`[getMatchPlayers] Found bracket match ${bid} but players are missing:`, {
                    bracketPlayer1: foundMatch.player1,
                    bracketPlayer2: foundMatch.player2,
                    dbPlayerA: matchRow.player_a,
                    dbPlayerB: matchRow.player_b
                });
            }
            
            return { playerA: p1, playerB: p2 };
        } else {
            // Debug: log what we're looking for vs what's available
            const allMatchIds = [];
            for (const round of rounds) {
                const ms = round.matches || [];
                for (const m of ms) {
                    if (m) {
                        allMatchIds.push(String(m.id || m.matchId || m.match_id || 'unknown').trim());
                    }
                }
            }
            console.warn(`[getMatchPlayers] Could not find bracket match with id "${bid}". Available match IDs:`, allMatchIds.slice(0, 10));
        }
    }
    
    // Fallback: return from match row if valid, otherwise null
    return {
        playerA: hasValidPlayer(matchRow.player_a) ? matchRow.player_a : null,
        playerB: hasValidPlayer(matchRow.player_b) ? matchRow.player_b : null
    };
};

// Update Match Score & Status
export const updateMatchScore = async (req, res) => {
    const { matchId } = req.params;
    const { score, status, winner } = req.body;

    try {
        // Fetch current match to get player data
        const { data: currentMatch } = await supabaseAdmin.from('matches').select('*').eq('id', matchId).single();

        if (!currentMatch) {
            return res.status(404).json({ success: false, message: "Match not found" });
        }

        const updatePayload = {
            updated_at: new Date().toISOString()
        };

        // Use explicit undefined checks so null values can clear fields (score=null clears the score)
        if (score !== undefined) updatePayload.score = score;
        if (status) updatePayload.status = status;
        if (winner !== undefined) updatePayload.winner = winner;

        // CRITICAL: When match has empty player_a/player_b, fill from bracket so winner can be computed and stored correctly.
        // This ensures scores from scoreboard are stored perfectly with correct player references and winner.
        let bracketDataObj = null;
        if (currentMatch.bracket_id && currentMatch.bracket_match_id) {
            const { data: bracketRow } = await supabaseAdmin
                .from('event_brackets')
                .select('bracket_data, draw_data')
                .eq('id', currentMatch.bracket_id)
                .single();
            if (bracketRow) {
                // Prefer new normalized column names: bracket_data, then draw_data
                bracketDataObj = bracketRow.bracket_data || bracketRow.draw_data || {};
                const { playerA, playerB } = getMatchPlayers(currentMatch, bracketDataObj);
                // Only update if we got valid players from bracket (not null, not empty object)
                const hasValidA = playerA && typeof playerA === 'object' && (playerA.id || playerA.player_id) && Object.keys(playerA).length > 0;
                const hasValidB = playerB && typeof playerB === 'object' && (playerB.id || playerB.player_id) && Object.keys(playerB).length > 0;
                const needA = !currentMatch.player_a || (typeof currentMatch.player_a === 'object' && Object.keys(currentMatch.player_a).length === 0);
                const needB = !currentMatch.player_b || (typeof currentMatch.player_b === 'object' && Object.keys(currentMatch.player_b).length === 0);
                if (needA && hasValidA) {
                    updatePayload.player_a = playerA;
                }
                if (needB && hasValidB) {
                    updatePayload.player_b = playerB;
                }
            }
        }

        // Resolve effective players for winner calculation (use updatePayload if we just set them)
        const effectivePlayerA = updatePayload.player_a ?? currentMatch.player_a;
        const effectivePlayerB = updatePayload.player_b ?? currentMatch.player_b;
        
        // Helper to extract valid player id (never return empty object)
        const getPlayerId = (player) => {
            if (!player) return null;
            if (typeof player === 'string' || typeof player === 'number') return String(player).trim() || null;
            if (typeof player === 'object') {
                if (Object.keys(player).length === 0) return null; // Empty object {}
                return player.id || player.player_id || null;
            }
            return null;
        };

        // IMPORTANT: Do NOT auto-calculate winner or auto-set status on score update
        // Winners are calculated ONLY during finalization (finalizeRoundMatches endpoint)
        // This allows admin to freely edit scores without premature locking

        // CRITICAL: When status is COMPLETED, always compute winner from score if missing or invalid.
        // This ensures scores from scoreboard result in proper winner storage (never {}).
        // Check if winner is missing or invalid (empty object, null, undefined)
        const hasValidWinner = updatePayload.winner && 
            (typeof updatePayload.winner === 'string' || typeof updatePayload.winner === 'number' ||
             (typeof updatePayload.winner === 'object' && Object.keys(updatePayload.winner).length > 0 && (updatePayload.winner.id || updatePayload.winner.player_id)));
        
        if (status === 'COMPLETED' && !hasValidWinner) {
            const finalScore = score || currentMatch.score;
            // Determine winnerMode: prefer explicit request body, then score payload, then bracket config
            const requestWinnerMode = req.body?.winnerMode || finalScore?.winnerMode || null;
            
            if (finalScore) {
                // Check if score uses sets format
                if (Array.isArray(finalScore.sets) && finalScore.sets.length > 0) {
                    // Sets-based scoring - get setsPerMatch and winnerMode from bracket round's setsConfig
                    let categorySetsPerMatch = 1; // Default to 1 if not configured
                    let effectiveWinnerMode = requestWinnerMode || 'set_based';
                    try {
                        // Get from bracket round's setsConfig
                        if (currentMatch.round_name && currentMatch.bracket_id) {
                            if (!bracketDataObj) {
                                const { data: bracketData } = await supabaseAdmin
                                    .from('event_brackets')
                                    .select('bracket_data, draw_data')
                                    .eq('id', currentMatch.bracket_id)
                                    .single();
                                // Prefer bracket_data, then draw_data
                                bracketDataObj = bracketData?.bracket_data || bracketData?.draw_data || {};
                            }
                            const rounds = bracketDataObj.rounds || [];
                            const round = rounds.find((r) => r && r.name === currentMatch.round_name);
                            if (round && round.setsConfig) {
                                if (round.setsConfig.selectedSets) {
                                    categorySetsPerMatch = round.setsConfig.selectedSets;
                                }
                                // Read winnerMode from bracket setsConfig if not provided in request
                                if (!requestWinnerMode && round.setsConfig.winnerMode) {
                                    effectiveWinnerMode = round.setsConfig.winnerMode;
                                }
                            }
                        }
                    } catch (err) {
                        console.error("Failed to fetch setsPerMatch from bracket round:", err);
                    }

                    // Fallback: if bracket round config didn't provide setsPerMatch (e.g., LEAGUE matches),
                    // use the request body setsPerMatch or infer from actual score data
                    categorySetsPerMatch = resolveSetsPerMatch({
                        configuredSets: categorySetsPerMatch,
                        requestSets: req.body?.setsPerMatch,
                        observedSetsLength: Array.isArray(finalScore.sets) ? finalScore.sets.length : 0,
                    });

                    // Calculate set wins and total points
                    let player1SetsWon = 0;
                    let player2SetsWon = 0;
                    let player1TotalPoints = 0;
                    let player2TotalPoints = 0;
                    const setsToWin = Math.ceil(categorySetsPerMatch / 2);

                    for (const set of finalScore.sets) {
                        const p1Score = parseInt(set.player1 || 0);
                        const p2Score = parseInt(set.player2 || 0);
                        player1TotalPoints += p1Score;
                        player2TotalPoints += p2Score;
                        if (p1Score > p2Score) player1SetsWon++;
                        else if (p2Score > p1Score) player2SetsWon++;
                    }

                    // Extract valid player ids (never use empty objects)
                    const winnerIdA = getPlayerId(effectivePlayerA);
                    const winnerIdB = getPlayerId(effectivePlayerB);
                    const isLeagueMatch = String(currentMatch.round_name || '').trim().toUpperCase() === 'LEAGUE';
                    
                    if (!winnerIdA || !winnerIdB) {
                        console.warn(`Cannot compute winner for match ${matchId}: missing valid player_a or player_b. player_a:`, effectivePlayerA, 'player_b:', effectivePlayerB);
                        // Don't set winner if we can't determine it - let admin fix player_a/player_b first
                    } else if (effectiveWinnerMode === 'score_based') {
                        // Score-based: winner decided by total points across ALL sets
                        // Tiebreak: player who won more sets
                        if (player1TotalPoints > player2TotalPoints) {
                            updatePayload.winner = winnerIdA;
                        } else if (player2TotalPoints > player1TotalPoints) {
                            updatePayload.winner = winnerIdB;
                        } else {
                            // Total points tied - use set wins as tiebreak
                            if (player1SetsWon > player2SetsWon) {
                                updatePayload.winner = winnerIdA;
                            } else if (player2SetsWon > player1SetsWon) {
                                updatePayload.winner = winnerIdB;
                            } else {
                                updatePayload.winner = isLeagueMatch ? null : winnerIdA;
                            }
                        }
                    } else {
                        // Set-based (default): first to win majority of sets
                        if (player1SetsWon >= setsToWin) {
                            updatePayload.winner = winnerIdA;
                        } else if (player2SetsWon >= setsToWin) {
                            updatePayload.winner = winnerIdB;
                        } else {
                            const allSetsPlayed = Array.isArray(finalScore.sets)
                                && finalScore.sets.length >= categorySetsPerMatch;

                            // League: if majority is not reached, only resolve by set lead when all configured
                            // sets are actually played; otherwise treat as unresolved (draw/null) instead of
                            // prematurely assigning winner by partial set lead.
                            if (isLeagueMatch && !allSetsPlayed) {
                                updatePayload.winner = null;
                            } else if (player1SetsWon > player2SetsWon) {
                                updatePayload.winner = winnerIdA;
                            } else if (player2SetsWon > player1SetsWon) {
                                updatePayload.winner = winnerIdB;
                            } else {
                                updatePayload.winner = isLeagueMatch ? null : winnerIdA;
                            }
                        }
                    }
                } else {
                    // Legacy format: { player1: X, player2: Y }
                    const p1Score = parseInt(finalScore.player1 || finalScore.player_a || 0);
                    const p2Score = parseInt(finalScore.player2 || finalScore.player_b || 0);
                    const winnerIdA = getPlayerId(effectivePlayerA);
                    const winnerIdB = getPlayerId(effectivePlayerB);
                    
                    if (!winnerIdA || !winnerIdB) {
                        console.warn(`Cannot compute winner for match ${matchId}: missing valid player_a or player_b. player_a:`, effectivePlayerA, 'player_b:', effectivePlayerB);
                        // Don't set winner if we can't determine it
                    } else {
                        if (p1Score > p2Score) {
                            updatePayload.winner = winnerIdA;
                        } else if (p2Score > p1Score) {
                            updatePayload.winner = winnerIdB;
                        } else {
                            const isLeagueMatch = currentMatch.round_name === 'LEAGUE';
                            updatePayload.winner = isLeagueMatch ? null : winnerIdA;
                        }
                    }
                }
            }
        }

        const { data, error } = await supabaseAdmin
            .from('matches')
            .update(updatePayload)
            .eq('id', matchId)
            .select()
            .single();

        if (error) throw error;

        return res.status(200).json({ success: true, match: data });

    } catch (error) {
        console.error("Update Score Error:", error);
        return res.status(500).json({ success: false, message: "Failed to update score" });
    }
};

// Finalize all matches in a round (calculate winners and set status to COMPLETED)
export const finalizeRoundMatches = async (req, res) => {
    const { eventId } = req.params;
    const { categoryId, categoryName, roundName, matches, winnerMode: requestWinnerMode } = req.body;

    if (!eventId || !roundName || !matches || !Array.isArray(matches) || matches.length === 0) {
        return res.status(400).json({
            success: false,
            message: "Event ID, round name, and matches array are required"
        });
    }

    try {
        // Validate all matches exist and belong to this event/category/round
        // CRITICAL: Filter by event_id, category_id, and round_name to ensure proper isolation
        const matchIds = matches.map(m => m.matchId);
        let validationQuery = supabaseAdmin
            .from('matches')
            .select('*')
            .eq('event_id', eventId)
            .eq('round_name', roundName)
            .in('id', matchIds);

        // Filter by categoryId if provided (CRITICAL for multi-category events)
        if (categoryId) {
            if (isUuid(categoryId)) {
                validationQuery = validationQuery.eq('category_id', categoryId);
            } else {
                validationQuery = validationQuery.eq('category_id', categoryId);
            }
        }

        const { data: existingMatches, error: fetchError } = await validationQuery;

        if (fetchError) {
            throw fetchError;
        }

        if (!existingMatches || existingMatches.length !== matchIds.length) {
            return res.status(400).json({
                success: false,
                message: "Some matches not found or don't belong to this event/category/round"
            });
        }

        // Additional validation: Ensure all matches belong to the correct category
        if (categoryId && existingMatches.length > 0) {
            const mismatchedMatches = existingMatches.filter(m => {
                const matchCategoryId = m.category_id;
                return matchCategoryId != categoryId && String(matchCategoryId) !== String(categoryId);
            });

            if (mismatchedMatches.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: `Some matches belong to a different category. Expected: ${categoryId}`
                });
            }
        }

        // Get setsPerMatch, winnerMode, and bracket data (for enriching empty player_a/player_b)
        // IMPORTANT: Fetch bracket data even without roundName - we need it for player lookup
        let categorySetsPerMatch = 1; // Default to 1 set if not configured
        let categoryWinnerMode = requestWinnerMode || 'set_based'; // Default to set_based
        let bracketDataObjForFinalize = null;
        try {
            // Always try to fetch bracket data if we have eventId and category info
            let bracketQuery = supabaseAdmin
                .from('event_brackets')
                .select('id, bracket_data, draw_data')
                .eq('event_id', eventId)
                .eq('mode', 'BRACKET');
            if (categoryId && isUuid(categoryId)) {
                bracketQuery = bracketQuery.eq('category_id', categoryId);
            } else if (categoryName) {
                bracketQuery = bracketQuery.eq('category', categoryName);
            }
            const { data: bracketData, error: bracketFetchError } = await bracketQuery.maybeSingle();
            if (bracketFetchError) {
                console.error("[Finalize] Error fetching bracket:", bracketFetchError);
            } else if (bracketData) {
                // Try bracket_data first, then draw_data
                bracketDataObjForFinalize = bracketData.bracket_data || bracketData.draw_data || {};
                const rounds = bracketDataObjForFinalize.rounds || [];
                console.log(`[Finalize] Fetched bracket with ${rounds.length} rounds:`, rounds.map(r => r.name));
                
                // If roundName provided, try to get setsPerMatch and winnerMode from that specific round
                if (roundName) {
                    // Normalize round name comparison (case-insensitive, trim whitespace)
                    const normalizedRoundName = String(roundName || '').trim().toLowerCase();
                    const round = rounds.find((r) => {
                        if (!r || !r.name) return false;
                        return String(r.name).trim().toLowerCase() === normalizedRoundName;
                    });
                    if (round && round.setsConfig) {
                        if (round.setsConfig.selectedSets) {
                            categorySetsPerMatch = round.setsConfig.selectedSets;
                        }
                        // Read winnerMode from bracket setsConfig if not provided in request
                        if (!requestWinnerMode && round.setsConfig.winnerMode) {
                            categoryWinnerMode = round.setsConfig.winnerMode;
                        }
                    }
                }
            } else {
                console.warn(`[Finalize] No bracket found for event ${eventId}, category: ${categoryId || categoryName}`);
            }
        } catch (err) {
            console.error("[Finalize] Exception fetching bracket:", err);
        }

        // Fallback: if bracket config didn't provide setsPerMatch (e.g., LEAGUE matches),
        // use the request body setsPerMatch
        categorySetsPerMatch = resolveSetsPerMatch({
            configuredSets: categorySetsPerMatch,
            requestSets: req.body?.setsPerMatch,
        });

        // Helper to extract valid player id (never return empty object) - same as in updateMatchScore
        const getPlayerId = (player) => {
            if (!player) return null;
            if (typeof player === 'string' || typeof player === 'number') return String(player).trim() || null;
            if (typeof player === 'object') {
                if (Object.keys(player).length === 0) return null; // Empty object {}
                return player.id || player.player_id || null;
            }
            return null;
        };

        // Build a lookup of all DB matches for this bracket by bracket_match_id so we can
        // resolve winners for feeder matches even when bracket_data.winner is missing.
        let allMatchesByBracketId = {};
        try {
            let allMatchesQuery = supabaseAdmin
                .from('matches')
                .select('*')
                .eq('event_id', eventId);

            if (categoryId) {
                allMatchesQuery = allMatchesQuery.eq('category_id', categoryId);
            }

            // Limit to the same bracket as the matches we are finalizing, when possible.
            const sampleMatch = existingMatches[0];
            if (sampleMatch && sampleMatch.bracket_id) {
                allMatchesQuery = allMatchesQuery.eq('bracket_id', sampleMatch.bracket_id);
            }

            const { data: allMatches, error: allMatchesError } = await allMatchesQuery;
            if (allMatchesError) {
                console.error("[Finalize] Failed to fetch all matches for bracket winner resolution:", allMatchesError);
            } else if (Array.isArray(allMatches)) {
                for (const m of allMatches) {
                    const key = m?.bracket_match_id ? String(m.bracket_match_id).trim() : "";
                    if (key) {
                        allMatchesByBracketId[key] = m;
                    }
                }
            }
        } catch (err) {
            console.error("[Finalize] Exception building allMatchesByBracketId:", err);
        }

        // Process all matches in a transaction-like manner
        const updates = [];
        const skippedMatches = []; // Track matches skipped due to missing players
        for (const matchData of matches) {
            const existingMatch = existingMatches.find(m => m.id === matchData.matchId);
            if (!existingMatch) continue;

            // CRITICAL: Use bracket to fill player_a/player_b when empty so winner can be computed and stored correctly.
            // Bracket data is cached per bracket_id to avoid redundant DB fetches.
            let effectivePlayerA = existingMatch.player_a;
            let effectivePlayerB = existingMatch.player_b;
            let bracketDataForMatch = bracketDataObjForFinalize;
            
            // Check if players are missing or empty
            const hasValidA = effectivePlayerA && typeof effectivePlayerA === 'object' && Object.keys(effectivePlayerA).length > 0 && (effectivePlayerA.id || effectivePlayerA.player_id);
            const hasValidB = effectivePlayerB && typeof effectivePlayerB === 'object' && Object.keys(effectivePlayerB).length > 0 && (effectivePlayerB.id || effectivePlayerB.player_id);
            
            // If players are missing, try to get from bracket
            if ((!hasValidA || !hasValidB) && existingMatch.bracket_id && existingMatch.bracket_match_id) {
                // Only fetch bracket if we don't have it cached yet (avoid redundant per-match fetches)
                if (!bracketDataForMatch) {
                    try {
                        const { data: bracketRow, error: bracketError } = await supabaseAdmin
                            .from('event_brackets')
                            .select('bracket_data, draw_data')
                            .eq('id', existingMatch.bracket_id)
                            .single();
                        if (bracketError) {
                            console.error(`[Finalize] Failed to fetch bracket ${existingMatch.bracket_id} for match ${matchData.matchId}:`, bracketError);
                        } else if (bracketRow) {
                            // Prefer bracket_data, then draw_data — cache for subsequent iterations
                            bracketDataForMatch = bracketRow.bracket_data || bracketRow.draw_data || {};
                            bracketDataObjForFinalize = bracketDataForMatch;
                            console.log(`[Finalize] Fetched bracket data for match ${matchData.matchId}, rounds:`, bracketDataForMatch.rounds?.map(r => r.name) || []);
                        }
                    } catch (err) {
                        console.error(`[Finalize] Exception fetching bracket for match ${matchData.matchId}:`, err);
                    }
                }
                
                // Try bracket lookup with current bracket data
                if (bracketDataForMatch) {
                    const enriched = getMatchPlayers(existingMatch, bracketDataForMatch, allMatchesByBracketId);
                    if (enriched.playerA && typeof enriched.playerA === 'object' && Object.keys(enriched.playerA).length > 0 && (enriched.playerA.id || enriched.playerA.player_id)) {
                        effectivePlayerA = enriched.playerA;
                    }
                    if (enriched.playerB && typeof enriched.playerB === 'object' && Object.keys(enriched.playerB).length > 0 && (enriched.playerB.id || enriched.playerB.player_id)) {
                        effectivePlayerB = enriched.playerB;
                    }
                }
                
                // Debug logging if players still missing
                if (!effectivePlayerA || !effectivePlayerB) {
                    const bracketRounds = bracketDataForMatch?.rounds || [];
                    const roundNames = bracketRounds.map(r => r.name);
                    const allMatchIds = [];
                    for (const round of bracketRounds) {
                        for (const m of (round.matches || [])) {
                            if (m) allMatchIds.push(String(m.id || m.matchId || m.match_id || 'unknown').trim());
                        }
                    }
                    console.warn(`[Finalize] Match ${matchData.matchId} still missing players after bracket lookup:`, {
                        bracket_match_id: existingMatch.bracket_match_id,
                        bracket_id: existingMatch.bracket_id,
                        round_name: existingMatch.round_name,
                        hasBracketData: !!bracketDataForMatch,
                        bracketRoundNames: roundNames,
                        bracketMatchIds: allMatchIds.slice(0, 5),
                        playerA: effectivePlayerA ? 'found' : 'missing',
                        playerB: effectivePlayerB ? 'found' : 'missing'
                    });
                }
            }
            
            // Check if we need to persist players (when they were enriched from bracket)
            const needPersistPlayers = (!hasValidA && effectivePlayerA && typeof effectivePlayerA === 'object' && Object.keys(effectivePlayerA).length > 0 && (effectivePlayerA.id || effectivePlayerA.player_id)) ||
                                      (!hasValidB && effectivePlayerB && typeof effectivePlayerB === 'object' && Object.keys(effectivePlayerB).length > 0 && (effectivePlayerB.id || effectivePlayerB.player_id));

            const score = matchData.score;
            let finalScore;
            let winner = null;

            // Check if score uses sets format
            if (score && Array.isArray(score.sets) && score.sets.length > 0) {
                const sets = score.sets;
                const isLeagueMatch = String(existingMatch.round_name || "").trim().toUpperCase() === "LEAGUE";

                for (let i = 0; i < sets.length; i++) {
                    const set = sets[i];
                    const p1Score = parseInt(set.player1 || 0);
                    const p2Score = parseInt(set.player2 || 0);
                    if (isNaN(p1Score) || isNaN(p2Score) || p1Score < 0 || p2Score < 0) {
                        return res.status(400).json({
                            success: false,
                            message: `Invalid scores in set ${i + 1} for match ${matchData.matchId}`
                        });
                    }
                }

                let player1SetsWon = 0;
                let player2SetsWon = 0;
                let player1TotalPoints = 0;
                let player2TotalPoints = 0;
                // Per-match fallback: if categorySetsPerMatch is still 1 but match has more sets, use actual count
                const effectiveSetsPerMatch = (categorySetsPerMatch === 1 && sets.length > 1) ? sets.length : categorySetsPerMatch;
                const setsToWin = Math.ceil(effectiveSetsPerMatch / 2);
                for (const set of sets) {
                    const p1Score = parseInt(set.player1 || 0);
                    const p2Score = parseInt(set.player2 || 0);
                    player1TotalPoints += p1Score;
                    player2TotalPoints += p2Score;
                    if (p1Score > p2Score) player1SetsWon++;
                    else if (p2Score > p1Score) player2SetsWon++;
                }

                // Extract valid player ids (never use empty objects)
                const winnerIdA = getPlayerId(effectivePlayerA);
                const winnerIdB = getPlayerId(effectivePlayerB);
                
                if (!winnerIdA || !winnerIdB) {
                    // Skip this match instead of failing the entire batch
                    const matchInfo = `Match ${matchData.matchId} (${existingMatch.round_name}, bracket_match_id: ${existingMatch.bracket_match_id || 'none'})`;
                    const playerAInfo = effectivePlayerA ? (typeof effectivePlayerA === 'object' ? JSON.stringify(effectivePlayerA) : String(effectivePlayerA)) : 'null/empty';
                    const playerBInfo = effectivePlayerB ? (typeof effectivePlayerB === 'object' ? JSON.stringify(effectivePlayerB) : String(effectivePlayerB)) : 'null/empty';
                    console.warn(`[Finalize] Skipping ${matchInfo}: missing valid player_a (${playerAInfo}) or player_b (${playerBInfo}). Ensure players are assigned in bracket.`);
                    skippedMatches.push({
                        matchId: matchData.matchId,
                        reason: `Missing player_a or player_b`,
                        playerA: playerAInfo,
                        playerB: playerBInfo
                    });
                    continue;
                }
                
                if (categoryWinnerMode === 'score_based') {
                    // Score-based: winner decided by total points across ALL sets
                    // Tiebreak: player who won more sets
                    if (player1TotalPoints > player2TotalPoints) {
                        winner = winnerIdA;
                    } else if (player2TotalPoints > player1TotalPoints) {
                        winner = winnerIdB;
                    } else {
                        // Total points tied - use set wins as tiebreak
                        if (player1SetsWon > player2SetsWon) {
                            winner = winnerIdA;
                        } else if (player2SetsWon > player1SetsWon) {
                            winner = winnerIdB;
                        } else {
                            if (isLeagueMatch) {
                                winner = null; // Draw allowed in league
                            } else {
                                return res.status(400).json({
                                    success: false,
                                    message: `Score-based tiebreak: total points AND set wins are equal for match ${matchData.matchId}. Please correct scores.`
                                });
                            }
                        }
                    }
                } else {
                    // Set-based (default): first to win majority of sets
                    if (player1SetsWon >= setsToWin) {
                        winner = winnerIdA;
                    } else if (player2SetsWon >= setsToWin) {
                        winner = winnerIdB;
                    } else {
                        if (player1SetsWon === player2SetsWon) {
                            if (isLeagueMatch) {
                                winner = null;
                            } else {
                                return res.status(400).json({
                                    success: false,
                                    message: `Draw is not allowed for knockout matches. Please correct the set scores for match ${matchData.matchId}.`
                                });
                            }
                        } else if (player1SetsWon > player2SetsWon) {
                            winner = winnerIdA;
                        } else {
                            winner = winnerIdB;
                        }
                    }
                }

                finalScore = {
                    sets: sets,
                    ...(Array.isArray(score.homePlayerGoals) ? { homePlayerGoals: score.homePlayerGoals } : {}),
                    ...(Array.isArray(score.awayPlayerGoals) ? { awayPlayerGoals: score.awayPlayerGoals } : {}),
                    ...(score.playerGoals && typeof score.playerGoals === 'object' ? { playerGoals: score.playerGoals } : {}),
                };
            } else {
                const p1Score = parseInt(score?.player1 || score?.player_a || 0);
                const p2Score = parseInt(score?.player2 || score?.player_b || 0);
                const isLeagueMatch = String(existingMatch.round_name || "").trim().toUpperCase() === "LEAGUE";

                if (isNaN(p1Score) || isNaN(p2Score) || p1Score < 0 || p2Score < 0) {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid scores for match ${matchData.matchId}`
                    });
                }

                finalScore = {
                    sets: [{ player1: p1Score, player2: p2Score }],
                    ...(Array.isArray(score?.homePlayerGoals) ? { homePlayerGoals: score.homePlayerGoals } : {}),
                    ...(Array.isArray(score?.awayPlayerGoals) ? { awayPlayerGoals: score.awayPlayerGoals } : {}),
                    ...(score?.playerGoals && typeof score.playerGoals === 'object' ? { playerGoals: score.playerGoals } : {}),
                };

                // Extract valid player ids (never use empty objects)
                const winnerIdA = getPlayerId(effectivePlayerA);
                const winnerIdB = getPlayerId(effectivePlayerB);
                
                if (!winnerIdA || !winnerIdB) {
                    // Skip this match instead of failing the entire batch
                    const matchInfo = `Match ${matchData.matchId} (${existingMatch.round_name}, bracket_match_id: ${existingMatch.bracket_match_id || 'none'})`;
                    const playerAInfo = effectivePlayerA ? (typeof effectivePlayerA === 'object' ? JSON.stringify(effectivePlayerA) : String(effectivePlayerA)) : 'null/empty';
                    const playerBInfo = effectivePlayerB ? (typeof effectivePlayerB === 'object' ? JSON.stringify(effectivePlayerB) : String(effectivePlayerB)) : 'null/empty';
                    console.warn(`[Finalize] Skipping ${matchInfo}: missing valid player_a (${playerAInfo}) or player_b (${playerBInfo}). Ensure players are assigned in bracket.`);
                    skippedMatches.push({
                        matchId: matchData.matchId,
                        reason: `Missing player_a or player_b`,
                        playerA: playerAInfo,
                        playerB: playerBInfo
                    });
                    continue;
                }
                
                if (p1Score > p2Score) {
                    winner = winnerIdA;
                } else if (p2Score > p1Score) {
                    winner = winnerIdB;
                } else {
                    if (isLeagueMatch) {
                        winner = null;
                    } else {
                        return res.status(400).json({
                            success: false,
                            message: `Draw is not allowed for knockout matches. Please correct the score for match ${matchData.matchId}.`
                        });
                    }
                }
            }

            const updateEntry = {
                id: matchData.matchId,
                score: finalScore,
                winner,
                status: 'COMPLETED',
                updated_at: new Date().toISOString()
            };
            // Persist players when they were enriched from bracket (only if valid)
            if (needPersistPlayers && hasValidA) {
                updateEntry.player_a = effectivePlayerA;
            }
            if (needPersistPlayers && hasValidB) {
                updateEntry.player_b = effectivePlayerB;
            }
            updates.push(updateEntry);
        }

        // Update all matches in DB (include player_a/player_b when enriched)
        let results = [];
        if (updates.length > 0) {
        const updatePromises = updates.map(update => {
            const payload = {
                score: update.score,
                winner: update.winner,
                status: update.status,
                updated_at: update.updated_at
            };
            if (update.player_a !== undefined) payload.player_a = update.player_a;
            if (update.player_b !== undefined) payload.player_b = update.player_b;
            return supabaseAdmin
                .from('matches')
                .update(payload)
                .eq('id', update.id)
                .select()
                .single();
        });

        results = await Promise.all(updatePromises);
        const errors = results.filter(r => r.error);

        if (errors.length > 0) {
            console.error("Finalize matches errors:", errors);
            return res.status(500).json({
                success: false,
                message: "Failed to finalize some matches",
                errors: errors.map(e => e.error?.message)
            });
        }
        } // end if (updates.length > 0)

        // ---- Winner propagation through bracket_data using bracket_match_id ----
        if (updates.length > 0) {
        try {
            // Bracket lookup must be robust:
            // - Some deployments store non-UUID category IDs (numeric/string) in category_id
            // - Some UIs pass categoryName with extra suffixes; exact equality can fail
            // Strategy: try category_id first (any string), then exact category name, then partial match.
            let bracketRows = null;
            let bracketErr = null;

            if (categoryId) {
                const r1 = await supabaseAdmin
                    .from('event_brackets')
                    .select('*')
                    .eq('event_id', eventId)
                    .eq('mode', 'BRACKET')
                    .eq('category_id', categoryId);
                bracketRows = r1.data;
                bracketErr = r1.error;
            }

            if ((!bracketRows || bracketRows.length === 0) && categoryName) {
                const r2 = await supabaseAdmin
                    .from('event_brackets')
                    .select('*')
                    .eq('event_id', eventId)
                    .eq('mode', 'BRACKET')
                    .eq('category', categoryName);
                bracketRows = r2.data;
                bracketErr = r2.error;

                // Partial match fallback (matches getCategoryDraw behavior)
                if ((!bracketRows || bracketRows.length === 0) && categoryName) {
                    const baseCategory = String(categoryName).split(" - ").filter(p => String(p).trim())[0] || String(categoryName);
                    const r3 = await supabaseAdmin
                        .from('event_brackets')
                        .select('*')
                        .eq('event_id', eventId)
                        .eq('mode', 'BRACKET')
                        .ilike('category', `%${baseCategory}%`)
                        .order('created_at', { ascending: true });
                    bracketRows = r3.data;
                    bracketErr = r3.error;
                }
            }

            if (!bracketErr && bracketRows && bracketRows.length > 0) {
                const bracket = bracketRows[0];
                const bracketDataObj = bracket.bracket_data || bracket.bracketData || { rounds: [], players: [] };
                const rounds = Array.isArray(bracketDataObj.rounds) ? bracketDataObj.rounds : [];

                const integrity = validateBracketIntegrity(bracketDataObj);
                if (!integrity.valid) {
                    // AUTO-REPAIR: Reconstruct missing winnerTo/winnerToSlot linkage.
                    // Old brackets (created before linkage was added) may lack these fields.
                    // Without them, winner propagation to the next round is impossible.
                    let repaired = false;
                    const roundCount = rounds.length;
                    for (let rIdx = 0; rIdx < roundCount - 1; rIdx++) {
                        const round = rounds[rIdx];
                        const matches = Array.isArray(round?.matches) ? round.matches : [];
                        for (let mIdx = 0; mIdx < matches.length; mIdx++) {
                            const m = matches[mIdx];
                            if (!m) continue;
                            if (m.winnerTo == null || m.winnerToSlot == null) {
                                // matchNumber is 1-based (mIdx is 0-based)
                                const matchNum = mIdx + 1;
                                const nextRoundIndex = rIdx + 1;
                                const nextMatchNumber = Math.ceil(matchNum / 2);
                                m.winnerTo = `R${nextRoundIndex + 1}-M${nextMatchNumber}`;
                                m.winnerToSlot = matchNum % 2 === 1 ? "player1" : "player2";
                                repaired = true;
                            }
                        }
                    }
                    if (repaired) {
                        console.log("[Finalize] Auto-repaired missing winnerTo/winnerToSlot in bracket_data");
                        // Re-validate after repair
                        const recheck = validateBracketIntegrity(bracketDataObj);
                        if (!recheck.valid) {
                            console.warn("Bracket integrity still invalid after repair:", recheck.errors);
                            // Skip propagation to avoid wrong mapping; scores are still saved
                        }
                    }
                    if (!repaired) {
                        console.warn("Bracket integrity check failed before propagation:", integrity.errors);
                        // Skip propagation to avoid Semifinal wrong mapping; scores are still saved
                    }
                }
                // Proceed with propagation if integrity is valid (either originally or after repair)
                if (validateBracketIntegrity(bracketDataObj).valid) {

                const matchIndexById = new Map();
                const roundIndexByName = new Map();
                rounds.forEach((round, rIdx) => {
                    if (round && typeof round.name === "string") {
                        roundIndexByName.set(normalizeRoundName(round.name), rIdx);
                    }
                    const ms = Array.isArray(round.matches) ? round.matches : [];
                    ms.forEach((m, mIdx) => {
                        if (m && m.id) {
                            matchIndexById.set(String(m.id).trim(), { roundIndex: rIdx, matchIndex: mIdx });
                        }
                    });
                });

                const downstreamUpdates = new Map();
                for (const update of updates) {
                    if (!update.winner) continue;
                    const existingMatch = existingMatches.find(m => m.id === update.id);
                    if (!existingMatch) continue;

                    let loc = null;
                    const key = existingMatch.bracket_match_id ? String(existingMatch.bracket_match_id).trim() : null;
                    if (key) {
                        loc = matchIndexById.get(key) || null;
                    }
                    if (!loc) {
                        const rn = normalizeRoundName(existingMatch.round_name);
                        const rIdx = roundIndexByName.has(rn) ? roundIndexByName.get(rn) : rounds.findIndex((r) => r && normalizeRoundName(r.name) === rn);
                        const mIdx = typeof existingMatch.match_index === "number" ? existingMatch.match_index : -1;
                        if (rIdx >= 0 && mIdx >= 0 && rounds[rIdx]?.matches?.[mIdx]) {
                            loc = { roundIndex: rIdx, matchIndex: mIdx };
                            try {
                                await supabaseAdmin
                                    .from("matches")
                                    .update({ bracket_match_id: String(rounds[rIdx].matches[mIdx].id) })
                                    .eq("id", existingMatch.id);
                            } catch (e) { /* ignore */ }
                        }
                    }
                    if (!loc) continue;

                    const currentRound = rounds[loc.roundIndex];
                    const bracketMatch = currentRound?.matches?.[loc.matchIndex] || null;
                    if (!bracketMatch) continue;

                    // Bracket player ids (used for winner resolution and for setting bracketMatch.winner)
                    const bP1Id = bracketMatch.player1 && (bracketMatch.player1.id || bracketMatch.player1);
                    const bP2Id = bracketMatch.player2 && (bracketMatch.player2.id || bracketMatch.player2);

                    // Determine winner player object – prefer authoritative matches table players,
                    // then fall back to bracket_data players if needed. This avoids cases where
                    // bracket_data player1/player2 order doesn't match player_a/player_b.
                    const winnerId = String(update.winner);
                    let winnerPlayer = null;

                    // 1) Prefer matches table player_a / player_b (authoritative for A/B sides)
                    const mP1 = existingMatch.player_a;
                    const mP2 = existingMatch.player_b;
                    const mP1Id = mP1 && (mP1.id || mP1.player_id || mP1);
                    const mP2Id = mP2 && (mP2.id || mP2.player_id || mP2);

                    if (mP1Id && String(mP1Id) === winnerId) {
                        winnerPlayer = mP1;
                    } else if (mP2Id && String(mP2Id) === winnerId) {
                        winnerPlayer = mP2;
                    }

                    // 2) Fallback: use bracket_data player1 / player2 if they match the winner id
                    if (!winnerPlayer) {
                        if (bP1Id && String(bP1Id) === winnerId) {
                            winnerPlayer = bracketMatch.player1;
                        } else if (bP2Id && String(bP2Id) === winnerId) {
                            winnerPlayer = bracketMatch.player2;
                        }
                    }

                    if (!winnerPlayer) continue;

                    // Store winner reference on this bracket node (for visualization)
                    if (!bracketMatch.winner) {
                        if (bP1Id && String(bP1Id) === winnerId) {
                            bracketMatch.winner = "player1";
                        } else if (bP2Id && String(bP2Id) === winnerId) {
                            bracketMatch.winner = "player2";
                        }
                    }

                    // HARDENED: Use ONLY winnerTo/winnerToSlot from bracket. Never derive slot from index.
                    let targetId = bracketMatch.winnerTo != null ? String(bracketMatch.winnerTo).trim() : null;
                    let targetSlot = bracketMatch.winnerToSlot || null;

                    // Legacy: only if bracket has no linkage (old data), infer from index once
                    if ((!targetId || !targetSlot) && (loc.roundIndex < rounds.length - 1)) {
                        const fallbackRoundIndex = loc.roundIndex + 1;
                        const nextMatchIndex = Math.floor(loc.matchIndex / 2);
                        const nextSlot = (loc.matchIndex % 2 === 0) ? "player1" : "player2";
                        const downstreamRound = rounds[fallbackRoundIndex];
                        if (downstreamRound?.matches?.[nextMatchIndex]?.id) {
                            targetId = String(downstreamRound.matches[nextMatchIndex].id);
                            targetSlot = nextSlot;
                        }
                    }

                    if (!targetId || !targetSlot) continue;

                    const downstreamLoc = matchIndexById.get(String(targetId));
                    if (!downstreamLoc) continue;

                    const downstreamRound = rounds[downstreamLoc.roundIndex];
                    if (!downstreamRound || !Array.isArray(downstreamRound.matches)) continue;

                    const downstreamMatch = downstreamRound.matches[downstreamLoc.matchIndex];
                    if (!downstreamMatch) continue;

                    // Assign winner to the correct slot; this supports partial completion
                    downstreamMatch[targetSlot] = winnerPlayer;

                    // Collect downstream match update for bulk execution
                    const dbTargetSlot = (targetSlot === 'player1') ? 'player_a' : 'player_b';
                    const targetKey = String(targetId);
                    
                    if (!downstreamUpdates.has(targetKey)) {
                        downstreamUpdates.set(targetKey, {
                            bracket_id: bracket.id,
                            bracket_match_id: targetKey,
                            updated_at: new Date().toISOString()
                        });
                    }
                    downstreamUpdates.get(targetKey)[dbTargetSlot] = winnerPlayer;
                }

                // ── BYE winner propagation ──
                // The frontend skips BYE matches when finalizing (no scores to enter),
                // so their winners are never in the `updates` array above. We must
                // propagate them here for the current round so that downstream matches
                // (e.g., Quarterfinal) get BOTH feeder players.
                const normalizedFinalizingRound = normalizeRoundName(roundName);
                const finalizingRoundIdx = roundIndexByName.has(normalizedFinalizingRound)
                    ? roundIndexByName.get(normalizedFinalizingRound)
                    : rounds.findIndex(r => r && normalizeRoundName(r.name) === normalizedFinalizingRound);

                if (finalizingRoundIdx >= 0 && finalizingRoundIdx < rounds.length) {
                    const currentRoundObj = rounds[finalizingRoundIdx];
                    const currentRoundMatches = Array.isArray(currentRoundObj.matches) ? currentRoundObj.matches : [];

                    // Set of bracket_match_ids already processed in the normal propagation loop above
                    const alreadyPropagatedIds = new Set();
                    for (const update of updates) {
                        const em = existingMatches.find(m => m.id === update.id);
                        if (em && em.bracket_match_id) alreadyPropagatedIds.add(String(em.bracket_match_id).trim());
                    }

                    for (let mIdx = 0; mIdx < currentRoundMatches.length; mIdx++) {
                        const bracketMatch = currentRoundMatches[mIdx];
                        if (!bracketMatch) continue;
                        const bmId = String(bracketMatch.id || "").trim();
                        if (alreadyPropagatedIds.has(bmId)) continue; // already handled

                        // Detect BYE: one real player, one empty
                        const hasP1 = bracketMatch.player1 && typeof bracketMatch.player1 === 'object' && (bracketMatch.player1.id || bracketMatch.player1.player_id);
                        const hasP2 = bracketMatch.player2 && typeof bracketMatch.player2 === 'object' && (bracketMatch.player2.id || bracketMatch.player2.player_id);
                        const isBye = (hasP1 && !hasP2) || (!hasP1 && hasP2);
                        if (!isBye) continue;

                        const winnerPlayer = hasP1 ? bracketMatch.player1 : bracketMatch.player2;
                        const winnerSide = hasP1 ? "player1" : "player2";

                        // Mark winner on the bracket node if not already set
                        if (!bracketMatch.winner) {
                            bracketMatch.winner = winnerSide;
                        }

                        // Find downstream target
                        let targetId = bracketMatch.winnerTo != null ? String(bracketMatch.winnerTo).trim() : null;
                        let targetSlot = bracketMatch.winnerToSlot || null;

                        // Legacy fallback: derive from index
                        if ((!targetId || !targetSlot) && (finalizingRoundIdx < rounds.length - 1)) {
                            const nextRoundIndex = finalizingRoundIdx + 1;
                            const nextMatchIndex = Math.floor(mIdx / 2);
                            const slot = (mIdx % 2 === 0) ? "player1" : "player2";
                            const downRound = rounds[nextRoundIndex];
                            if (downRound?.matches?.[nextMatchIndex]?.id) {
                                targetId = String(downRound.matches[nextMatchIndex].id);
                                targetSlot = slot;
                            }
                        }

                        if (!targetId || !targetSlot) continue;

                        const downstreamLoc = matchIndexById.get(String(targetId));
                        if (!downstreamLoc) continue;

                        const downstreamRound = rounds[downstreamLoc.roundIndex];
                        if (!downstreamRound || !Array.isArray(downstreamRound.matches)) continue;
                        const downstreamMatch = downstreamRound.matches[downstreamLoc.matchIndex];
                        if (!downstreamMatch) continue;

                        downstreamMatch[targetSlot] = winnerPlayer;
                        console.log(`[Finalize] BYE winner propagated: ${bmId} → ${targetId}.${targetSlot}`);

                        const dbTargetSlot = (targetSlot === 'player1') ? 'player_a' : 'player_b';
                        const targetKey = String(targetId);
                        if (!downstreamUpdates.has(targetKey)) {
                            downstreamUpdates.set(targetKey, {
                                bracket_id: bracket.id,
                                bracket_match_id: targetKey,
                                updated_at: new Date().toISOString()
                            });
                        }
                        downstreamUpdates.get(targetKey)[dbTargetSlot] = winnerPlayer;
                    }
                }

                // Perform bulk update for downstream matches
                if (downstreamUpdates.size > 0) {
                    try {
                        await supabaseAdmin
                            .from('matches')
                            .upsert(Array.from(downstreamUpdates.values()), { 
                                onConflict: 'bracket_id,bracket_match_id' 
                            });
                    } catch (dbUpdateErr) {
                        console.error("Failed to bulk update downstream matches in DB:", dbUpdateErr);
                    }
                }

                } // end integrity.valid

                // Persist updated bracket_data if any changes were made
                const { error: updErr } = await supabaseAdmin
                    .from('event_brackets')
                    .update({
                        bracket_data: { ...bracketDataObj, rounds },
                        draw_data: { ...bracketDataObj, rounds },
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', bracket.id);

                if (updErr) {
                    console.error("Bracket winner propagation update error:", updErr);
                }
            }
        } catch (propErr) {
            console.error("Winner propagation through bracket_data failed:", propErr);
            // Non-fatal: scores are still saved, bracket view just won't update for this call.
        }
        } // end if (updates.length > 0) for winner propagation

        // If all matches were skipped (none could be finalized), report as error
        if (updates.length === 0 && skippedMatches.length > 0) {
            return res.status(400).json({
                success: false,
                message: `No matches could be finalized. ${skippedMatches.length} match(es) skipped due to missing player data. Please ensure players are assigned in the bracket before finalizing scores.`,
                skippedMatches
            });
        }

        return res.status(200).json({
            success: true,
            message: skippedMatches.length > 0
                ? `Finalized ${updates.length} match(es). ${skippedMatches.length} match(es) skipped (missing player data).`
                : `Successfully finalized ${updates.length} match(es)`,
            finalizedCount: updates.length,
            skippedCount: skippedMatches.length,
            skippedMatches: skippedMatches.length > 0 ? skippedMatches : undefined,
            matches: results.map(r => r.data).filter(Boolean)
        });

    } catch (error) {
        console.error("Finalize Round Matches Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to finalize matches",
            error: error.message
        });
    }
};

// Delete Match
export const deleteMatch = async (req, res) => {
    const { matchId } = req.params;

    if (!matchId) {
        return res.status(400).json({ success: false, message: "Match ID is required" });
    }

    try {
        // First, verify the match exists
        const { data: existingMatch, error: fetchError } = await supabaseAdmin
            .from('matches')
            .select('id')
            .eq('id', matchId)
            .single();

        if (fetchError || !existingMatch) {
            return res.status(404).json({
                success: false,
                message: "Match not found"
            });
        }

        // Delete the match
        const { data, error } = await supabaseAdmin
            .from('matches')
            .delete()
            .eq('id', matchId)
            .select();

        if (error) {
            console.error("Delete Match Error:", error);
            throw error;
        }

        // Verify deletion
        if (!data || data.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Match not found or already deleted"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Match deleted successfully",
            deletedMatch: data[0]
        });
    } catch (error) {
        console.error("Delete Match Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete match",
            error: error.message
        });
    }
};

// Delete All Matches for a Category
export const deleteCategoryMatches = async (req, res) => {
    const { eventId } = req.params;
    const { categoryId, categoryName, roundName, round_name } = req.query;
    const effectiveRoundName = (roundName || round_name) ? String(roundName || round_name).trim() : null;

    if (!eventId) {
        return res.status(400).json({ success: false, message: "Event ID is required" });
    }

    if (!categoryId && !categoryName) {
        return res.status(400).json({ success: false, message: "Category ID or Category Name is required" });
    }

    try {
        const { data: allMatches, error: fetchError } = await supabaseAdmin
            .from('matches')
            .select('id, category_id, event_id')
            .eq('event_id', eventId);

        if (fetchError) {
            throw fetchError;
        }

        if (!allMatches || allMatches.length === 0) {
            return res.status(200).json({
                success: true,
                message: "No matches found for this category",
                deletedCount: 0
            });
        }

        // Filter matches by category (and optional round) - try multiple matching strategies
        // CRITICAL: Use exact matching to avoid deleting matches from other categories/rounds
        let matchesToDelete = allMatches.filter(match => {
            const matchCategoryId = match.category_id;
            if (!matchCategoryId) return false;

            // Strategy 1: Exact UUID match (most reliable)
            if (categoryId && isUuid(categoryId)) {
                return String(matchCategoryId) === String(categoryId);
            }

            // Strategy 2: Exact text/numeric match (categoryId as text or number)
            // IMPORTANT: If categoryId was provided, ONLY match by categoryId.
            // Do NOT fall through to categoryName — that would match other rounds.
            if (categoryId) {
                return matchCategoryId == categoryId || String(matchCategoryId) === String(categoryId);
            }

            // Strategy 3: Category name exact match (ONLY when categoryId was not provided)
            if (categoryName && (matchCategoryId === categoryName || String(matchCategoryId) === String(categoryName))) {
                return true;
            }

            return false;
        });

        // Legacy fallback: if categoryId matched nothing, try exact categoryName match.
        // Guard: do NOT fallback for synthetic round IDs (e.g., *_R2) to avoid cross-round deletions.
        if (
            matchesToDelete.length === 0 &&
            categoryId &&
            categoryName &&
            !String(categoryId).includes('_R')
        ) {
            matchesToDelete = allMatches.filter(match => {
                const matchCategoryId = match.category_id;
                if (!matchCategoryId) return false;
                return String(matchCategoryId) === String(categoryName);
            });
        }

        // Optional: filter by roundName if provided (e.g., LEAGUE only)
        if (effectiveRoundName) {
            // Need to refetch with round_name for filtering, since initial select didn't include it
            const { data: matchesWithRounds, error: roundsFetchError } = await supabaseAdmin
                .from('matches')
                .select('id, round_name')
                .eq('event_id', eventId)
                .in('id', matchesToDelete.map(m => m.id));

            if (roundsFetchError) {
                throw roundsFetchError;
            }

            const roundById = new Map((matchesWithRounds || []).map(m => [m.id, m.round_name]));
            matchesToDelete = matchesToDelete.filter(m => String(roundById.get(m.id) || "").trim() === effectiveRoundName);
        }

        if (matchesToDelete.length === 0) {
            return res.status(200).json({
                success: true,
                message: "No matches found matching the specified category",
                deletedCount: 0
            });
        }

        // Delete in chunks so very large categories don't exceed URL/query size limits.
        const matchIds = matchesToDelete.map(m => m.id);
        let deletedCount = 0;

        for (const idChunk of chunkArray(matchIds)) {
            const { data: deletedData, error: deleteError } = await supabaseAdmin
                .from('matches')
                .delete()
                .in('id', idChunk)
                .select('id');

            if (deleteError) {
                console.error("Delete Category Matches Error:", deleteError);
                throw deleteError;
            }

            deletedCount += deletedData?.length || 0;
        }

        return res.status(200).json({
            success: true,
            message: `Deleted ${deletedCount} match(es) for this category`,
            deletedCount: deletedCount
        });
    } catch (error) {
        console.error("Delete Category Matches Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete category matches",
            error: error.message
        });
    }
};

// Clear ONLY scores (keep matches) for a category (and optional round)
// DELETE /api/admin/matches/category/:eventId/scores?categoryId=&categoryName=&roundName=
export const clearCategoryScores = async (req, res) => {
    const { eventId } = req.params;
    const { categoryId, categoryName, roundName, round_name } = req.query;
    const effectiveRoundName = (roundName || round_name) ? String(roundName || round_name).trim() : null;

    if (!eventId) {
        return res.status(400).json({ success: false, message: "Event ID is required" });
    }

    if (!categoryId && !categoryName) {
        return res.status(400).json({ success: false, message: "Category ID or Category Name is required" });
    }

    try {
        const { data: allMatches, error: fetchError } = await supabaseAdmin
            .from("matches")
            .select("id, category_id, event_id, round_name")
            .eq("event_id", eventId);

        if (fetchError) {
            throw fetchError;
        }

        if (!allMatches || allMatches.length === 0) {
            return res.status(200).json({
                success: true,
                message: "No matches found for this category",
                updatedCount: 0
            });
        }

        // Reuse the same safe category matching logic as deleteCategoryMatches
        let matchesToUpdate = allMatches.filter(match => {
            const matchCategoryId = match.category_id;
            if (!matchCategoryId) return false;

            // Strategy 1: Exact UUID match (most reliable)
            if (categoryId && isUuid(categoryId)) {
                return String(matchCategoryId) === String(categoryId);
            }

            // Strategy 2: Exact text/numeric match (categoryId as text or number)
            // IMPORTANT: If categoryId was provided, ONLY match by categoryId.
            // Do NOT fall through to categoryName — that would match other rounds.
            if (categoryId) {
                return matchCategoryId == categoryId || String(matchCategoryId) === String(categoryId);
            }

            // Strategy 3: Category name exact match (ONLY when categoryId was not provided)
            if (categoryName && (matchCategoryId === categoryName || String(matchCategoryId) === String(categoryName))) {
                return true;
            }

            return false;
        });

        // Legacy fallback: if categoryId matched nothing, try exact categoryName match.
        // Guard: do NOT fallback for synthetic round IDs (e.g., *_R2) to avoid cross-round resets.
        if (
            matchesToUpdate.length === 0 &&
            categoryId &&
            categoryName &&
            !String(categoryId).includes('_R')
        ) {
            matchesToUpdate = allMatches.filter(match => {
                const matchCategoryId = match.category_id;
                if (!matchCategoryId) return false;
                return String(matchCategoryId) === String(categoryName);
            });
        }

        // Optional: filter by roundName if provided (e.g., LEAGUE only)
        if (effectiveRoundName) {
            matchesToUpdate = matchesToUpdate.filter(
                m => String(m.round_name || "").trim() === effectiveRoundName
            );
        }

        if (!matchesToUpdate || matchesToUpdate.length === 0) {
            return res.status(200).json({
                success: true,
                message: "No matches found to clear scores for this category/round",
                updatedCount: 0
            });
        }

        const matchIds = matchesToUpdate.map(m => m.id);
        let updatedCount = 0;

        // Update in chunks so large rounds/categories don't fail with oversized filters.
        for (const idChunk of chunkArray(matchIds)) {
            const { data: updated, error: updateError } = await supabaseAdmin
                .from("matches")
                .update({
                    score: null,
                    winner: null,
                    status: "SCHEDULED",
                    updated_at: new Date().toISOString()
                })
                .in("id", idChunk)
                .select("id");

            if (updateError) {
                throw updateError;
            }

            updatedCount += Array.isArray(updated) ? updated.length : 0;
        }

        return res.status(200).json({
            success: true,
            message: `Cleared scores for ${updatedCount} match(es)`,
            updatedCount
        });
    } catch (err) {
        console.error("Clear Category Scores Error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to clear scores for this category"
        });
    }
};

// Get Matches (Scoreboard) - Public version (no auth required)
export const getPublicMatches = async (req, res) => {
    const eventIdentifier = req.params.id || req.params.eventId; // Support both :id and :eventId routes
    const { categoryId, categoryName, roundName, round_name } = req.query;

    if (!eventIdentifier) {
        return res.status(400).json({
            success: false,
            message: "Event ID is required",
            debug: { params: req.params, query: req.query }
        });
    }

    const eventId = await resolveEventIdByIdentifier(eventIdentifier);
    if (!eventId) {
        return res.status(404).json({ success: false, message: "Event not found" });
    }

    // 🔒 LEAGUE GOLDEN RULE: For LEAGUE matches, category_id is mandatory and exact
    // No bracket lookup. No label guessing. No partial matching.
    const isLeagueRequest = roundName === 'LEAGUE' || round_name === 'LEAGUE';

    try {
        // 🔒 LEAGUE MODE: HARD-ISOLATE AT QUERY LEVEL (CRITICAL)
        // Query Supabase directly with exact filters - DO NOT fetch all matches first
        // This eliminates all contamination from matches with wrong/null category_id
        if (isLeagueRequest && categoryId) {
            // Synthetic round IDs (e.g. <uuid>_R2, <uuid>_R3) are NOT stored in event_brackets.
            // They inherit publishing status from the base category. Skip the published check for these.
            const isSyntheticRoundId = String(categoryId).includes('_R') || String(categoryId).includes('_HR');

            if (!isSyntheticRoundId) {
                const isPublished = await isLeagueCategoryPublishedForPublic({
                    eventId,
                    categoryId,
                    categoryLabel: categoryName || categoryId,
                });

                if (!isPublished) {
                    return res.status(200).json({
                        success: true,
                        matches: []
                    });
                }
            }

            // Fetch League Matches
            let matchQuery = supabaseAdmin
                .from('matches')
                .select('id, round_name, match_index, player_a, player_b, score, status, winner, updated_at, category_id, event_id')
                .eq('event_id', eventId)
                .eq('round_name', 'LEAGUE')
                .order('match_index', { ascending: true });
                
            // Apply category filter to matches (category_id in matches table is a text/varchar so it accepts string IDs)
            matchQuery = matchQuery.eq('category_id', categoryId);
            
            const { data: leagueMatches, error: leagueError } = await matchQuery;

            if (leagueError) {
                throw leagueError;
            }

            return res.status(200).json({
                success: true,
                matches: leagueMatches || []
            });
        }

        // For non-LEAGUE requests, fetch all matches (existing logic for knockout brackets)
        let query = supabaseAdmin
            .from('matches')
            .select('id, round_name, match_index, bracket_match_id, player_a, player_b, score, status, winner, updated_at, category_id, event_id')
            .eq('event_id', eventId)
            .order('round_name', { ascending: true })
            .order('match_index', { ascending: true });

        const { data: allMatches, error: queryError } = await query;

        if (queryError) {
            throw queryError;
        }

        // If no category filter, return all matches
        if (!categoryId && !categoryName) {
            return res.status(200).json({ success: true, matches: allMatches || [] });
        }

        // Try to find matching category IDs from event_brackets
        // This handles cases where category_id in matches might differ from what frontend sends
        let matchingCategoryIds = new Set();

        if (categoryId) {
            matchingCategoryIds.add(categoryId);
        }

        // Also check event_brackets to find what category_id was used when creating matches
        if (categoryName || categoryId) {
            // Try to match by category name/label
            if (categoryName) {
                // Try exact match
                const { data: exactBrackets } = await supabaseAdmin
                    .from('event_brackets')
                    .select('category_id, category')
                    .eq('event_id', eventId)
                    .eq('category', categoryName);

                if (exactBrackets && exactBrackets.length > 0) {
                    exactBrackets.forEach(b => {
                        if (b.category_id) matchingCategoryIds.add(b.category_id);
                        if (b.category) matchingCategoryIds.add(b.category);
                    });
                }

                // Try partial match (in case categoryName is a full label like "U-11 - Male - Singles")
                const baseCategoryName = categoryName.split(' - ')[0]; // Get "U-11" from "U-11 - Male - Singles"
                const { data: partialBrackets } = await supabaseAdmin
                    .from('event_brackets')
                    .select('category_id, category')
                    .eq('event_id', eventId)
                    .ilike('category', `%${baseCategoryName}%`);

                if (partialBrackets && partialBrackets.length > 0) {
                    partialBrackets.forEach(b => {
                        if (b.category_id) matchingCategoryIds.add(b.category_id);
                        if (b.category) matchingCategoryIds.add(b.category);
                    });
                }
            }

            // If categoryId provided, check brackets by category_id
            if (categoryId) {
                const { data: idBrackets } = await supabaseAdmin
                    .from('event_brackets')
                    .select('category_id, category')
                    .eq('event_id', eventId)
                    .eq('category_id', categoryId);

                if (idBrackets && idBrackets.length > 0) {
                    idBrackets.forEach(b => {
                        if (b.category_id) matchingCategoryIds.add(b.category_id);
                        if (b.category) matchingCategoryIds.add(b.category);
                    });
                }

                // If categoryId is not a UUID, also try matching as category name
                if (!isUuid(categoryId)) {
                    const { data: nameBrackets } = await supabaseAdmin
                        .from('event_brackets')
                        .select('category_id, category')
                        .eq('event_id', eventId)
                        .eq('category', categoryId);

                    if (nameBrackets && nameBrackets.length > 0) {
                        nameBrackets.forEach(b => {
                            if (b.category_id) matchingCategoryIds.add(b.category_id);
                            if (b.category) matchingCategoryIds.add(b.category);
                        });
                    }
                }
            }
        }

        // Also check event categories to find matching IDs
        if (categoryId || categoryName) {
            const { data: eventData } = await supabaseAdmin
                .from('events')
                .select('categories')
                .eq('id', eventId)
                .single();

            if (eventData && eventData.categories) {
                const categories = Array.isArray(eventData.categories)
                    ? eventData.categories
                    : (typeof eventData.categories === 'string' ? JSON.parse(eventData.categories) : []);

                categories.forEach(cat => {
                    if (typeof cat === 'object' && cat !== null) {
                        const catId = cat.id || cat.category_id;
                        const catName = cat.category || cat.name || cat.rawName;

                        // If categoryId matches
                        if (categoryId && (catId === categoryId || catName === categoryId)) {
                            if (catId) matchingCategoryIds.add(catId);
                            if (catName) matchingCategoryIds.add(catName);
                        }

                        // If categoryName matches - use EXACT match only to avoid cross-category issues
                        if (categoryName) {
                            const fullLabel = catName + (cat.gender ? ` - ${cat.gender}` : '') + (cat.match_type ? ` - ${cat.match_type}` : '');
                            // Only exact match - don't use includes() as it causes U-15 Male to match U-15 Female
                            if (fullLabel === categoryName || categoryName === fullLabel) {
                                if (catId) matchingCategoryIds.add(catId);
                            }
                        }
                    } else if (typeof cat === 'string') {
                        // Exact match only for string categories
                        if (categoryId === cat || categoryName === cat) {
                            matchingCategoryIds.add(cat);
                        }
                    }
                });
            }
        }

        // CRITICAL: Only use exact categoryId match to prevent cross-category matches
        // The problem: Adding base names like "U-15" causes all U-15 variants to match
        // Solution: Only match the exact categoryId that was selected
        if (categoryId) {
            // Always prioritize exact categoryId - this is the most reliable
            matchingCategoryIds.add(categoryId);
        }

        // Add exact categoryName as well (in case category_id stores the name)
        if (categoryName) {
            matchingCategoryIds.add(categoryName);
        }

        // Filter out any matches that don't match the exact categoryId
        // This prevents showing matches from other categories (e.g., U-15 Female when selecting U-15 Male)
        if (categoryId) {
            const filteredSet = new Set();

            // Keep exact categoryId
            if (matchingCategoryIds.has(categoryId)) {
                filteredSet.add(categoryId);
            }

            // Keep exact categoryName
            if (categoryName && matchingCategoryIds.has(categoryName)) {
                filteredSet.add(categoryName);
            }

            // Keep bracket category_ids that match exactly
            matchingCategoryIds.forEach(id => {
                // Only keep if it's the exact categoryId or exact categoryName
                if (id === categoryId || id === categoryName) {
                    filteredSet.add(id);
                }
            });

            // Only replace if we have matches (don't empty the set if we found some)
            if (filteredSet.size > 0) {
                matchingCategoryIds = filteredSet;
            }
        }

        // Filter matches by any of the matching category IDs
        // CRITICAL: Only show matches that exactly match the selected categoryId
        const filteredMatches = (allMatches || []).filter(match => {
            if (!match.category_id) {
                return false;
            }

            // Primary check: exact categoryId match
            const exactMatch = match.category_id === categoryId;

            // Secondary check: check if it's in our matching set (from brackets/events)
            const inMatchingSet = matchingCategoryIds.has(match.category_id);

            // Only include if it's an exact match OR it's in our validated matching set
            return exactMatch || inMatchingSet;
        });

        return res.status(200).json({ success: true, matches: filteredMatches });

    } catch (error) {
        console.error("Get Public Matches Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch matches",
            error: error.message
        });
    }
};

// Get Matches (Scoreboard)
export const getMatches = async (req, res) => {
    const { eventId } = req.params;
    const { categoryId, categoryName, roundName } = req.query;

    try {
        // Start with base query - fetch all matches for event first
        let query = supabaseAdmin
            .from('matches')
            .select('*')
            .eq('event_id', eventId)
            .order('created_at', { ascending: true });

        // Try to filter by category_id, but if it fails (UUID type mismatch), we'll filter in memory
        let categoryFilterApplied = false;
        if (categoryId) {
            try {
                if (isUuid(categoryId)) {
                    query = query.eq('category_id', categoryId);
                    categoryFilterApplied = true;
                } else {
                    // Non-UUID - try to filter (might fail if column is UUID type)
                    query = query.eq('category_id', categoryId);
                    categoryFilterApplied = true;
                }
            } catch (e) {
                // Filter will be applied in memory if query fails
            }
        }

        // Filter by roundName if provided (do this first as it's most specific)
        if (roundName) {
            query = query.eq('round_name', roundName);
        }

        // Also try categoryName if provided (treat as category_id)
        if (categoryName && !categoryFilterApplied) {
            try {
                query = query.eq('category_id', categoryName);
                categoryFilterApplied = true;
            } catch (e) {
                // Filter will be applied in memory if query fails
            }
        }

        const { data, error } = await query;

        // If error occurs, retry and filter in memory (handles UUID type mismatches)
        if (error) {
            const retryQuery = supabaseAdmin
                .from('matches')
                .select('*')
                .eq('event_id', eventId)
                .order('created_at', { ascending: true });

            const { data: retryData, error: retryError } = await retryQuery;

            if (retryError) {
                throw retryError;
            }

            // Filter in memory (handles all cases including UUID/string mismatches)
            let filteredMatches = retryData || [];

            // Filter by categoryId first (exact match), fall back to categoryName ONLY if categoryId not provided
            if (categoryId) {
                filteredMatches = filteredMatches.filter(m => {
                    const matchCategoryId = m.category_id;
                    if (!matchCategoryId) return false;
                    // Use == for type coercion (handles number vs string)
                    return matchCategoryId == categoryId || String(matchCategoryId) === String(categoryId);
                });
            } else if (categoryName) {
                // Only use categoryName when categoryId is not provided
                filteredMatches = filteredMatches.filter(m => {
                    const matchCategoryId = m.category_id;
                    if (!matchCategoryId) return false;
                    // Exact match with type coercion
                    return matchCategoryId == categoryName || String(matchCategoryId) === String(categoryName);
                });
            }

            // Filter by roundName (exact match or trimmed match)
            if (roundName) {
                filteredMatches = filteredMatches.filter(m => {
                    const matchRoundName = m.round_name;
                    if (!matchRoundName) return false;
                    return String(matchRoundName).trim() === String(roundName).trim();
                });
            }

            return res.status(200).json({ success: true, matches: filteredMatches });
        }

        if (error) throw error;

        // Always do in-memory filtering as fallback to ensure we catch all matches
        // This handles cases where categoryId is stored as number vs string, or UUID vs label
        let finalMatches = data || [];

        if (finalMatches.length > 0 && (categoryId || categoryName)) {
            let filtered = finalMatches;
            const originalCount = finalMatches.length;

            // Try categoryId first (exact match with type coercion)
            if (categoryId) {
                filtered = filtered.filter(m => {
                    const matchCategoryId = m.category_id;
                    if (!matchCategoryId) return false;
                    // Use == for type coercion (handles number vs string)
                    return matchCategoryId == categoryId || String(matchCategoryId) === String(categoryId);
                });
            }

            // If categoryId filter returned 0 matches, try categoryName as fallback
            if (categoryName && filtered.length === 0 && originalCount > 0) {
                // Reset to original matches for categoryName filtering
                filtered = finalMatches;

                filtered = filtered.filter(m => {
                    const matchCategoryId = m.category_id;
                    if (!matchCategoryId) return false;
                    // Exact match with type coercion
                    return matchCategoryId == categoryName || String(matchCategoryId) === String(categoryName);
                });
            }

            finalMatches = filtered;
        }

        return res.status(200).json({ success: true, matches: finalMatches });

    } catch (error) {
        console.error("Get Matches Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch matches",
            error: error.message
        });
    }
};
