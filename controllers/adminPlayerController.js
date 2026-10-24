import { supabaseAdmin } from "../config/supabaseClient.js";
import { withoutPassword } from "../utils/userSanitize.js";
import { isUuid } from "./bracket/bracketHelpers.js";
import { calculateAge, resolveAge } from "../utils/age.js";
import { invalidateDashboardCache } from "../utils/dashboardCache.js";
import { normalizeGender } from "../utils/playerProfileFields.js";

// Strip PostgREST filter-syntax chars and the % wildcard (it would match every
// row). "_" is kept: as a LIKE wildcard it still matches a literal underscore,
// and stripping it made "john_doe@x.com" search for "johndoe@x.com".
const sanitizeSearchWord = (s) => s.replace(/[(),;"'\\%*]/g, "").slice(0, 100);

const SEARCH_COLUMNS = ["first_name", "last_name", "name", "email", "mobile", "player_id", "city"];

/**
 * Search text as PostgREST OR-lists, one per word: every word must match some
 * column. A single phrase compared column by column could never find
 * "Ravi Kumar" (first and last name are separate columns). A phone number is
 * reduced to its last 10 digits, so "+91 98765 43210" finds the stored mobile.
 */
const searchGroups = (search) => {
    if (typeof search !== "string" || !search.trim()) return [];
    const trimmed = search.trim().slice(0, 100);
    const words = /^[+\d\s()-]{7,}$/.test(trimmed)
        ? [trimmed.replace(/\D/g, "").slice(-10)]
        : trimmed.split(/\s+/).map(sanitizeSearchWord).filter(Boolean).slice(0, 5);
    return words.map((w) => SEARCH_COLUMNS.map((c) => `${c}.ilike.%${w}%`).join(","));
};

/**
 * Players whose gender normalizeGender would reject (null, blank, "M", ...).
 * Exactly the accounts assertPlayerEligible blocks from every category.
 */
const MISSING_GENDER_EXPR = "gender.is.null,and(gender.not.ilike.male,gender.not.ilike.female)";

const GENDER_EXPR = { male: "gender.ilike.male", female: "gender.ilike.female", missing: MISSING_GENDER_EXPR };
const DOB_EXPR = { present: "dob.not.is.null", missing: "dob.is.null" };

// Pending includes null — older rows have none.
const STATUS_EXPR = {
    verified: "verification.eq.verified",
    rejected: "verification.in.(rejected,failed)",
    pending: "verification.is.null,verification.not.in.(verified,rejected,failed)",
};

const ageBound = (value) => {
    const n = Number(value);
    return value !== undefined && value !== "" && Number.isInteger(n) && n >= 0 && n <= 150 ? n : null;
};

/** YYYY-MM-DD for today (UTC) minus `years`. */
const yearsAgo = (years) => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
};

/**
 * Age range as an OR-list. Age follows the DOB where there is one (see
 * utils/age.js), so for those rows the range becomes a DOB range; rows with no
 * DOB fall back to the stored age column.
 */
const ageExpr = (minRaw, maxRaw) => {
    const min = ageBound(minRaw);
    const max = ageBound(maxRaw);
    if (min === null && max === null) return null;
    const byDob = ["dob.not.is.null"];
    const byAge = ["dob.is.null"];
    if (min !== null) { byDob.push(`dob.lte.${yearsAgo(min)}`); byAge.push(`age.gte.${min}`); }
    if (max !== null) { byDob.push(`dob.gt.${yearsAgo(max + 1)}`); byAge.push(`age.lte.${max}`); }
    return `and(${byDob.join(",")}),and(${byAge.join(",")})`;
};

/**
 * AND several PostgREST OR-lists into the one `or` value a query can carry:
 * a single list as-is, several as and(or(a),or(b),...).
 */
export const combineOrGroups = (groups) => {
    const present = groups.filter(Boolean);
    if (present.length <= 1) return present[0] || null;
    return `and(${present.map((g) => `or(${g})`).join(",")})`;
};

// Enough for a player list or the Age & Gender editor; skips addresses, ids, hashes.
const PROFILE_COLUMNS = "id, player_id, first_name, last_name, email, mobile, photos, dob, age, gender, verification, city, state, created_at";

/**
 * GET /api/admin/players query → filters, shared by the super admin and the
 * assigned-events handlers.
 *   search              words matched across SEARCH_COLUMNS
 *   status              verified | pending | rejected
 *   gender              male | female | missing   (missing=gender is the older spelling)
 *   dob                 present | missing
 *   ageMin, ageMax      inclusive, in years
 *   fields=profile      PROFILE_COLUMNS instead of every column
 *   counts=0            skip the verified/pending/rejected tile counts
 * `searchFilter` narrows the tiles too; `rowFilter` (everything) only the rows.
 */
export const parsePlayerListQuery = (query = {}) => {
    const search = searchGroups(query.search);
    const statusExpr = STATUS_EXPR[query.status] || null;
    const gender = query.gender || (query.missing === "gender" ? "missing" : null);
    return {
        searchFilter: combineOrGroups(search),
        statusExpr,
        rowFilter: combineOrGroups([
            ...search,
            statusExpr,
            GENDER_EXPR[gender] || null,
            DOB_EXPR[query.dob] || null,
            ageExpr(query.ageMin, query.ageMax),
        ]),
        columns: query.fields === "profile" ? PROFILE_COLUMNS : "*",
        withCounts: query.counts !== "0",
    };
};

// GET /api/admin/players
export const listPlayers = async (req, res) => {
    try {
        const { page, limit } = req.query;

        // Status and the other filters narrow the rows only, never the tiles:
        // the tiles keep describing the whole (searched) set so the segmented
        // control can show what each segment holds.
        const { searchFilter, rowFilter, columns, withCounts } = parsePlayerListQuery(req.query);

        /**
         * One definition of "the players we are talking about", reused by the row
         * query and by every count. The search narrows all of them; only the row
         * query is paginated. That is what lets the header tiles describe the
         * whole result set while the table shows one page of it — previously the
         * tiles counted the loaded page, so "Verified" meant "verified among
         * these twelve".
         */
        const scoped = (options) => {
            let q = supabaseAdmin.from("users").select("id", options).eq("role", "player");
            if (searchFilter) q = q.or(searchFilter);
            return q;
        };

        let query = supabaseAdmin.from("users").select(columns, { count: "exact" }).eq("role", "player");
        if (rowFilter) query = query.or(rowFilter);
        query = query.order("created_at", { ascending: false });

        if (page && limit) {
            const pageNum = parseInt(page, 10);
            const limitNum = parseInt(limit, 10);
            const from = (pageNum - 1) * limitNum;
            const to = from + limitNum - 1;
            query = query.range(from, to);
        }

        // head: true asks PostgREST for the count alone — the matching rows are
        // never serialised or sent, so these stay cheap as the table grows.
        const [rowsRes, verifiedRes, rejectedRes, totalRes] = await Promise.all([
            query,
            withCounts ? scoped({ count: "exact", head: true }).eq("verification", "verified") : null,
            withCounts ? scoped({ count: "exact", head: true }).in("verification", ["rejected", "failed"]) : null,
            // With a filter the row count is that segment's size, not the total.
            withCounts && rowFilter !== searchFilter ? scoped({ count: "exact", head: true }) : null,
        ]);
        if (!withCounts) {
            if (rowsRes.error) throw rowsRes.error;
            return res.json({ success: true, players: (rowsRes.data || []).map(withoutPassword), total_count: rowsRes.count ?? 0 });
        }

        if (rowsRes.error) throw rowsRes.error;
        if (totalRes?.error) throw totalRes.error;

        const rowCount = rowsRes.count ?? 0;
        const total = totalRes ? totalRes.count ?? 0 : rowCount;

        // A failed count must not be reported as zero — that would read as "no
        // verified players" rather than "we could not tell". Fall back to null
        // and let the client show a dash.
        const verified = verifiedRes.error ? null : verifiedRes.count ?? 0;
        const rejected = rejectedRes.error ? null : rejectedRes.count ?? 0;
        if (verifiedRes.error) console.warn("Player verified count failed:", verifiedRes.error.message);
        if (rejectedRes.error) console.warn("Player rejected count failed:", rejectedRes.error.message);

        // Pending is the remainder rather than its own query. `verification` is
        // null on older rows, and "null OR pending" would need a second `or`
        // clause stacked on the search one. Deriving it also guarantees the
        // three tiles add up to the total, which two independent counts taken a
        // moment apart would not.
        const pending =
            verified === null || rejected === null
                ? null
                : Math.max(total - verified - rejected, 0);

        res.json({
            success: true,
            players: (rowsRes.data || []).map(withoutPassword),
            total_count: rowCount,
            counts: { total, verified, pending, rejected },
        });
    } catch (err) {
        console.error("ADMIN PLAYERS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch players" });
    }
};

