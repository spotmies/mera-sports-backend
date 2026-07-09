/**
 * BRACKET HELPERS - Shared Utilities
 * 
 * Purpose: Centralized utility functions used across all bracket modules
 * No business logic - only pure utilities and validation helpers
 * 
 * Used by: All bracket controllers
 * Status: ZERO logic changes from original bracketController.js
 */


/**
 * UUID Validator (relaxed - standard 36-char format)
 * @param {*} value
 * @returns {boolean}
 */
export const isUuid = (value) => {
    if (!value || typeof value !== "string") return false;
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        value.trim()
    );
};

/**
 * Round Name Normalization (trim + lowercase)
 * @param {string} s
 * @returns {string}
 */
export const normalizeRoundName = (s) => String(s ?? "").trim().toLowerCase();

/**
 * Check if bracket has structured knockout (feeder/winnerTo linkage)
 * @param {object} bracketData
 * @returns {boolean}
 */
export const isStructuredKnockout = (bracketData) => {
    const rounds = bracketData?.rounds || [];
    if (rounds.length <= 1) return false;
    const firstRound = rounds[0];
    const firstMatch = firstRound?.matches?.[0];
    return !!(firstMatch && (firstMatch.winnerTo != null || firstMatch.feederMatch1 != null));
};

/**
 * Infer round label from match count (e.g., 1 match = "Final")
 * @param {number} matchCount
 * @param {number} fallbackIndex
 * @returns {string}
 */
export const inferRoundLabelFromMatchCount = (matchCount, fallbackIndex) => {
    if (matchCount === 1) return "Final";
    if (matchCount === 2) return "Semifinal";
    if (matchCount === 4) return "Quarterfinal";
    return `Round ${fallbackIndex + 1}`;
};

/**
 * Detect if a player object is a fake BYE marker
 * @param {object|null} p
 * @returns {boolean}
 */
export const isFakeByePlayer = (p) => {
    if (!p) return true;
    if (typeof p === "string") return String(p).trim().toLowerCase() === "bye";
    if (typeof p === "object") {
        const name = (p.name || "").toString().trim().toUpperCase();
        const id = (p.id ?? p.player_id ?? p.playerId ?? "").toString().trim().toLowerCase();
        return name === "BYE" || id === "bye";
    }
    return false;
};

/**
 * Check if a player is real (not null, not fake BYE, has valid ID)
 * @param {object} p
 * @returns {boolean}
 */
export const hasRealPlayer = (p) => 
    p && !isFakeByePlayer(p) && (p.id || p.player_id);

/**
 * Extract seed source (global + by-round overrides)
 * @param {object} bracketData
 * @param {string} roundName
 * @returns {object} seedSource with global and byRound properties
 */
export const getSeedSource = (bracketData, roundName) => {
    const bd = bracketData || {};
    const global =
        (bd.playerRanks && typeof bd.playerRanks === "object" ? bd.playerRanks : null) ||
        (bd.player_ranks && typeof bd.player_ranks === "object" ? bd.player_ranks : null) ||
        {};
    const byRound =
        (roundName && bd.playerRanksByRound && bd.playerRanksByRound[roundName]) ||
        (roundName && bd.player_ranks_by_round && bd.player_ranks_by_round[roundName]) ||
        {};
    return { global, byRound };
};

/**
 * Get seed value for a player (from global or round-specific ranks)
 * @param {string} playerId
 * @param {object} bracketData
 * @param {string} roundName
 * @returns {number|null}
 */
export const getSeedValue = (playerId, bracketData, roundName) => {
    if (!playerId) return null;
    const seedSource = getSeedSource(bracketData, roundName);
    const k = String(playerId).trim();
    if (!k) return null;
    const v = seedSource.byRound?.[k] ?? seedSource.global?.[k];
    const n = typeof v === "string" ? parseInt(v, 10) : v;
    return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Shuffle array in-place (Fisher-Yates algorithm)
 * @param {array} arr
 * @returns {array}
 */
export const shuffle = (arr) => {
    const a = Array.isArray(arr) ? [...arr] : [];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};

/**
 * Check if player is seeded (has a rank value)
 * @param {object} player
 * @param {object} bracketData
 * @param {string} roundName
 * @returns {boolean}
 */
export const isSeededLocal = (player, bracketData, roundName) => {
    if (!player) return false;
    const playerId = player.id || player.player_id;
    return getSeedValue(playerId, bracketData, roundName) != null;
};

/**
 * Check if a match is a ranked BYE (must be locked)
 * @param {object} match
 * @param {object} bracketData
 * @param {string} firstRoundName
 * @returns {boolean}
 */
export const isRankedBye = (match, bracketData, firstRoundName) => {
    if (!match || !bracketData || !firstRoundName) return false;

    const hasRealPlayer = (p) => p && !isFakeByePlayer(p) && (p.id || p.player_id);
    const p1 = hasRealPlayer(match.player1) ? match.player1 : null;
    const p2 = hasRealPlayer(match.player2) ? match.player2 : null;

    // Must be a BYE (one player, one empty)
    const isBye = (p1 && !p2) || (!p1 && p2);
    if (!isBye) return false;

    // Check if the existing player has a seed
    const existingPlayerId = p1 ? (p1.id || p1.player_id || p1.playerId) : (p2 ? (p2.id || p2.player_id || p2.playerId) : null);
    return existingPlayerId && getSeedValue(existingPlayerId, bracketData, firstRoundName) != null;
};

/**
 * Create empty match structure
 * @param {string|null} idOverride
 * @returns {object}
 */
export const makeEmptyMatch = (idOverride) => ({
    id: idOverride || `match-${Date.now()}-${Math.random()}`,
    player1: null,
    player2: null,
    winner: null,
    score: null // Structure only - not authoritative
});

/**
 * Legacy round name placeholders (backward compatibility)
 */
export const LEGACY_ROUND_NAME_MEDIA = "Draws";
export const LEGACY_ROUND_NAME_BRACKET = "Bracket";
