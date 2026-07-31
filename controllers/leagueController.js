import { supabaseAdmin } from "../config/supabaseClient.js";
import { createNotification } from "../services/notificationService.js";
import { invalidateMatchesCache } from "../utils/matchesCache.js";

// Simple UUID checker (kept in sync with other controllers)
const isUuid = (str) => {
    if (!str || typeof str !== "string") return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
};

const DB_ID_BATCH_SIZE = 500;

const chunkArray = (arr, size = DB_ID_BATCH_SIZE) => {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
};

/**
 * GET league config for a category
 * GET /api/admin/events/:id/categories/:categoryId/league
 * (categoryId can be UUID or plain label; categoryLabel can also be passed as query)
 * 
 * Now uses dedicated 'leagues' table instead of event_brackets
 */
export const getLeagueConfig = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const categoryLabel = req.query.categoryLabel || req.query.category;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ success: false, message: "Event ID and Category required" });
        }

        //console.log(`📋 Getting league config: eventId=${eventId}, categoryId=${categoryId}, categoryLabel=${categoryLabel}`);

        let query = supabaseAdmin
            .from("leagues")
            .select("*")
            .eq("event_id", eventId);

        // IMPORTANT: Use category_id as primary identifier (can be UUID or string like "1767354643599")
        if (categoryId) {
            query = query.eq("category_id", String(categoryId));
        } else if (categoryLabel) {
            // Use category_label as fallback only if category_id not provided
            query = query.eq("category_label", categoryLabel);
        }

        let { data, error } = await query.maybeSingle();

        if (error && error.code !== "PGRST116") {
            // PGRST116 = no rows found
            throw error;
        }

        // If not found AND categoryId was provided but not UUID, try category_label as fallback
        if (!data && categoryId && !isUuid(categoryId)) {
            const fallbackQuery = supabaseAdmin
                .from("leagues")
                .select("*")
                .eq("event_id", eventId)
                .eq("category_label", String(categoryId));
            
            const { data: fallbackData, error: fallbackError } = await fallbackQuery.maybeSingle();
            if (!fallbackError || fallbackError.code === "PGRST116") {
                data = fallbackData;
            }
        }

        if (!data) {
            // No config yet - return sensible defaults
            //console.log(`ℹ️ No league config found for eventId=${eventId}, categoryId=${categoryId}. Returning defaults.`);
            return res.json({
                success: true,
                league: {
                    format: "LEAGUE",
                    participants: [],
                    rules: {
                        pointsWin: 3,
                        pointsLoss: 0,
                        pointsDraw: 1,
                        win: 3,
                        loss: 0,
                        draw: 1,
                        setsPerMatch: 1
                    }
                }
            });
        }

        const isHeatConfig = data?.rules?.format === "HEAT";

        //console.log(`✅ Found league config: categoryId=${data.category_id}, participants=${data.participants?.length || 0}`);
        
        return res.json({
            success: true,
            league: {
                format: isHeatConfig ? "HEAT" : "LEAGUE",
                participants: Array.isArray(data.participants) ? data.participants : [],
                rules: data.rules || {
                    pointsWin: 3,
                    pointsLoss: 0,
                    pointsDraw: 1,
                    win: 3,
                    loss: 0,
                    draw: 1,
                    setsPerMatch: 1
                }
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: "Failed to fetch league config" });
    }
};

/**
 * Save (create or update) league config for a category
 * POST /api/admin/events/:id/categories/:categoryId/league
 * Body: { categoryLabel, participants: [{id,name}], rules: { pointsWin, pointsLoss, pointsDraw? } }
 *
 * Uses dedicated 'leagues' table for clean separation from event_brackets
 */