// GET /api/admin/players/:id
export const getPlayerDetails = async (req, res) => {
    try {
        const { id } = req.params;

        const { data: player, error } = await supabaseAdmin.from("users").select("*").eq("id", id).maybeSingle();
        if (error) throw error;
        if (!player) return res.status(404).json({ success: false, message: "Player not found" });

        const { data: schoolDetails } = await supabaseAdmin.from("player_school_details").select("*").eq("player_id", id).maybeSingle();
        if (schoolDetails) {
            player.school = {
                name: schoolDetails.school_name,
                address: schoolDetails.school_address,
                city: schoolDetails.school_city,
                pincode: schoolDetails.school_pincode
            };
        }

        const { data: registrations } = await supabaseAdmin
            .from("event_registrations")
            .select(`*, events(id, name, sport, start_date, end_date, start_time, location, venue)`)
            .eq("player_id", id)
            .order("created_at", { ascending: false });

        // Event dates are plain YYYY-MM-DD, so string comparison orders them.
        const today = new Date().toISOString().slice(0, 10);
        const eventStatus = (ev) => {
            if (!ev?.start_date) return 'upcoming';
            if (ev.start_date > today) return 'upcoming';
            return (ev.end_date || ev.start_date) < today ? 'completed' : 'ongoing';
        };
        // The categories the player entered live on the registration (strings
        // or {name}/{category} objects), not on the event.
        const categoryLabels = (reg) => (Array.isArray(reg.categories) ? reg.categories : [])
            .map(c => typeof c === 'string' ? c : (c?.name || c?.category || c?.Category || ''))
            .filter(Boolean);

        player.eventsParticipated = registrations ? registrations.map(reg => ({
            eventId: reg.events?.id,
            eventName: reg.events?.name,
            sport: reg.events?.sport,
            categories: categoryLabels(reg),
            registrationId: reg.registration_no,
            paymentStatus: reg.status === 'verified' ? 'paid' : (reg.status === 'rejected' ? 'failed' : 'pending'),
            playerStatus: reg.status,
            eventDate: reg.events?.start_date,
            eventTime: reg.events?.start_time || "N/A",
            eventLocation: reg.events?.location || "Unknown",
            eventVenue: reg.events?.venue || "Unknown",
            eventStatus: eventStatus(reg.events),
            amountPaid: reg.amount_paid
        })) : [];

        res.json({ success: true, player: withoutPassword(player) });
    } catch (err) {
        console.error("ADMIN PLAYER DETAIL ERROR:", err);
        res.status(500).json({ message: "Failed to fetch player details" });
    }
};

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_AGE = 120;

