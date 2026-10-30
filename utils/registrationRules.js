import { supabaseAdmin } from "../config/supabaseClient.js";
import { buildCategoryTarget, registrationMatchesCategory } from "./categoryMatching.js";
import { normalizeGender } from "./playerProfileFields.js";

/**
 * ============================================================
 * Registration rules — what a player may enter, and with whom
 * ============================================================
 * Everything that decides whether a registration request is acceptable lives
 * here, so the four writers (Razorpay order, manual payment, the pre-payment
 * validate call, and the order-notes rebuild used by verify/webhook/reconcile)
 * can never disagree.
 *
 * A request is a list of ENTRIES: `{ categoryId, teamId }`. Singles categories
 * carry no team. Every Doubles/Team category carries its own team — the pair or
 * squad entered in THAT category — so one checkout can enter Men's Doubles with
 * one partner and Mixed Doubles with another.
 *
 * Storage: one payment → one `transactions` row → one `event_registrations` row
 * per Doubles/Team entry (each with its own `team_id`) plus one row holding all
 * the singles categories. All rows share the transaction and the registration
 * number, so the player gets one receipt. Draws, stats and the admin roster
 * already read `team_id` per row, which is why the split is per team.
 */

// ── Category / fee helpers (moved verbatim from paymentController) ──────────
export const DEFAULT_CATEGORY_FEE = 500; // player-app fallback when a category has no fee

/**
 * ONE definition of "an active registration", used by every count and check:
 * any row that is not rejected/cancelled/refunded/failed. Active rows hold a
 * place in their category (duplicate check, slots), and are what every
 * "registrations" number on the player site, admin event page, registrations
 * list, events list and dashboard counts. Rejected rows are reported beside it.
 */
export const INACTIVE_REGISTRATION_STATUSES = ["rejected", "cancelled", "canceled", "refunded", "failed"];
export const isActiveRegistrationStatus = (status) =>
    !INACTIVE_REGISTRATION_STATUSES.includes(String(status || "").toLowerCase());
/** PostgREST `.not("status", "in", …)` value for INACTIVE_REGISTRATION_STATUSES. */
export const INACTIVE_STATUS_FILTER = `(${INACTIVE_REGISTRATION_STATUSES.join(",")})`;

/** Kept for callers that list statuses explicitly (e.g. the dashboard's delete guard). */
export const ACTIVE_REGISTRATION_STATUSES = [
    "verified", "paid", "confirmed", "approved", "registered",
    "pending", "Pending", "pending_verification", "payment_pending", "Submitted",
];

/**
 * Count registrations the one way every screen shows them.
 *
 * The unit is a CATEGORY ENTRY: a player in two categories is two
 * registrations (two fees, two slots). A Doubles/Team entry is counted once
 * per distinct team in a category, never once per member. Since Oct 2026 each
 * new registration row holds exactly one category, so for new data entries ==
 * rows; old rows that list several categories count once per category.
 *
 * Returns { active, rejected, byCategory } — byCategory holds the active count
 * per category key (id, else name), as the per-category slot cards need.
 */
export const tallyRegistrationEntries = (rows) => {
    const singles = {};
    const teams = {};
    let rejected = 0;
    for (const r of rows || []) {
        const cats = Array.isArray(r.categories) ? r.categories : (r.categories ? [r.categories] : []);
        if (!isActiveRegistrationStatus(r.status)) {
            rejected += Math.max(cats.length, 1);
            continue;
        }
        for (const c of cats) {
            const key = c && typeof c === "object" ? (c.id || c.name || c.category) : c;
            if (r.team_id) (teams[key] ||= new Set()).add(String(r.team_id));
            else singles[key] = (singles[key] || 0) + 1;
        }
    }
    const byCategory = { ...singles };
    for (const [key, set] of Object.entries(teams)) byCategory[key] = (byCategory[key] || 0) + set.size;
    const active = Object.values(byCategory).reduce((sum, n) => sum + (Number(n) || 0), 0);
    return { active, rejected, byCategory };
};

/** Doubles and Team categories are entered as a pair / squad. */
export const isTeamMatchType = (matchType) => /doubles|team/i.test(String(matchType || ""));
export const isDoublesMatchType = (matchType) => /doubles/i.test(String(matchType || ""));

/**
 * Parses a configured entry fee. Returns null when no fee is recorded, so a
 * genuine 0 (free category) stays distinguishable from "not set" — `Number(x)
 * || null` collapsed both to null and silently made free categories billable.
 * An empty string is "not set", not zero.
 */
