/**
 * "Does this registration belong to this category?" — the backend copy of
 * sports-admin-hub/src/utils/categoryMatching.ts. Keep the two in step.
 *
 * The rule: **when both sides carry a category id, the id decides — including
 * when it says no.** Name matching is only a fallback for legacy rows where one
 * side has no id, and it compares normalized names for equality, never
 * substrings.
 *
 * The controllers this replaced only trusted the id when it was a UUID. Every
 * category the event form creates has a numeric id, so they all fell through
 * to a substring/prefix name match. Measured on QA (Oct 2026), that put
 * entrants of one category into another's bracket in 6 categories ("All
 * (Male)" swallowing the Mixed entry), and found nobody at all in 2 categories
 * that had been renamed after players registered ("Above 17" vs the stored
 * "U-15"), so starting those brackets failed with "At least 2 players".
 */

const DECORATION_TOKENS = /^(male|female|mixed|open|singles|doubles|team)$/i;
const GENDER_TOKENS = /^(male|female|mixed|open)$/i;
const MATCH_TYPE_TOKENS = /^(singles|doubles|mixed doubles|team)$/i;

const normalizeToken = (raw) => String(raw ?? "").trim().toLowerCase();

const normalizeId = (raw) => {
    if (raw === null || raw === undefined || raw === "") return "";
    if (typeof raw === "object") return normalizeId(raw.id ?? raw.categoryId ?? raw.category_id);
    return String(raw).trim();
};

/** "U-17 (Mixed)" → "u-17"; "Open (Elite)" keeps its qualifier. */
export const normalizeCategoryName = (raw) => {
    let name = String(raw ?? "").trim();
    if (!name) return "";
    name = name.replace(/\s*\(([^()]*)\)\s*$/, (whole, inner) =>
        DECORATION_TOKENS.test(String(inner).trim()) ? "" : whole
    );
    return name.trim().toLowerCase().replace(/\s+/g, " ");
};

/**
 * Parse "<name> - <gender> - <matchType>" (segments classified by content, as
 * LeagueTab omits the gender segment for Mixed categories).
 */
export const parseCategoryLabel = (label) => {
    const parts = String(label ?? "").split(" - ").map((p) => p.trim()).filter(Boolean);
    const rawName = parts[0] || "";
    let gender = normalizeToken(rawName.match(/\((male|female|mixed|open)\)/i)?.[1]);
    let matchType = "";
    for (const part of parts.slice(1)) {
        const token = normalizeToken(part);
        if (!gender && GENDER_TOKENS.test(token)) gender = token;
        else if (!matchType && MATCH_TYPE_TOKENS.test(token)) matchType = token;
    }
    return { name: normalizeCategoryName(rawName), gender, matchType };
};

/** Target from the id + label a request carries. */
export const buildCategoryTarget = (categoryId, categoryLabel) => ({
    id: normalizeId(categoryId),
    ...parseCategoryLabel(categoryLabel),
});

const registrationCategories = (registration) => {
    if (!registration) return [];
    if (Array.isArray(registration.categories)) return registration.categories;
    if (registration.categories) return [registration.categories];
    if (registration.category) return [registration.category];
    return [];
};

// Legacy fallback — only reached when one side has no id. A registration
// recorded as "Mixed" or with no gender is admitted to a gendered category, as
// older rows frequently carry neither.
const matchesByName = (entry, target, registration) => {
    const isObject = entry && typeof entry === "object";
    const entryName = normalizeCategoryName(isObject ? (entry.name ?? entry.category) : entry);
    if (!entryName || !target.name || entryName !== target.name) return false;

    if (target.gender && target.gender !== "mixed" && target.gender !== "open") {
        const entryGender = normalizeToken((isObject ? entry.gender : null) || registration?.gender);
        if (entryGender && entryGender !== "mixed" && entryGender !== target.gender) return false;
    }

    if (target.matchType) {
        const entryMatchType = normalizeToken(
            isObject ? (entry.matchType ?? entry.match_type ?? entry.type) : null
        );
        if (entryMatchType && entryMatchType !== target.matchType) return false;
    }
    return true;
};

export const registrationMatchesCategory = (registration, target) =>
    registrationCategories(registration).some((entry) => {
        // normalizeId reads id, then categoryId / category_id, from an object entry.
        const entryId = normalizeId(entry);
        if (target.id && entryId) return entryId === target.id;
        return matchesByName(entry, target, registration);
    });

export const filterRegistrationsForCategory = (registrations, categoryId, categoryLabel) => {
    const target = buildCategoryTarget(categoryId, categoryLabel);
    return (registrations || []).filter((reg) => registrationMatchesCategory(reg, target));
};