export const saveLeagueConfig = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, participants, rules } = req.body || {};

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ success: false, message: "Event ID and Category required" });
        }

        //console.log(`💾 Saving league config: eventId=${eventId}, categoryId=${categoryId}, categoryLabel=${categoryLabel}, participants=${participants?.length || 0}`);

        if (!Array.isArray(participants) || participants.length === 0) {
            return res.status(400).json({ success: false, message: "At least one participant is required" });
        }

        const isHeatConfig = rules?.format === "HEAT";

        // Clean and deduplicate participants
        // LEAGUE: preserve legacy fields used by existing league/team flows.
        // HEAT: preserve payload fields (seed/avatar/etc.) while still validating id/name.
        const participantMap = new Map();
        participants.forEach((p) => {
            if (p && p.id && p.name) {
                const id = String(p.id);
                const name = String(p.name);
                if (!participantMap.has(id)) {
                    if (isHeatConfig) {
                        participantMap.set(id, { ...p, id, name });
                    } else {
                        const group = p.group || p.group_id || p.groupLabel || null;
                        const entry = { id, name, ...(group ? { group: String(group) } : {}) };
                        if (p.isTeam) entry.isTeam = true;
                        if (p.isBye) entry.isBye = true;
                        if (p.teamId) entry.teamId = String(p.teamId);
                        if (p.captainName) entry.captainName = String(p.captainName);
                        if (Array.isArray(p.members) && p.members.length > 0) entry.members = p.members;
                        participantMap.set(id, entry);
                    }
                }
            }
        });

        const cleanedParticipants = Array.from(participantMap.values());

        if (cleanedParticipants.length === 0) {
            return res.status(400).json({ success: false, message: "Participants must have id and name" });
        }

        const defaultRules = {
            pointsWin: 3,
            pointsLoss: 0,
            pointsDraw: 1,
            setsPerMatch: 1
        };

        // Preserve all rule fields for HEAT flow.
        // For LEAGUE, keep current normalisation/backward compatibility.
        const cleanedRules = isHeatConfig ? {
            ...rules,
            format: "HEAT"
        } : {
            // Support both frontend format (win/loss/draw) and backend format (pointsWin/pointsLoss/pointsDraw)
            win: typeof rules?.win === "number" ? rules.win : (typeof rules?.pointsWin === "number" ? rules.pointsWin : defaultRules.pointsWin),
            loss: typeof rules?.loss === "number" ? rules.loss : (typeof rules?.pointsLoss === "number" ? rules.pointsLoss : defaultRules.pointsLoss),
            draw: typeof rules?.draw === "number" ? rules.draw : (typeof rules?.pointsDraw === "number" ? rules.pointsDraw : defaultRules.pointsDraw),
            // Also preserve setsPerMatch if provided
            setsPerMatch: typeof rules?.setsPerMatch === "number" ? rules.setsPerMatch : defaultRules.setsPerMatch,
            // Preserve winner mode (set_based, score_based, or match_based)
            ...(rules?.winnerMode && ['set_based', 'score_based', 'match_based'].includes(rules.winnerMode) ? { winnerMode: rules.winnerMode } : {}),
            // Preserve league mode (regular or team)
            ...(rules?.leagueMode ? { leagueMode: String(rules.leagueMode) } : {}),
            // Keep backend format fields for backward compatibility
            pointsWin: typeof rules?.pointsWin === "number" ? rules.pointsWin : (typeof rules?.win === "number" ? rules.win : defaultRules.pointsWin),
            pointsLoss: typeof rules?.pointsLoss === "number" ? rules.pointsLoss : (typeof rules?.loss === "number" ? rules.loss : defaultRules.pointsLoss),
            pointsDraw: typeof rules?.pointsDraw === "number" ? rules.pointsDraw : (typeof rules?.draw === "number" ? rules.draw : defaultRules.pointsDraw),
            // Preserve team league definitions if provided
            ...(Array.isArray(rules?.teams) && rules.teams.length > 0 ? { teams: rules.teams } : {}),
            // Preserve directKnockout flag (teams sent straight to knockout, no league rounds)
            ...(rules?.directKnockout === true ? { directKnockout: true } : {}),
            // Preserve player ranks assigned by admin in league tab
            ...(rules?.playerRanks && typeof rules.playerRanks === 'object' && Object.keys(rules.playerRanks).length > 0 ? { playerRanks: rules.playerRanks } : {})
        };

        // Determine category_id and category_label
        // category_id can be UUID or string/number ID (like "1767354643599")
        // Store the categoryId as-is if provided (leagues.category_id is TEXT, so accepts any string)
        const categoryIdValue = categoryId ? String(categoryId) : null;
        let categoryLabelValue = categoryLabel || categoryId || "Unknown";

        // HEAT rounds are stored using category_id keys such as <base>_HR2.
        // Use category_id as label to avoid round collisions in environments where
        // leagues table unique constraints include category_label.
        if (isHeatConfig && categoryIdValue) {
            categoryLabelValue = categoryIdValue;
        }

        // FIX: If we already have a record for this category_id, use ITS category_label
        // to prevent creating duplicate rows when categoryLabel differs between calls
        if (categoryIdValue) {
            const { data: existing } = await supabaseAdmin
                .from("leagues")
                .select("category_label")
                .eq("event_id", eventId)
                .eq("category_id", categoryIdValue)
                .maybeSingle();
            if (existing && existing.category_label) {
                categoryLabelValue = existing.category_label;
            }
        }

        //console.log(`📝 UPSERT VALUES: eventId=${eventId}, categoryId=${categoryIdValue}, categoryLabel=${categoryLabelValue} (will be used in UNIQUE constraint)`);

        // UPSERT: Use atomic insert-or-update to avoid race conditions
        // This handles concurrent requests to create the same (event_id, category_label) pair
       // console.log(`📝 Upserting league for categoryId=${categoryId}, categoryLabel=${categoryLabelValue}`);
        
        const upsertPayload = {
            event_id: eventId,
            category_id: categoryIdValue,
            category_label: categoryLabelValue,
            participants: cleanedParticipants,
            rules: cleanedRules,
            updated_at: new Date().toISOString()
        };

        let data = null;
        let error = null;

        if (isHeatConfig && categoryIdValue) {
            const { data: existingByCategoryId } = await supabaseAdmin
                .from("leagues")
                .select("id")
                .eq("event_id", eventId)
                .eq("category_id", categoryIdValue)
                .maybeSingle();

            if (existingByCategoryId?.id) {
                ({ data, error } = await supabaseAdmin
                    .from("leagues")
                    .update(upsertPayload)
                    .eq("id", existingByCategoryId.id)
                    .select()
                    .maybeSingle());
            } else {
                ({ data, error } = await supabaseAdmin
                    .from("leagues")
                    .insert(upsertPayload)
                    .select()
                    .maybeSingle());
            }
        } else {
            ({ data, error } = await supabaseAdmin
                .from("leagues")
                .upsert(upsertPayload, {
                    onConflict: "event_id,category_label"
                })
                .select()
                .maybeSingle());
        }

        if (error) {
            console.error(`❌ Upsert failed for categoryId=${categoryId}: ${error.code} - ${error.message}`);
            throw error;
        }

        
        //console.log(`✅ League saved successfully for categoryId=${categoryId}`);

        return res.status(201).json({
            success: true,
            league: {
                format: isHeatConfig ? "HEAT" : "LEAGUE",
                participants: cleanedParticipants,
                rules: cleanedRules
            },
            leagueId: data.id,
            message: "League configuration saved"
        });
    } catch (err) {
        console.error(`🚨 SaveLeagueConfig ERROR: ${err.message || err.code || err}`);
        return res.status(500).json({ success: false, message: err.message || "Failed to save league config", errorCode: err.code });
    }
};