export const parseEntryFee = (value) => {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (raw === "") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

/**
 * True when the event has categories and every one is explicitly free (fee 0).
 * A category with no fee recorded is "not set", not free, so one missing fee
 * keeps the event paid. Such an event takes no payment, so it needs no QR.
 */
export const allCategoriesFree = (categories) =>
    Array.isArray(categories) &&
    categories.length > 0 &&
    categories.every((c) => c && typeof c === "object" && parseEntryFee(c.entryFee ?? c.fee) === 0);

const parsePositiveInt = (value) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
};

export const normalizeEventCategories = (event) => {
    const raw = Array.isArray(event?.categories) ? event.categories : [];
    return raw.map((c, idx) => {
        const isObj = c && typeof c === "object";
        const name = (isObj ? (c.category || c.Category || c.name || "Unknown") : String(c)).trim();
        return {
            id: (isObj && c.id) || `cat-${idx}`,
            name,
            gender: (isObj && c.gender) || "Mixed",
            matchType: (isObj && c.matchType) || "Singles",
            entryFee: isObj ? parseEntryFee(c.entryFee ?? c.fee) : null,
            // Carried through so assertCategoriesOpen can see the admin's
            // manual close switch. Kept on the normalized object rather than
            // re-read from the raw array so both live behind one lookup.
            registrationClosed: isObj ? c.registrationClosed === true : false,
            // Read by assertPlayerEligible. Never persisted (toCategoryObject).
            ageRules: resolveCategoryAgeRules(isObj ? c : null, name),
            minTeamSize: isObj ? parsePositiveInt(c.minTeamSize) : null,
            maxTeamSize: isObj ? parsePositiveInt(c.maxTeamSize) : null,
        };
    });
};

// Same matching rules the player app uses when it maps selected ids to categories
export const findEventCategory = (normalizedCategories, catId) =>
    normalizedCategories.find(
        (c) => String(c.id) === catId || `${c.name}-${c.gender}` === catId || c.name === catId
    ) || null;

const categoryIdOf = (rawId) => String(rawId && typeof rawId === "object" ? rawId.id : rawId);

/** "U-15 (Male) Doubles" — how a category is named in error messages. */
export const categoryLabel = (cat) =>
    `${cat?.name || "category"}${cat?.gender ? ` (${cat.gender})` : ""}${cat?.matchType ? ` ${cat.matchType}` : ""}`;

/** The object persisted onto event_registrations.categories. */
const toCategoryObject = (cat, fee) =>
    // Deliberately NOT spreading `cat` — these objects are persisted, so a
    // transient flag like registrationClosed would be frozen into the row and
    // read back years later as if it described the registration.
    ({ id: cat.id, name: cat.name, gender: cat.gender, fee, matchType: cat.matchType });

// The category's entry fee is the price of ONE entry into that category, whatever
// an "entry" means for its match type: one player for Singles, one pair for
// Doubles, one squad for Team. It is never multiplied by the number of people on
// the entry — a ₹1400 Doubles category costs ₹1400 for the pair, not ₹2800, and a
// ₹1400 9-a-side Team category costs ₹1400 for the squad, not ₹12,600.
//
// Returns { fee, categoryObjects }. Throws (statusCode 400) on unknown category ids.
export const computeRegistrationFee = (event, requestedCategoryIds) => {
    const normalized = normalizeEventCategories(event);
    // `??` not `||` — a first category priced at 0 must not fall through to the
    // default fee.
    const baseFee = normalized[0]?.entryFee ?? DEFAULT_CATEGORY_FEE;

    let feeSum = 0;
    const categoryObjects = [];

    for (const rawId of requestedCategoryIds) {
        const catId = categoryIdOf(rawId);
        const cat = findEventCategory(normalized, catId);
        if (!cat) throw badRequest(`Unknown category for this event: ${catId}`);
        const fee = cat.entryFee ?? baseFee;
        feeSum += fee;
        categoryObjects.push(toCategoryObject(cat, fee));
    }

    // One entry fee per selected category. Team size is deliberately not a factor.
    return { fee: feeSum, categoryObjects };
};

/** A 400 the controllers pass straight to the player app. */
export const badRequest = (message, code, extra = {}) => {
    const err = new Error(message);
    err.statusCode = 400;
    if (code) err.code = code;
    Object.assign(err, extra);
    return err;
};

/** The JSON body for a thrown badRequest — message, plus code/categoryId when set. */
export const badRequestBody = (err) => ({
    message: err.message,
    ...(err.code ? { code: err.code } : {}),
    ...(err.categoryId ? { categoryId: err.categoryId } : {}),
});

