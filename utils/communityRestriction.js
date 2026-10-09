import { supabaseAdmin } from "../config/supabaseClient.js";

// Community restriction = events.community_restrictions_enabled plus
// events.allowed_community_ids (ids from the existing `apartments` table).
// Players keep their community as free text in users.apartment (the name picked
// from that same table at sign-up), so eligibility is a case-insensitive
// name match against the allowed apartments.

export const COMMUNITY_RESTRICTED_CODE = "COMMUNITY_RESTRICTED";
export const MAX_ALLOWED_COMMUNITIES = 100;
export const MAX_RESTRICTION_MESSAGE_LENGTH = 500;

const normalizeName = (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();

/** Dedupe, drop blanks, cap the list. Ids are opaque (uuid or bigint). */
export const normalizeCommunityIds = (input) => {
    if (!Array.isArray(input)) return [];
    const seen = new Set();
    for (const raw of input) {
        const id = raw && typeof raw === "object" ? raw.id : raw;
        if (id === null || id === undefined || String(id).trim() === "") continue;
        seen.add(String(id).trim());
    }
    return Array.from(seen).slice(0, MAX_ALLOWED_COMMUNITIES);
};

/** Institute names: trim, collapse spaces, dedupe case-insensitively, cap. */
export const normalizeInstituteNames = (input) => {
    if (!Array.isArray(input)) return [];
    const seen = new Map();
    for (const raw of input) {
        const name = String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, 150);
        if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    }
    return Array.from(seen.values()).slice(0, MAX_ALLOWED_COMMUNITIES);
};

/** Trims the organiser's note; empty becomes null. */
export const normalizeRestrictionMessage = (value) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim().slice(0, MAX_RESTRICTION_MESSAGE_LENGTH);
    return trimmed || null;
};

/**
 * Turns group names typed by an admin (an institute, stadium, club...) into
 * `apartments` ids, creating any that do not exist yet. Creating them there is
 * what lets players pick the same name when they sign up, so their profile text
 * matches the event's list.
 */
export const resolveCommunityNames = async (names) => {
    if (!Array.isArray(names)) return [];
    const unique = new Map();
    for (const raw of names) {
        const name = String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, 150);
        if (name) unique.set(name.toLowerCase(), name);
    }
    const ids = [];
    for (const name of unique.values()) {
        // ilike without wildcards = case-insensitive exact match; escape % and _.
        const pattern = name.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        let { data: existing, error } = await supabaseAdmin.from("apartments").select("id").ilike("name", pattern).limit(1).maybeSingle();
        if (error) throw error;
        if (!existing) {
            const inserted = await supabaseAdmin.from("apartments").insert({ name, pincode: "", locality: "", zone: "" }).select("id").maybeSingle();
            if (inserted.error) {
                // Lost a race with another insert of the same name — read it back.
                const retry = await supabaseAdmin.from("apartments").select("id").ilike("name", pattern).limit(1).maybeSingle();
                if (retry.error || !retry.data) throw inserted.error;
                existing = retry.data;
            } else {
                existing = inserted.data;
            }
        }
        if (existing?.id !== undefined && existing?.id !== null) ids.push(String(existing.id));
    }
    return ids;
};

/** Keeps only ids that exist in `apartments`; returns { ids, missing }. */
export const validateCommunityIds = async (ids) => {
    if (ids.length === 0) return { ids: [], missing: [] };
    const { data, error } = await supabaseAdmin.from("apartments").select("id").in("id", ids);
    if (error) throw error;
    const found = new Set((data || []).map((row) => String(row.id)));
    return { ids: ids.filter((id) => found.has(id)), missing: ids.filter((id) => !found.has(id)) };
};

/** Names for the given ids, for display (admin edit form, player popup). */
export const loadCommunities = async (ids) => {
    const list = normalizeCommunityIds(ids);
    if (list.length === 0) return [];
    const { data, error } = await supabaseAdmin.from("apartments").select("id, name").in("id", list);
    if (error) throw error;
    return (data || []).map((row) => ({ id: String(row.id), name: row.name }));
};

export const isCommunityRestricted = (event) => event?.community_restrictions_enabled === true;

const rejection = (message, organiserMessage) => {
    const note = typeof organiserMessage === "string" ? organiserMessage.trim() : "";
    const err = new Error(note ? `${message}\n\nNote from the organiser: ${note}` : message);
    err.statusCode = 400;
    err.code = COMMUNITY_RESTRICTED_CODE;
    return err;
};

/**
 * Throws a 400 (code COMMUNITY_RESTRICTED) when the event is restricted and the
 * player's community is not on its list. No-op for unrestricted events and for
 * events created before the columns existed.
 *
 * Fails closed: a restricted event whose communities were all deleted admits
 * nobody, rather than silently opening to everyone.
 */
export const assertCommunityAllowed = async (event, user) => {
    if (!isCommunityRestricted(event)) return;

    // A player qualifies through EITHER affiliation: the community on their
    // profile (users.apartment) or the institute they were imported under
    // (users.institute_name).
    const playerCommunity = normalizeName(user?.apartment);
    const playerInstitute = normalizeName(user?.institute_name);
    if (!playerCommunity && !playerInstitute) {
        throw rejection(
            "You are not eligible to register for this event. Add your community/apartment/institute to your profile — this event is restricted to selected communities.",
            event.community_restriction_message
        );
    }

    const allowed = await loadCommunities(event.allowed_community_ids);
    const allowedInstitutes = normalizeInstituteNames(event.allowed_institute_names).map(normalizeName);
    const communityMatch = !!playerCommunity && allowed.some((c) => normalizeName(c.name) === playerCommunity);
    const instituteMatch = !!playerInstitute && allowedInstitutes.includes(playerInstitute);
    if (!communityMatch && !instituteMatch) {
        throw rejection(
            "You are not eligible to register for this event because your community/apartment/institute is not included in the eligible list.",
            event.community_restriction_message
        );
    }
};
