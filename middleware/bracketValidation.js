import { supabaseAdmin } from "../config/supabaseClient.js";

/**
 * Validates bracket structure before Semifinal/Final propagation.
 * Ensures: every match has id; rounds 2+ have winnerTo/winnerToSlot; match counts follow 2^(n-r).
 * Returns { valid: boolean, errors: string[] }. Use before finalize or in admin tools.
 */
export function validateBracketIntegrity(bracketData) {
    const errors = [];
    const rounds = Array.isArray(bracketData?.rounds) ? bracketData.rounds : [];
    if (rounds.length === 0) {
        return { valid: false, errors: ["No rounds in bracket_data"] };
    }

    const roundCount = rounds.length;
    const expectedMatchCount = (rIndex) => Math.pow(2, roundCount - 1 - rIndex);

    for (let rIdx = 0; rIdx < rounds.length; rIdx++) {
        const round = rounds[rIdx];
        const name = round?.name != null ? String(round.name).trim() : "";
        const matches = Array.isArray(round.matches) ? round.matches : [];
        const expected = expectedMatchCount(rIdx);

        if (matches.length !== expected) {
            errors.push(`Round "${name || rIdx}" has ${matches.length} matches, expected ${expected}`);
        }

        for (let mIdx = 0; mIdx < matches.length; mIdx++) {
            const m = matches[mIdx];
            if (!m || !m.id) {
                errors.push(`Round "${name}" match ${mIdx + 1} missing id`);
            }
            // All rounds except the last must have winnerTo/winnerToSlot for propagation
            if (rIdx < roundCount - 1 && (m?.winnerTo == null || m?.winnerToSlot == null)) {
                errors.push(`Round "${name}" match ${mIdx + 1} (${m?.id}) missing winnerTo/winnerToSlot`);
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Middleware to validate mode locking
 * Ensures category can only be in MEDIA or BRACKET mode, not both
 */
export const validateModeLock = async (req, res, next) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel } = req.body;
        const mode = req.body.mode || (req.path.includes('bracket') ? 'BRACKET' : 'MEDIA');

        if (!eventId) {
            return res.status(400).json({ message: "Event ID required" });
        }

        let query = supabaseAdmin
            .from("event_brackets")
            .select("id, mode")
            .eq("event_id", eventId);

        if (categoryId) {
            query = query.eq("category_id", categoryId);
        } else if (categoryLabel) {
            query = query.eq("category", categoryLabel);
        } else {
            return next(); // Skip validation if category not specified
        }

        const { data: existing, error } = await query;

        if (error) throw error;

        if (existing && existing.length > 0) {
            const conflictingMode = existing.find(b => b.mode !== mode);
            if (conflictingMode) {
                return res.status(400).json({
                    message: `Category already has ${conflictingMode.mode} mode. Cannot use ${mode} mode. Delete existing draw first.`,
                    code: "MODE_CONFLICT",
                    existingMode: conflictingMode.mode
                });
            }
        }

        next();
    } catch (err) {
        console.error("MODE VALIDATION ERROR:", err);
        res.status(500).json({ message: "Validation error", error: err.message });
    }
};

/**
 * Middleware to validate player belongs to category
 */
export const validatePlayerInCategory = async (req, res, next) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, player1, player2 } = req.body;

        // Get category from event
        const { data: event, error: eventError } = await supabaseAdmin
            .from("events")
            .select("categories")
            .eq("id", eventId)
            .single();

        if (eventError) throw eventError;

        const categories = event.categories || [];
        let targetCategory = null;

        if (categoryId) {
            targetCategory = categories.find(c => c.id === categoryId);
        } else if (categoryLabel) {
            targetCategory = categories.find(c => {
                const catName = typeof c === 'object' ? c.name : c;
                const catGender = typeof c === 'object' ? c.gender : null;
                const catMatchType = typeof c === 'object' ? (c.match_type || c.matchType) : null;
                const label = catMatchType 
                    ? `${catName} - ${catGender} - ${catMatchType}`
                    : `${catName} - ${catGender}`;
                return label === categoryLabel;
            });
        }

        if (!targetCategory) {
            return res.status(400).json({ message: "Category not found in event" });
        }

        // Validate players are verified registrations for this category
        if (player1 || player2) {
            const playerIds = [];
            if (player1) {
                const p1Id = typeof player1 === 'object' ? player1.id : player1;
                if (p1Id) playerIds.push(p1Id);
            }
            if (player2) {
                const p2Id = typeof player2 === 'object' ? player2.id : player2;
                if (p2Id) playerIds.push(p2Id);
            }

            if (playerIds.length > 0) {
                const { data: registrations, error: regError } = await supabaseAdmin
                    .from("event_registrations")
                    .select("player_id, categories, status")
                    .eq("event_id", eventId)
                    .in("player_id", playerIds)
                    .in("status", ["verified", "paid", "confirmed", "approved"]);

                if (regError) throw regError;

                // Check each player is verified and registered for this category
                for (const playerId of playerIds) {
                    const reg = registrations.find(r => r.player_id === playerId);
                    if (!reg) {
                        return res.status(400).json({ 
                            message: `Player ${playerId} is not registered for this event`,
                            code: "PLAYER_NOT_REGISTERED"
                        });
                    }

                    if (!["verified", "paid", "confirmed", "approved"].includes(reg.status)) {
                        return res.status(400).json({ 
                            message: `Player ${playerId} registration is not verified`,
                            code: "PLAYER_NOT_VERIFIED"
                        });
                    }

                    // Check category match (simplified - can be enhanced)
                    const regCats = Array.isArray(reg.categories) ? reg.categories : [reg.categories];
                    const categoryMatch = regCats.some(c => {
                        const catName = typeof c === 'object' ? c.name : c;
                        const targetName = typeof targetCategory === 'object' ? targetCategory.name : targetCategory;
                        return catName === targetName || catName === categoryLabel;
                    });

                    if (!categoryMatch) {
                        return res.status(400).json({ 
                            message: `Player ${playerId} is not registered for this category`,
                            code: "PLAYER_WRONG_CATEGORY"
                        });
                    }
                }
            }
        }

        next();
    } catch (err) {
        console.error("PLAYER VALIDATION ERROR:", err);
        res.status(500).json({ message: "Validation error", error: err.message });
    }
};