// ── Registration window (server-side mirror of the player app's check) ───────
/**
 * Throws a 400 when a requested category has been closed by the organiser.
 *
 * The admin's close switch is what makes this necessary: it can flip while a
 * player is mid-checkout, so the player app's own check — made when the page
 * loaded — is already stale by the time the request lands here. A tab left open
 * since the morning would otherwise pay into a category that shut at 2pm.
 *
 * Only the manual flag is enforced. The `lastDateToRegister` deadline has never
 * been checked server-side on this path, and quietly starting to reject on it
 * here would change behaviour for every event, not just the ones an organiser
 * has closed by hand. That gap is worth closing on its own terms.
 */
export const assertCategoriesOpen = (event, requestedCategoryIds) => {
    const normalized = normalizeEventCategories(event);
    for (const rawId of requestedCategoryIds) {
        const cat = findEventCategory(normalized, categoryIdOf(rawId));
        if (cat?.registrationClosed) {
            // Machine-readable so the player app can tell this apart from the
            // other 400s and re-read the event, instead of leaving an open-
            // looking tile behind a "category is closed" toast.
            throw badRequest(`Registration for "${cat.name}" has been closed by the organiser`, "CATEGORY_CLOSED", { categoryId: String(cat.id) });
        }
    }
};

// ── One category per player (organiser's event-level switch) ────────────────
/**
 * events.single_category_only: the organiser limits every player to ONE
 * category of the event, however many they are eligible for. A player holds a
 * place the same way the duplicate check counts it — registered themselves, or
 * entered by a captain as a partner/team-mate — and a rejected or cancelled
 * entry frees them again. Enforced in validateRegistrationEntries; paid-order
 * rebuilds (verify/webhook/reconcile) never re-check, so a captured payment is
 * always recorded.
 */
export const isSingleCategoryOnly = (event) => event?.single_category_only === true;
export const SINGLE_CATEGORY_MESSAGE = "This event allows each player to register in only one category.";

// ── Category eligibility (server-side mirror of the player app's check) ──────
// The player app disables ineligible categories, but that is browser-side only.
// Without this the gate is cosmetic: a crafted request could enter any category.
//
// Age rules are encoded in the category NAME, exactly as the player app parses
// them: "U-15" => max age 15, "Above 40" => min age 40, "All" => unrestricted.
// Any run of spaces/hyphens/dashes may separate the word from the number —
// "Above-55" and "Above -55" used to parse as unrestricted.
export const parseCategoryAgeRules = (name) => {
    const label = String(name || "");
    const maxMatch = label.match(/(?:U|Under)[\s\-–—]*(\d+)/i);
    const minMatch = label.match(/(?:Above|Over)[\s\-–—]*(\d+)|\b(\d+)\s*\+/i);
    return {
        ageLimit: maxMatch ? Number.parseInt(maxMatch[1], 10) : undefined,
        minAge: minMatch ? Number.parseInt(minMatch[1] ?? minMatch[2], 10) : undefined,
    };
};

