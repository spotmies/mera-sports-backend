import { supabaseAdmin } from "../config/supabaseClient.js";

/**
 * How a category is addressed in `event_brackets` and `matches`.
 *
 * There are three keys in play, and rows written at different times use
 * different ones:
 *
 *   - `event_brackets.category_id` — a real UUID column, so it is populated ONLY
 *     when the category's id is a UUID. Every category the event form creates
 *     has a numeric-string id instead, and those rows leave it null.
 *   - `event_brackets.category` holding the **id** — how non-UUID categories are
 *     keyed now that brackets are id-keyed.
 *   - `event_brackets.category` holding the **label** — how those same categories
 *     were keyed before, and still the only key legacy rows have.
 *
 * `matches.category_id` is a *text* column, unrelated to the UUID column above:
 * it carries whatever key its bracket's matches were written with.
 *
 * Splitting these rules across controllers is what let a freshly generated
 * league bracket report "Bracket Not Initialized" — init wrote the row under the
 * numeric id while every follow-up call searched for the label. The rules live
 * here once so the writers and the readers cannot drift apart again.
 */

// Relaxed UUID v4 check (standard 36-char form).
export const isUuid = (value) => {
    if (!value || typeof value !== "string") return false;
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        value.trim()
    );
};

// Round-scoped ids ("<categoryId>_R2") address ONE round of a category, never the
// category itself. They must never fall back to the category label, or publishing
// round 2 would publish the base category's rows with it.
export const isRoundScopedId = (value) => /_R\d+$/i.test(String(value || "").trim());

/**
 * Resolve every `event_brackets` row belonging to one category.
 *
 * The id is authoritative. The label is a legacy tier, consulted only when the
 * id owns no bracket of its own — which is exactly the case of a category whose
 * bracket predates id-keying. It cannot merge two categories that share a label
 * but each already have their own bracket, and it is never consulted for a
 * round-scoped id.
 *
 * The "owns no bracket" test rather than "owns no rows at all" matters: the
 * league/pool publish path writes an id-keyed MEDIA placeholder alongside a
 * label-keyed BRACKET, so a category can hold rows under the id and still have
 * its bracket under the label.
 *
 * @param {string} eventId
 * @param {string} [categoryId]     UUID or non-UUID category id
 * @param {string} [categoryLabel]  human label, e.g. "U-15 (Mixed) - Singles"
 * @param {{ mode?: string }} [options] restrict to one `mode` ("BRACKET"/"MEDIA")
 * @returns {Promise<Array>} matching rows, id-keyed ones first, each set oldest first
 */
export const fetchCategoryBracketRows = async (eventId, categoryId, categoryLabel, { mode } = {}) => {
    const id = String(categoryId ?? "").trim();
    const label = String(categoryLabel ?? "").trim();

    const run = async (column, value) => {
        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq(column, value);
        if (mode) query = query.eq("mode", mode);
        const { data, error } = await query.order("created_at", { ascending: true });
        if (error) throw error;
        return data || [];
    };

    if (id && isUuid(id)) {
        // UUID categories always carry `category_id`; matching anything else here
        // is what let a same-named sibling's bracket bleed in.
        return run("category_id", id);
    }

    if (id) {
        const byId = await run("category", id);
        const canFallBack = Boolean(label) && label !== id && !isRoundScopedId(id);
        // With a `mode` filter `byId` is already narrowed to it, so "owns one" is
        // just "is non-empty".
        const ownsOne = mode ? byId.length > 0 : byId.some((row) => row.mode === "BRACKET");
        if (!canFallBack || ownsOne) return byId;

        const byLabel = await run("category", label);
        const seen = new Set(byId.map((row) => row.id));
        return [...byId, ...byLabel.filter((row) => !seen.has(row.id))];
    }

    if (label) return run("category", label);
    return [];
};

/**
 * The value `matches.category_id` must carry for a bracket's matches.
 *
 * Every reader filters this column with the category id the UI holds, so that is
 * what has to be written — not the label. Writing the label is what split event
 * 42's bracket from its own matches: the bracket row lived under "1785400000042"
 * and its matches under "U-15 (Mixed) - Singles", so the category looked empty
 * from both ends.
 */
export const resolveMatchCategoryKey = (categoryId, categoryLabel, bracketRow) =>
    (categoryId ? String(categoryId) : null) ||
    bracketRow?.category_id ||
    bracketRow?.category ||
    categoryLabel ||
    null;