/** A real calendar date as YYYY-MM-DD, not in the future; null otherwise. */
const cleanDob = (value) => {
    const m = ISO_DATE_RE.exec(String(value ?? "").trim());
    if (!m) return null;
    const [, y, mo, d] = m.map(Number);
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
    const age = calculateAge(m[0]);
    return age === null || age > MAX_AGE ? null : m[0];
};

// PATCH /api/admin/players/:id/profile  { dob?, age?, gender? }
// Admin correction of the fields category eligibility runs on. Unlike the
// player's own Edit Profile, gender can be changed here at any time.
//  - dob wins: whenever the row has one, age is recomputed from it and any
//    age sent alongside is ignored (resolveAge reads dob first anyway).
//  - age alone is only accepted for an account with no dob on file.
//  - The password is left alone even though the default one is the DOB: the
//    player may still be using the old default, and changing it here would
//    lock them out without telling them.
// Existing registrations are not re-checked against the new values.
export const updatePlayerProfile = async (req, res) => {
    try {
        const { id } = req.params;
        const body = req.body || {};
        if (!isUuid(id)) return res.status(404).json({ success: false, message: "Player not found" });

        const { data: player, error: fetchError } = await supabaseAdmin
            .from("users").select("id, dob, age, gender").eq("id", id).eq("role", "player").maybeSingle();
        if (fetchError) throw fetchError;
        if (!player) return res.status(404).json({ success: false, message: "Player not found" });

        const updates = {};

        if (body.gender !== undefined) {
            const gender = normalizeGender(body.gender);
            if (!gender) return res.status(400).json({ success: false, message: "Gender must be Male or Female" });
            updates.gender = gender;
        }

        if (body.dob !== undefined) {
            const dob = cleanDob(body.dob);
            if (!dob) return res.status(400).json({ success: false, message: "Enter a valid date of birth (not in the future)" });
            updates.dob = dob;
            updates.age = calculateAge(dob);
        } else if (body.age !== undefined) {
            if (player.dob) {
                return res.status(400).json({ success: false, message: "Age follows the date of birth. Change the date of birth instead." });
            }
            const age = Number(body.age);
            if (!Number.isInteger(age) || age < 1 || age > MAX_AGE) {
                return res.status(400).json({ success: false, message: `Age must be a whole number from 1 to ${MAX_AGE}` });
            }
            updates.age = age;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ success: false, message: "Nothing to update" });
        }

        const { data: updated, error: updateError } = await supabaseAdmin
            .from("users").update(updates).eq("id", id).select("id, dob, age, gender").maybeSingle();
        if (updateError) throw updateError;

        // The player's dashboard shows these, and so do the dashboards of
        // everyone in their family (members are listed with age and gender).
        const { data: relations } = await supabaseAdmin
            .from("family_relations")
            .select("head_player_id, of_player_id")
            .or(`head_player_id.eq.${id},of_player_id.eq.${id}`);
        const touched = new Set([id]);
        (relations || []).forEach((r) => { touched.add(r.head_player_id); touched.add(r.of_player_id); });
        await Promise.allSettled([...touched].map((uid) => invalidateDashboardCache(uid)));

        res.json({ success: true, player: { ...updated, age: resolveAge(updated) } });
    } catch (err) {
        console.error("ADMIN PLAYER PROFILE UPDATE ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to update player" });
    }
};