/**
 * Send league promotion notifications to promoted players/team members.
 * POST /api/admin/events/:id/categories/:categoryId/league/notify-promotions
 */
export const notifyLeaguePromotions = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const {
            categoryLabel,
            completedRoundName,
            nextRoundName,
            promotionType,
            promotions,
        } = req.body || {};

        if (!eventId) {
            return res.status(400).json({ success: false, message: "Event ID required" });
        }

        if (!Array.isArray(promotions) || promotions.length === 0) {
            return res.json({ success: true, notified: 0, duplicates: 0 });
        }

        // Sanitize variable segments so colons (our delimiter) don't corrupt the key.
        const sanitizeSegment = (s) => String(s).replace(/:/g, "-");
        const categoryKey = sanitizeSegment(String(categoryId || categoryLabel || "unknown-category").trim());
        const safeCompletedRound = sanitizeSegment(String(completedRoundName || "League Stage").trim());
        const safeNextRound = sanitizeSegment(String(nextRoundName || "Next Round").trim());
        const safePromotionType = promotionType === "knockout" ? "knockout" : "next-round";

        const formatSummary = (promotion) => {
            const segments = [];
            const points = Number(promotion?.points);
            const played = Number(promotion?.played);
            const wins = Number(promotion?.wins);
            const draws = Number(promotion?.draws);
            const losses = Number(promotion?.losses);
            const totalScore = Number(promotion?.totalScore);
            const matchWins = Number(promotion?.matchWins);

            if (Number.isFinite(points)) segments.push(`${points} pts`);
            if (Number.isFinite(played) || Number.isFinite(wins) || Number.isFinite(draws) || Number.isFinite(losses)) {
                segments.push(`P${Number.isFinite(played) ? played : 0} W${Number.isFinite(wins) ? wins : 0} D${Number.isFinite(draws) ? draws : 0} L${Number.isFinite(losses) ? losses : 0}`);
            }
            if (Number.isFinite(totalScore) && totalScore > 0) segments.push(`Score ${totalScore}`);
            if (Number.isFinite(matchWins) && matchWins > 0) segments.push(`Match wins ${matchWins}`);
            return segments.join(" | ");
        };

        const truncateMembers = (memberNames) => {
            if (!Array.isArray(memberNames) || memberNames.length === 0) return "";
            const MAX_NAME_LEN = 30;
            const names = memberNames
                .map((name) => {
                    const s = String(name || "").trim();
                    return s.length > MAX_NAME_LEN ? s.slice(0, MAX_NAME_LEN) + "…" : s;
                })
                .filter(Boolean);
            if (names.length === 0) return "";
            if (names.length <= 3) return names.join(", ");
            return `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
        };

        // Request-scoped cache: if the same player_id appears in multiple promotions
        // within a single request, the DB is only hit once per unique ID.
        const recipientIdCache = new Map();

        const resolveNotificationUserId = async (rawRecipientId) => {
            const normalizedId = String(rawRecipientId || "").trim();
            if (!normalizedId) return null;
            if (isUuid(normalizedId)) return normalizedId;

            if (recipientIdCache.has(normalizedId)) return recipientIdCache.get(normalizedId);

            const { data: userByPlayerCode, error: playerCodeError } = await supabaseAdmin
                .from("users")
                .select("id")
                .eq("player_id", normalizedId)
                .limit(1)
                .maybeSingle();

            if (playerCodeError) {
                console.error("[notifyLeaguePromotions] User lookup by player_id failed:", playerCodeError);
            }
            const resolved = userByPlayerCode?.id && isUuid(String(userByPlayerCode.id))
                ? String(userByPlayerCode.id)
                : null;

            recipientIdCache.set(normalizedId, resolved);
            return resolved;
        };

        const results = await Promise.allSettled(
            promotions.map(async (promotion) => {
                // Guard against null / non-object entries in the promotions array
                if (!promotion || typeof promotion !== "object") {
                    return { status: "skipped", sent: 0, duplicates: 0 };
                }

                const entityId = String(promotion?.entityId || promotion?.playerId || "").trim();
                const entityName = String(promotion?.entityName || promotion?.playerName || "Player").trim();
                const sourceGroup = String(promotion?.sourceGroup || "").trim();
                const destinationGroup = String(promotion?.destinationGroup || "").trim();
                const sourcePosition = Number(promotion?.sourcePosition);
                const memberNames = Array.isArray(promotion?.memberNames) ? promotion.memberNames : [];
                const explicitRecipients = Array.isArray(promotion?.recipientIds)
                    ? promotion.recipientIds.map((id) => String(id || "").trim()).filter(Boolean)
                    : [];

                // Use a clearly-named final variable; avoid multiple reassignments
                const rawFinalRecipientIds = explicitRecipients.length > 0
                    ? explicitRecipients
                    : entityId ? [entityId] : [];

                if (rawFinalRecipientIds.length === 0) {
                    return { status: "skipped" };
                }

                const dedupeLink = `league-promotion:${eventId}:${categoryKey}:${safeCompletedRound}:${safeNextRound}:${safePromotionType}:${entityId || rawFinalRecipientIds.join(",")}`;
                const summary = formatSummary(promotion);
                const placeText = Number.isFinite(sourcePosition) ? `#${sourcePosition}` : "qualified";
                const groupText = sourceGroup ? `Group ${sourceGroup}` : "the league stage";
                const destinationText = safePromotionType === "knockout"
                    ? `the knockout bracket${destinationGroup ? ` (${destinationGroup})` : ""}`
                    : `${safeNextRound}${destinationGroup ? ` in Group ${destinationGroup}` : ""}`;
                const teamDetail = truncateMembers(memberNames);

                const title = safePromotionType === "knockout"
                    ? `🏆 Promoted to Knockout Bracket`
                    : `🏆 Promoted to ${safeNextRound}`;
                const message = [
                    `You finished ${placeText} in ${groupText} and have been promoted to ${destinationText}.`,
                    summary ? `Standing: ${summary}.` : "",
                    teamDetail ? `Team members: ${teamDetail}.` : "",
                    categoryLabel ? `Category: ${categoryLabel}.` : "",
                ].filter(Boolean).join(" ");

                // Resolve all raw IDs to UUIDs concurrently (avoid sequential awaits in loop)
                const resolvedIds = await Promise.all(
                    rawFinalRecipientIds.map(resolveNotificationUserId)
                );
                const finalRecipientIds = resolvedIds.filter((id, i) => {
                    if (!id) console.warn(`[notifyLeaguePromotions] Skipping unresolved recipient: ${rawFinalRecipientIds[i]}`);
                    return Boolean(id);
                });

                if (finalRecipientIds.length === 0) {
                    return { status: "skipped", sent: 0, duplicates: 0 };
                }

                // Single batched dedupe query instead of one query per recipient
                const { data: existingRows, error: existingError } = await supabaseAdmin
                    .from("notifications")
                    .select("user_id")
                    .in("user_id", finalRecipientIds)
                    .eq("link", dedupeLink);

                if (existingError) {
                    console.error("[notifyLeaguePromotions] Dedupe check failed:", existingError);
                }

                const alreadyNotified = new Set((existingRows || []).map((r) => r.user_id));
                const toNotify = finalRecipientIds.filter((id) => !alreadyNotified.has(id));
                const duplicates = finalRecipientIds.length - toNotify.length;

                const sendResults = await Promise.all(
                    toNotify.map((recipientId) =>
                        createNotification(recipientId, title, message, "success", dedupeLink)
                    )
                );
                const sent = sendResults.filter(Boolean).length;

                return { status: sent > 0 ? "sent" : "duplicate", sent, duplicates };
            })
        );

        const summary = results.reduce(
            (acc, result) => {
                if (result.status !== "fulfilled" || !result.value || typeof result.value !== "object") return acc;
                acc.notified += Number(result.value.sent) || 0;
                acc.duplicates += Number(result.value.duplicates) || 0;
                return acc;
            },
            { notified: 0, duplicates: 0 }
        );

        return res.json({
            success: true,
            notified: summary.notified,
            duplicates: summary.duplicates,
        });
    } catch (err) {
        console.error("notifyLeaguePromotions error:", err);
        return res.status(500).json({ success: false, message: "Failed to send promotion notifications" });
    }
};