const toAgeNumber = (value) => {
    if (value === null || value === undefined || String(value).trim() === "") return undefined;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * A category's age rule: the explicit minAge/ageLimit the admin form saves,
 * else its name. ageRuleSource "manual" means the admin typed the rule (blank =
 * no limit) and the name must not be read — "Combined 80+" is not "80+".
 * Mirrors resolveCategoryAgeRules in the player app.
 */
export const resolveCategoryAgeRules = (rawCategory, name) => {
    const minAge = toAgeNumber(rawCategory?.minAge);
    const ageLimit = toAgeNumber(rawCategory?.ageLimit);
    if (rawCategory?.ageRuleSource === "manual") return { minAge, ageLimit };
    const parsed = parseCategoryAgeRules(name);
    return { minAge: minAge ?? parsed.minAge, ageLimit: ageLimit ?? parsed.ageLimit };
};

// Returns the player's birth year, or null when nothing usable is on file.
export const resolveBirthYear = (user, currentYear) => {
    if (user?.dob) {
        const parsed = new Date(user.dob);
        if (!Number.isNaN(parsed.getTime())) return parsed.getFullYear();
    }
    const age = Number(user?.age);
    if (Number.isFinite(age) && age > 0) return currentYear - age;
    return null;
};

/**
 * Throws a 400 if the player may not enter one of the requested categories.
 *
 * Mirrors the player app's policy deliberately, including the lenient part: a
 * player with no date of birth or age on file is allowed through, because most
 * accounts have neither and blocking them would stop registration entirely.
 * Tighten this only once DOB collection is in place.
 *
 * Gender is NOT lenient: a player with no gender on file may enter no category
 * at all. Letting them through is how genderless accounts ended up in the
 * other gender's categories. Signup now requires it, and older accounts add it
 * once from their profile.
 *
 * `who` names a team member in the message ("Raju (P1761) is"); omitted, the
 * message addresses the paying player ("You are").
 */
export const GENDER_REQUIRED_CODE = "GENDER_REQUIRED";

export const assertPlayerEligible = (user, categoryObjects, who = null) => {
    const normalized = normalizeGender(user?.gender);
    const playerGender = normalized ? normalized.toLowerCase() : "";
    const currentYear = new Date().getFullYear();
    const birthYear = resolveBirthYear(user, currentYear);
    const subject = who ? `${who} is` : "You are";

    if (!playerGender && categoryObjects.length > 0) {
        const first = categoryObjects[0];
        throw badRequest(
            who
                ? `${who} has no gender on their profile. They must add it in their profile before they can be entered in any category.`
                : "Please add your gender in your profile (Dashboard → Edit Profile) before registering for any category.",
            GENDER_REQUIRED_CODE,
            { categoryId: String(first.id) }
        );
    }

    for (const cat of categoryObjects) {
        const extra = { categoryId: String(cat.id), code: "NOT_ELIGIBLE" };
        const categoryGender = String(cat.gender || "Mixed").toLowerCase();
        if (categoryGender !== "mixed" && categoryGender !== "open") {
            if (categoryGender !== playerGender) {
                throw badRequest(`${subject} not eligible for "${cat.name}" (${cat.gender} only)`, extra.code, extra);
            }
        }

        if (birthYear === null) continue; // no age on file — see note above

        // Event categories (normalizeEventCategories) carry their resolved rule.
        const { ageLimit, minAge } = cat.ageRules ?? parseCategoryAgeRules(cat.name);
        // "Under 9" is strictly under 9 — the player must not turn 9 this year,
        // so the earliest allowed birth year is (currentYear - ageLimit + 1).
        // In 2026: U-9 => 2018, U-12 => 2015, U-15 => 2012.
        if (ageLimit !== undefined && birthYear < currentYear - ageLimit + 1) {
            throw badRequest(
                `${subject} not eligible for "${cat.name}" — born ${currentYear - ageLimit + 1} or later required`,
                extra.code, extra
            );
        }
        if (minAge !== undefined && birthYear > currentYear - minAge) {
            throw badRequest(`${subject} not eligible for "${cat.name}" (minimum age ${minAge})`, extra.code, extra);
        }
    }
};

// ── Team rules ───────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value) => typeof value === "string" && UUID_RE.test(value.trim());

/**
 * How many players (captain included) an entry in this category must have.
 * Doubles is always exactly a pair. Team uses the organiser's min/max; with no
 * minimum set a team still needs the captain plus at least one member.
 */
export const teamSizeRule = (cat) => {
    if (isDoublesMatchType(cat?.matchType)) return { min: 2, max: 2 };
    const min = Math.max(cat?.minTeamSize || 2, 2);
    const max = cat?.maxTeamSize && cat.maxTeamSize >= min ? cat.maxTeamSize : null;
    return { min, max };
};

const memberList = (team) => {
    if (Array.isArray(team?.members)) return team.members;
    if (typeof team?.members === "string") {
        try { return JSON.parse(team.members); } catch { return []; }
    }
    return [];
};

const chunk = (list, size) => {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
};

const USER_FIELDS = "id, player_id, first_name, last_name, gender, dob, age";

/**
 * Look up user rows for team members, by uuid first and public player code as
 * the fallback (rows from before members carried their uuid). Chunked so a big
 * event's rosters cannot blow the PostgREST URL limit.
 */
const fetchUsersForMembers = async (members) => {
    const ids = new Set();
    const codes = new Set();
    for (const m of members) {
        if (isUuid(m?.id)) ids.add(m.id.trim());
        const code = String(m?.player_id ?? "").trim();
        if (code) { codes.add(code); codes.add(code.toUpperCase()); }
    }

    const rows = [];
    for (const part of chunk([...ids], 100)) {
        const { data, error } = await supabaseAdmin.from("users").select(USER_FIELDS).in("id", part);
        if (error) throw error;
        rows.push(...(data || []));
    }
    for (const part of chunk([...codes], 100)) {
        const { data, error } = await supabaseAdmin.from("users").select(USER_FIELDS).in("player_id", part);
        if (error) throw error;
        rows.push(...(data || []));
    }

    const byId = new Map();
    const byCode = new Map();
    for (const u of rows) {
        byId.set(String(u.id), u);
        if (u.player_id) byCode.set(String(u.player_id).toUpperCase(), u);
    }
    return (m) =>
        (isUuid(m?.id) && byId.get(m.id.trim()))
        || (m?.player_id && byCode.get(String(m.player_id).trim().toUpperCase()))
        || null;
};

const memberDisplay = (member, user) => {
    const name = user ? `${user.first_name || ""} ${user.last_name || ""}`.trim() : (member?.name || "");
    const code = user?.player_id || member?.player_id;
    return code ? `${name || "A player"} (${code})` : (name || "A team member");
};

// ── Duplicate entries ────────────────────────────────────────────────────────
/**
 * Every active category entry of this event and who it puts on court.
 *
 * A registration puts its payer in every category it lists. Its team (when it
 * has one) is in the Doubles/Team categories only: rows from before per-category
 * teams could carry a team_id alongside a singles category, and the team-mates
 * were never entered in that singles draw.
 *
 * Returns [{ entry, matchType, payerId, teamUserIds }] — `entry` is the stored
 * category, `matchType` its stored match type (null on legacy entries), and
 * `teamUserIds` the captain + members of the row's team (empty without one).
 * Loaded once per validation and read by both the per-category duplicate check
 * and the event-wide one-category rule.
 */
const loadActiveEventEntries = async (event) => {
    const { data: regs, error } = await supabaseAdmin
        .from("event_registrations")
        .select("id, player_id, team_id, categories, status")
        .eq("event_id", event.id)
        .not("status", "in", INACTIVE_STATUS_FILTER);
    if (error) throw error;

    const teamIds = [...new Set((regs || []).map((r) => r.team_id).filter(Boolean))];
    const teamsById = new Map();
    for (const part of chunk(teamIds, 100)) {
        const { data, error: teamErr } = await supabaseAdmin
            .from("player_teams").select("id, captain_id, members").in("id", part);
        if (teamErr) throw teamErr;
        for (const t of data || []) teamsById.set(String(t.id), t);
    }

    // Members recorded without a uuid have to be resolved to one to compare.
    const allMembers = [...teamsById.values()].flatMap(memberList);
    const resolveMember = await fetchUsersForMembers(allMembers.filter((m) => !isUuid(m?.id)));
    const memberUserId = (m) => (isUuid(m?.id) ? m.id.trim() : resolveMember(m)?.id || null);

    const out = [];
    for (const reg of regs || []) {
        const entries = Array.isArray(reg.categories) ? reg.categories : (reg.categories ? [reg.categories] : []);
        const team = reg.team_id ? teamsById.get(String(reg.team_id)) : null;
        const teamUserIds = [];
        if (team) {
            if (team.captain_id) teamUserIds.push(String(team.captain_id));
            for (const m of memberList(team)) {
                const uid = memberUserId(m);
                if (uid) teamUserIds.push(String(uid));
            }
        }
        for (const entry of entries) {
            out.push({
                entry,
                matchType: entry && typeof entry === "object" ? entry.matchType || null : null,
                payerId: reg.player_id ? String(reg.player_id) : null,
                teamUserIds,
            });
        }
    }
    return out;
};

/**
 * Who already holds a place in each requested category of this event.
 * Returns Map<categoryId, Set<userId>>.
 */
const categoryParticipants = (activeEntries, requestedCats) => {
    const result = new Map();
    for (const cat of requestedCats) {
        const holders = new Set();
        const target = buildCategoryTarget(cat.id, `${cat.name} - ${cat.gender} - ${cat.matchType}`);
        for (const e of activeEntries) {
            if (!registrationMatchesCategory({ categories: [e.entry] }, target)) continue;
            if (e.payerId) holders.add(e.payerId);
            if (isTeamMatchType(e.matchType || cat.matchType)) {
                for (const uid of e.teamUserIds) holders.add(uid);
            }
        }
        result.set(String(cat.id), holders);
    }
    return result;
};

/**
 * For events limited to one category per player: the category each player
 * already holds in this event. Returns Map<userId, label>.
 *
 * Same "holds a place" rule as above, applied event-wide. A legacy entry with
 * no stored match type takes it from the event's category of that id/name;
 * when that category is gone too, a team on the row is taken to have been
 * entered in it — the safe reading for a rule that only ever blocks.
 */
const eventParticipants = (activeEntries, normalizedCategories) => {
    const result = new Map();
    for (const e of activeEntries) {
        const entryId = e.entry && typeof e.entry === "object"
            ? String(e.entry.id ?? e.entry.name ?? e.entry.category ?? "")
            : String(e.entry ?? "");
        const eventCat = findEventCategory(normalizedCategories, entryId);
        const matchType = e.matchType || eventCat?.matchType || null;
        const label = e.entry && typeof e.entry === "object"
            ? categoryLabel({
                name: e.entry.name || e.entry.category || eventCat?.name,
                gender: e.entry.gender || eventCat?.gender,
                matchType,
            })
            : (eventCat ? categoryLabel(eventCat) : String(e.entry || "another category"));

        const holders = [];
        if (e.payerId) holders.push(e.payerId);
        if (matchType === null || isTeamMatchType(matchType)) holders.push(...e.teamUserIds);
        for (const uid of holders) if (!result.has(uid)) result.set(uid, label);
    }
    return result;
};

// ── Request entries ──────────────────────────────────────────────────────────
/**
 * The entries a request asks for. New clients send `entries`; an older cached
 * bundle still sends `categories` + a single `teamId`, which is applied to its
 * Doubles/Team categories (validation then holds it to the per-category rules).
 */
export const entriesFromRequest = (body) => {
    if (Array.isArray(body?.entries) && body.entries.length > 0) {
        return body.entries.map((e) => ({
            categoryId: String(e?.categoryId ?? e?.id ?? "").trim(),
            teamId: e?.teamId ? String(e.teamId).trim() : null,
        }));
    }
    const cats = Array.isArray(body?.categories) ? body.categories : [];
    return cats.map((c) => ({
        categoryId: categoryIdOf(c).trim(),
        teamId: body?.teamId ? String(body.teamId).trim() : null,
    }));
};

/**
 * Validate a registration request end to end and work out what to store.
 *
 *   - every category exists, is open, and is selected once
 *   - the payer passes each category's age/gender rule
 *   - each Doubles/Team category names a team; singles ones carry none
 *   - each team exists and the payer is its CAPTAIN (members cannot register it)
 *   - Doubles = captain + exactly one partner; Team within the organiser's size
 *   - every member is a real player who passes the category's age/gender rule
 *   - nobody — payer or member — already holds a place in that category
 *
 * Returns { fee, groups, categoryObjects } where `groups` are the rows to write:
 * one per Doubles/Team entry, then one for all singles.
 */
export const validateRegistrationEntries = async ({ event, userId, payingUser, entries }) => {
    if (!Array.isArray(entries) || entries.length === 0) {
        throw badRequest("Select at least one category");
    }

    const normalized = normalizeEventCategories(event);
    const baseFee = normalized[0]?.entryFee ?? DEFAULT_CATEGORY_FEE;
    const seen = new Set();
    const resolved = [];

    for (const entry of entries) {
        const cat = findEventCategory(normalized, entry.categoryId);
        if (!cat) throw badRequest(`Unknown category for this event: ${entry.categoryId}`);
        const catId = String(cat.id);
        if (seen.has(catId)) throw badRequest(`"${categoryLabel(cat)}" is selected more than once`, "DUPLICATE_CATEGORY", { categoryId: catId });
        seen.add(catId);

        const isTeam = isTeamMatchType(cat.matchType);
        if (isTeam && !entry.teamId) {
            throw badRequest(
                `Choose your ${isDoublesMatchType(cat.matchType) ? "partner" : "team"} for "${categoryLabel(cat)}"`,
                "TEAM_REQUIRED", { categoryId: catId }
            );
        }
        if (isTeam && !isUuid(entry.teamId)) {
            throw badRequest(`The team chosen for "${categoryLabel(cat)}" is not valid`, "TEAM_NOT_FOUND", { categoryId: catId });
        }
        const fee = cat.entryFee ?? baseFee;
        resolved.push({ cat, teamId: isTeam ? entry.teamId : null, categoryObject: toCategoryObject(cat, fee), fee });
    }

    // One-category events: one entry per checkout. Checked before anything is
    // loaded — no point resolving teams for a request that cannot pass.
    const oneCategoryOnly = isSingleCategoryOnly(event);
    if (oneCategoryOnly && resolved.length > 1) {
        throw badRequest(SINGLE_CATEGORY_MESSAGE + " Please select just one category.", "SINGLE_CATEGORY_ONLY");
    }

    assertCategoriesOpen(event, resolved.map((r) => r.cat.id));
    assertPlayerEligible(payingUser, resolved.map((r) => r.cat));

    // Teams: existence, captaincy, roster.
    const teamIds = [...new Set(resolved.map((r) => r.teamId).filter(Boolean))];
    const teamsById = new Map();
    if (teamIds.length > 0) {
        const { data: teams, error } = await supabaseAdmin
            .from("player_teams")
            .select("id, team_name, captain_id, captain_name, members, status")
            .in("id", teamIds);
        if (error) throw error;
        for (const t of teams || []) teamsById.set(String(t.id), t);
    }

    const allMembers = [...teamsById.values()].flatMap(memberList);
    const resolveMember = await fetchUsersForMembers(allMembers);

    // Per team: its members resolved to user rows (validated once per team).
    const rosterByTeam = new Map();
    const rosterFor = (team, cat) => {
        const key = String(team.id);
        if (rosterByTeam.has(key)) return rosterByTeam.get(key);
        const extra = { categoryId: String(cat.id) };
        const roster = [];
        const seenUsers = new Set();
        for (const m of memberList(team)) {
            const user = resolveMember(m);
            if (!user) {
                throw badRequest(
                    `"${m?.name || m?.player_id || "A member"}" in team "${team.team_name}" is not a registered player. Edit the team and add them by Player ID.`,
                    "MEMBER_NOT_FOUND", extra
                );
            }
            if (String(user.id) === String(userId)) {
                throw badRequest(`You are the captain of "${team.team_name}" and cannot also be listed as its member. Edit the team.`, "INVALID_TEAM", extra);
            }
            if (seenUsers.has(String(user.id))) {
                throw badRequest(`${memberDisplay(m, user)} is listed twice in team "${team.team_name}". Edit the team.`, "INVALID_TEAM", extra);
            }
            seenUsers.add(String(user.id));
            roster.push({ member: m, user });
        }
        rosterByTeam.set(key, roster);
        return roster;
    };

    for (const r of resolved) {
        if (!r.teamId) continue;
        const extra = { categoryId: String(r.cat.id) };
        const team = teamsById.get(String(r.teamId));
        if (!team || team.status === "deleted") throw badRequest(`The team chosen for "${categoryLabel(r.cat)}" no longer exists`, "TEAM_NOT_FOUND", extra);
        if (String(team.captain_id) !== String(userId)) {
            throw badRequest(
                `Only the captain can register "${team.team_name}". Ask ${team.captain_name || "your captain"} to register the team.`,
                "NOT_TEAM_CAPTAIN", extra
            );
        }

        const roster = rosterFor(team, r.cat);
        const size = roster.length + 1; // + captain
        const { min, max } = teamSizeRule(r.cat);
        if (isDoublesMatchType(r.cat.matchType) && size !== 2) {
            throw badRequest(
                `"${categoryLabel(r.cat)}" is a doubles category: enter you + exactly 1 partner. "${team.team_name}" has ${size} players.`,
                "TEAM_SIZE", extra
            );
        }
        if (size < min) throw badRequest(`"${categoryLabel(r.cat)}" needs at least ${min} players including you. "${team.team_name}" has ${size}.`, "TEAM_SIZE", extra);
        if (max !== null && size > max) throw badRequest(`"${categoryLabel(r.cat)}" allows at most ${max} players including you. "${team.team_name}" has ${size}.`, "TEAM_SIZE", extra);

        for (const { member, user } of roster) {
            assertPlayerEligible(user, [r.cat], memberDisplay(member, user));
        }
        r.team = team;
        r.roster = roster;
    }

    // Nobody may be entered twice in the same category.
    const activeEntries = await loadActiveEventEntries(event);
    const participants = categoryParticipants(activeEntries, resolved.map((r) => r.cat));
    for (const r of resolved) {
        const holders = participants.get(String(r.cat.id));
        const extra = { categoryId: String(r.cat.id) };
        if (holders.has(String(userId))) {
            throw badRequest(`You are already registered in "${categoryLabel(r.cat)}"`, "ALREADY_REGISTERED", extra);
        }
        for (const { member, user } of r.roster || []) {
            if (holders.has(String(user.id))) {
                throw badRequest(
                    `${memberDisplay(member, user)} is already registered in "${categoryLabel(r.cat)}". A player can be entered only once per category.`,
                    "ALREADY_REGISTERED", extra
                );
            }
        }
    }

    // One-category events: nobody on this entry — payer or partner/team-mate —
    // may already hold a place in any other category of the event. Runs after
    // the per-category check so "already in THIS category" keeps its own,
    // more precise message.
    if (oneCategoryOnly) {
        const held = eventParticipants(activeEntries, normalized);
        for (const r of resolved) {
            const extra = { categoryId: String(r.cat.id) };
            const payerHolds = held.get(String(userId));
            if (payerHolds) {
                throw badRequest(
                    `${SINGLE_CATEGORY_MESSAGE} You are already registered in "${payerHolds}".`,
                    "SINGLE_CATEGORY_ONLY", extra
                );
            }
            for (const { member, user } of r.roster || []) {
                const memberHolds = held.get(String(user.id));
                if (memberHolds) {
                    throw badRequest(
                        `${memberDisplay(member, user)} is already registered in "${memberHolds}". ${SINGLE_CATEGORY_MESSAGE}`,
                        "SINGLE_CATEGORY_ONLY", extra
                    );
                }
            }
        }
    }

    return { fee: resolved.reduce((s, r) => s + r.fee, 0), ...buildGroups(resolved), resolved };
};

/**
 * Rows to write: ONE PER CATEGORY ENTRY — each Doubles/Team entry with its
 * team, each singles category on its own. One row = one entry is what makes
 * every count (event card, registrations list, events list, slots) agree: a
 * row holding two singles categories counted as 1 in row-based lists but 2 in
 * the entry-based slot cards. The rows still share one transaction and one
 * registration number, so it is still one payment and one receipt.
 */
const buildGroups = (resolved) => ({
    groups: resolved.map((r) => ({ teamId: r.teamId || null, categories: [r.categoryObject], fee: r.fee })),
    categoryObjects: resolved.map((r) => r.categoryObject),
});

// ── Razorpay order notes ─────────────────────────────────────────────────────
// Verify, the webhook and reconcile all rebuild the registration from the order
// notes (the body sent with verify is untrusted). Notes are capped at 15 keys of
// 256 chars, so entries are packed as "catId:teamId" pairs across e0..e9.
const NOTE_VALUE_MAX = 250;
const NOTE_ENTRY_KEYS = 10;

export const packEntriesIntoNotes = (groups) => {
    const tokens = groups.flatMap((g) => g.categories.map((c) => `${c.id}:${g.teamId || ""}`));
    const notes = {};
    let key = 0;
    let current = "";
    for (const token of tokens) {
        if (current && current.length + 1 + token.length > NOTE_VALUE_MAX) {
            notes[`e${key++}`] = current;
            current = "";
        }
        current = current ? `${current},${token}` : token;
    }
    if (current) notes[`e${key++}`] = current;
    if (key > NOTE_ENTRY_KEYS) throw badRequest("Too many categories in one payment — please register in two parts");
    return notes;
};

/**
 * Entries recorded on an order. Orders created before per-category teams carry
 * `catIds` + one `teamId`; they are flagged `legacy` so they are stored exactly
 * as they were sold (one row, one team).
 */
export const entriesFromNotes = (notes) => {
    const parts = [];
    for (let i = 0; i < NOTE_ENTRY_KEYS; i++) {
        const value = notes?.[`e${i}`];
        if (!value) break;
        parts.push(...String(value).split(",").filter(Boolean));
    }
    if (parts.length > 0) {
        return parts.map((p) => {
            const idx = p.lastIndexOf(":");
            return { categoryId: p.slice(0, idx), teamId: p.slice(idx + 1) || null };
        });
    }
    if (notes?.catIds) {
        return String(notes.catIds).split(",").filter(Boolean)
            .map((categoryId) => ({ categoryId, teamId: notes.teamId || null, legacy: true }));
    }
    return [];
};

/**
 * Rows for an order that has ALREADY been paid. No eligibility or duplicate
 * checks — those ran when the order was created, and refusing to record a
 * captured payment would only lose the player's money. Fees come from the
 * event; the caller reconciles their total with what Razorpay actually took.
 */
export const groupsForPaidOrder = (event, entries) => {
    const normalized = normalizeEventCategories(event);
    const baseFee = normalized[0]?.entryFee ?? DEFAULT_CATEGORY_FEE;
    const resolved = [];
    for (const e of entries) {
        const cat = findEventCategory(normalized, e.categoryId);
        if (!cat) continue; // category deleted since — nothing to attach it to
        const fee = cat.entryFee ?? baseFee;
        resolved.push({ cat, fee, categoryObject: toCategoryObject(cat, fee), teamId: e.teamId || null });
    }

    if (entries.some((e) => e.legacy)) {
        const teamId = resolved.find((r) => r.teamId)?.teamId || null;
        return [{ teamId, categories: resolved.map((r) => r.categoryObject), fee: resolved.reduce((s, r) => s + r.fee, 0) }];
    }
    for (const r of resolved) if (!isTeamMatchType(r.cat.matchType)) r.teamId = null;
    return buildGroups(resolved).groups;
};

/**
 * Spread the amount actually paid over the rows, so the rows always add up to
 * the transaction. Normally each row's own fee already does; if the organiser
 * changed a fee mid-checkout the difference sits on the first row.
 */
export const allocateAmount = (groups, amountPaid) => {
    if (groups.length === 0) return groups;
    const total = groups.reduce((s, g) => s + (Number(g.fee) || 0), 0);
    const diff = Math.round((Number(amountPaid) - total) * 100) / 100;
    return groups.map((g, i) => ({ ...g, fee: i === 0 ? (Number(g.fee) || 0) + diff : (Number(g.fee) || 0) }));
};