/**
 * DELETE league configuration and optionally all associated matches
 * DELETE /api/admin/events/:id/categories/:categoryId/league
 * Query params: deleteMatches (optional, default: true) - whether to delete associated matches
 * 
 * This will:
 * 1. Delete the league record from the 'leagues' table
 * 2. Optionally delete all matches with round_name='LEAGUE' for this category
 */
export const deleteLeague = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const categoryLabel = req.query.categoryLabel || req.query.category;
        const deleteMatches = req.query.deleteMatches !== 'false'; // Default: true

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ success: false, message: "Event ID and Category required" });
        }

        // Find the league record
        // Use category_id as PRIMARY lookup (works for both UUID and non-UUID like "1767354643599")
        let query = supabaseAdmin
            .from("leagues")
            .select("*")
            .eq("event_id", eventId);

        if (categoryId) {
            query = query.eq("category_id", String(categoryId));
        } else if (categoryLabel) {
            query = query.eq("category_label", categoryLabel);
        }

        let { data: leagueRecord, error: fetchError } = await query.maybeSingle();

        const isRoundScopedCategoryId = categoryId && /_R\d+$/i.test(String(categoryId).trim());

        // Fallback: if not found by category_id and it's non-UUID, try category_label.
        // IMPORTANT: never do this for explicit round-scoped IDs (e.g. <base>_R2),
        // otherwise a malformed/legacy row can map deletion to the wrong round.
        if (!leagueRecord && categoryId && !isUuid(categoryId) && !isRoundScopedCategoryId) {
            const fallbackQuery = supabaseAdmin
                .from("leagues")
                .select("*")
                .eq("event_id", eventId)
                .eq("category_label", categoryLabel || String(categoryId));
            const { data: fallbackData, error: fallbackError } = await fallbackQuery.maybeSingle();
            if (!fallbackError || fallbackError?.code === "PGRST116") {
                leagueRecord = fallbackData;
                fetchError = null;
            }
        }

        if (fetchError && fetchError.code !== "PGRST116") {
            throw fetchError;
        }

        if (!leagueRecord) {
            return res.status(404).json({
                success: false,
                message: "League configuration not found"
            });
        }

        // Optionally delete associated matches
        if (deleteMatches) {
            // Get category identifier for match deletion
            const categoryIdForMatches = leagueRecord.category_id || categoryId || categoryLabel;
            const categoryLabelForMatches = leagueRecord.category_label || categoryLabel || categoryId;

            // CRITICAL FIX: Use safe in-memory filtering instead of dangerous fallback
            // This prevents accidentally deleting matches from other categories

            // First, fetch all LEAGUE matches for this event
            const { data: allLeagueMatches, error: fetchMatchesError } = await supabaseAdmin
                .from("matches")
                .select("id, category_id, event_id, round_name")
                .eq("event_id", eventId)
                .eq("round_name", "LEAGUE");

            if (fetchMatchesError) {
                // Continue with league deletion even if match fetch fails
            } else {
                // Filter matches in memory to ensure exact category match
                // This is safer than database-level filtering which might fail
                const matchesToDelete = (allLeagueMatches || []).filter(m => {
                    const mCatId = m.category_id;
                    if (!mCatId) return false;

                    // Use strict string comparison only
                    if (String(mCatId) === String(categoryIdForMatches)) {
                        return true;
                    }

                    // If categoryIdForMatches is not available, use category_label matching
                    // This is a fallback but should be avoided
                    if (!categoryIdForMatches && categoryLabelForMatches) {
                        // Note: matches table doesn't have category_label, so we can't match by label
                        // This is why we require category_id
                        return false;
                    }

                    return false;
                });

                if (matchesToDelete.length > 0) {
                    const matchIds = matchesToDelete.map(m => m.id);
                    let totalDeleted = 0;

                    // Delete only the filtered matches, in chunks for large categories.
                    for (const idChunk of chunkArray(matchIds)) {
                        const { data: deletedChunk, error: matchDeleteError } = await supabaseAdmin
                            .from("matches")
                            .delete()
                            .in("id", idChunk)
                            .select("id");

                        if (matchDeleteError) {
                            // Continue with league deletion even if match deletion fails
                            break;
                        }

                        totalDeleted += deletedChunk?.length || 0;
                    }
                } else {
                }
            }
        }

        await invalidateMatchesCache(eventId);

        // Delete the league record
        const { error: deleteError } = await supabaseAdmin
            .from("leagues")
            .delete()
            .eq("id", leagueRecord.id);

        if (deleteError) {
            throw deleteError;
        }

        return res.json({
            success: true,
            message: deleteMatches
                ? "League configuration and all associated matches deleted successfully"
                : "League configuration deleted successfully (matches preserved)",
            deletedLeagueId: leagueRecord.id
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: "Failed to delete league configuration",
            error: err.message
        });
    }
};
