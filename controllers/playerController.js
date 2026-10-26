import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { cacheGet, cacheSet } from "../config/redisClient.js";
import { dashboardCacheKey, DASHBOARD_CACHE_TTL, invalidateDashboardCache } from "../utils/dashboardCache.js";
import { calculateAge, resolveAge, withResolvedAge } from "../utils/age.js";
import { getPublicEventId } from "../utils/eventResolver.js";
import { isTeamMatchType } from "../utils/registrationRules.js";
import { getNextPlayerId } from "../utils/playerIdHelper.js";
import { uploadBase64 } from "../utils/uploadHelper.js";
import { cleanFlatBuildingWing, cleanTshirtSize, normalizeGender } from "../utils/playerProfileFields.js";
import { getFamily, getFamilyUsers, inSameFamily, leaveFamily, STORED_RELATION } from "../utils/family.js";

/* ================= FAMILY VIEW HELPERS ================= */

const displayName = (user) =>
    user?.name || `${user?.first_name || ""} ${user?.last_name || ""}`.trim();

const toFamilyMember = (user) => ({
    id: user.id,
    player_id: user.player_id,
    name: displayName(user),
    dob: user.dob,
    // Derived, never the stored column — see utils/age.js.
    age: resolveAge(user),
    gender: user.gender,
    email: user.email,
    aadhaar: user.aadhaar,
    photos: user.photos,
    apartment: user.apartment,
    street: user.street,
    flat_building_wing: user.flat_building_wing ?? null,
    tshirt_size: user.tshirt_size ?? null,
    city: user.city,
    state: user.state,
    pincode: user.pincode,
    country: user.country,
});

/**
 * The Family tab: everyone else in the family, and the events they are entered
 * in. Every member sees the same thing, because families have no roles (see
 * utils/family.js).
 */
const buildFamilyView = async (userId) => {
    const others = (await getFamilyUsers(userId)).filter(u => u.id !== userId);
    if (others.length === 0) return { familyMembers: [], familyRegistrations: [] };

    const { data: memberRegs, error: memberRegsError } = await supabaseAdmin
        .from("event_registrations")
        .select(`id, registration_no, status, created_at, event_id, player_id, categories, amount_paid, events ( id, public_id, name, sport, start_date, location )`)
        .in("player_id", others.map(u => u.id))
        .order("created_at", { ascending: false });
    if (memberRegsError) throw memberRegsError;

    const usersById = new Map(others.map(u => [u.id, u]));
    const familyRegistrations = (memberRegs || []).map(reg => {
        const member = usersById.get(reg.player_id);
        return {
            ...reg,
            events: reg.events
                ? { ...reg.events, public_id: getPublicEventId(reg.events) }
                : reg.events,
            member_name: member ? displayName(member) : null,
            member_player_id: member?.player_id || null,
        };
    });

    return { familyMembers: others.map(toFamilyMember), familyRegistrations };
};

/** Clear the cached dashboard of everyone in the given families. */
const invalidateFamilyDashboards = (ids) =>
    Promise.all([...new Set(ids.filter(Boolean))].map(id => invalidateDashboardCache(id)));

// GET /api/player/dashboard
export const getPlayerDashboard = async (req, res) => {
    try {
        const userId = req.user.id;

        const dashboardKey = dashboardCacheKey(userId);
        const cachedDashboard = await cacheGet(dashboardKey);
        if (cachedDashboard) {
            console.log(`[dashboard] cache HIT  ${dashboardKey}`);
            return res.json(cachedDashboard);
        }
        console.log(`[dashboard] cache MISS ${dashboardKey}`);

        const { data: player, error } = await supabaseAdmin.from("users").select("*").eq("id", userId).maybeSingle();
        if (error) throw error;
        if (!player) return res.status(404).json({ message: "Player not found" });

        // These lookups don't depend on each other — run them in one parallel batch
        // instead of ~5 sequential round-trips.
        const [
            { data: schoolDetails },
            { data: captainTeams, error: captainTeamsError },
            { data: memberTeams, error: memberTeamsError },
            { data: allTeams, error: allTeamsError },
            { data: transactions },
        ] = await Promise.all([
            supabaseAdmin.from("player_school_details").select("*").eq("player_id", userId).maybeSingle(),
            supabaseAdmin.from("player_teams").select("id").eq("captain_id", userId),
            // The payload has to be pre-stringified JSON: handed a JS array,
            // supabase-js emits a Postgres *array* literal (`cs.{[object Object]}`)
            // rather than jsonb containment, so this filter never matched anything.
            player.mobile
                ? supabaseAdmin.from("player_teams").select("id").contains("members", JSON.stringify([{ mobile: player.mobile }]))
                : Promise.resolve({ data: [] }),
            supabaseAdmin.from("player_teams").select("id, members"),
            supabaseAdmin.from("transactions").select("*").eq("user_id", userId),
        ]);

        // These three decide `relevantTeamIds`, which decides whether team
        // registrations appear at all. Swallowing a failure here silently drops
        // every event the player entered as part of a squad, and the result is
        // then cached — so it must fail loudly rather than under-report.
        // schoolDetails and transactions are presentational and stay tolerant.
        const teamLookupError = captainTeamsError || memberTeamsError || allTeamsError;
        if (teamLookupError) throw teamLookupError;

        if (schoolDetails) player.schoolDetails = schoolDetails;

        // Collect every team this player belongs to: captain, member-by-mobile,
        // or member-by-id/player_id inside the members array.
        let relevantTeamIds = [];
        (captainTeams || []).forEach(t => relevantTeamIds.push(t.id));
        (memberTeams || []).forEach(t => relevantTeamIds.push(t.id));
        (allTeams || []).forEach(team => {
            if (Array.isArray(team.members) && team.members.some(m =>
                m.id === userId ||
                (player.player_id && m.player_id === player.player_id)
            )) {
                relevantTeamIds.push(team.id);
            }
        });
        relevantTeamIds = [...new Set(relevantTeamIds)];

        // Fetch Registrations
        let query = supabaseAdmin.from("event_registrations").select(`*, events ( id, public_id, name, sport, start_date, end_date, location )`).order('created_at', { ascending: false });
        if (relevantTeamIds.length > 0) {
            query = query.or(`player_id.eq.${userId},team_id.in.(${relevantTeamIds.join(',')})`);
        } else {
            query = query.eq("player_id", userId);
        }
        // The error MUST be inspected. Discarding it left `registrations`
        // undefined, which fell through to `(registrations || [])` and returned
        // `{ success: true, registrations: [] }` — a 200 that is indistinguishable
        // from "this player has registered for nothing". Worse, that empty result
        // was then cached for DASHBOARD_CACHE_TTL, so one transient PostgREST
        // failure turned into 15 minutes of a paid-up player being told
        // "No events found" while the admin screen showed their registration.
        // Failing loudly means the client retries instead of trusting a lie.
        const { data: registrations, error: registrationsError } = await query;
        if (registrationsError) throw registrationsError;

        // Batch-fetch team details for ALL registrations in one query (was an N+1:
        // one player_teams query per registration → dozens of round-trips).
        const regTeamIds = [...new Set((registrations || []).filter(r => r.team_id).map(r => r.team_id))];
        const teamsById = {};
        if (regTeamIds.length > 0) {
            const { data: regTeams } = await supabaseAdmin.from("player_teams").select("*").in("id", regTeamIds);
            (regTeams || []).forEach(t => { teamsById[t.id] = t; });
        }

        // Merge Details (pure in-memory now — no awaits inside the loop)
        const detailedRegistrations = (registrations || []).map((reg) => {
            const txn = (transactions || []).find(t => (reg.transaction_id && t.id === reg.transaction_id) || (t.event_id === reg.event_id));
            let teamDetails = null;
            let isTeamMember = false;
            let isCaptain = false;
            if (reg.team_id) {
                const team = teamsById[reg.team_id] || null;
                teamDetails = team;
                if (team) {
                    isCaptain = team.captain_id === userId;
                    isTeamMember = !isCaptain && Array.isArray(team.members) && team.members.some(m =>
                        m.id === userId ||
                        (player.mobile && m.mobile === player.mobile) ||
                        (player.player_id && m.player_id === player.player_id)
                    );
                }
            }
            // A partner/team-mate plays only the Doubles/Team categories of a
            // row their captain paid for. Rows from before per-category teams
            // could list the captain's singles alongside, and showing those
            // marked the partner as "registered" in a draw they were never in.
            const isPayer = reg.player_id === userId;
            let categories = reg.categories;
            if (!isPayer && Array.isArray(categories)) {
                categories = categories.filter((c) =>
                    !(c && typeof c === "object" && c.matchType) || isTeamMatchType(c.matchType));
            }
            return {
                ...reg,
                categories,
                events: reg.events
                    ? { ...reg.events, public_id: getPublicEventId(reg.events) }
                    : reg.events,
                transactions: txn || null,
                team_details: teamDetails,
                is_team_member: isTeamMember,
                is_captain: isCaptain,
                registered_by: isPayer ? 'self' : 'team',
                // Who entered this player, for "Registered by <captain>" on the
                // event and dashboard pages. Null when they registered themselves.
                registered_by_name: isPayer ? null : (teamDetails?.captain_name || null),
            };
        });

        // Throws rather than returning an empty family: a swallowed error would
        // render (and cache) a family as though it had no members.
        const { familyMembers, familyRegistrations } = await buildFamilyView(userId);

        const payload = {
            success: true,
            // age recomputed from dob so the client never sees a stale value
            player: withResolvedAge(player),
            registrations: detailedRegistrations,
            familyMembers,
            familyRegistrations,
        };

        // Fire-and-forget: a cache write must not delay the response.
        void cacheSet(dashboardKey, payload, DASHBOARD_CACHE_TTL);
        res.json(payload);

    } catch (err) {
        console.error("DASHBOARD ERROR:", err);
        res.status(500).json({ message: "Failed to load dashboard" });
    }
};

const FAMILY_MOBILE_LOCKED_MESSAGE =
    "This mobile number is shared by your family, so it can't be changed here.";

const MOBILE_IN_USE_MESSAGE =
    "This mobile number is already used by another account. To join that family, sign up with the number instead (verified by WhatsApp OTP).";

// POST /api/player/check-conflict
export const checkConflict = async (req, res) => {
    try {
        const userId = req.user.id;
        const { email, mobile } = req.body;
        const { data: currentUser } = await supabaseAdmin.from("users").select("email, mobile").eq("id", userId).maybeSingle();

        // Only a field that is actually being changed can conflict. The client sends
        // both values every time, so without this an unchanged mobile that another
        // account also holds blocked an email-only edit with "Mobile already taken".
        // update-profile applies the same rule when it saves.
        const norm = (v) => String(v ?? "").trim().toLowerCase();
        const emailChanged = norm(email) !== norm(currentUser?.email);
        const mobileChanged = norm(mobile) !== norm(currentUser?.mobile);

        if (email && emailChanged) {
            const { data } = await supabaseAdmin.from("users").select("id").eq("email", email).neq("id", userId).maybeSingle();
            if (data) return res.status(409).json({ conflict: true, field: 'email', message: "Email already taken" });
        }
        if (mobile && mobileChanged) {
            // Joining another family's number needs a WhatsApp OTP to it, which
            // only signup does. A list, not maybeSingle: a shared number holds
            // several rows, and maybeSingle's error on 2+ rows read as "free".
            const { data, error } = await supabaseAdmin.from("users").select("id").eq("mobile", mobile).neq("id", userId).limit(1);
            if (error) throw error;
            if ((data || []).length > 0) {
                return res.status(409).json({ conflict: true, field: 'mobile', message: MOBILE_IN_USE_MESSAGE });
            }
        }
        res.json({ conflict: false });
    } catch (err) { res.status(500).json({ message: "Server error" }); }
};

// POST /api/player/check-password
export const checkPassword = async (req, res) => {
    try {
        const { currentPassword } = req.body;
        if (!currentPassword) return res.status(400).json({ message: "Password required" });
        const { data: user } = await supabaseAdmin.from("users").select("password").eq("id", req.user.id).maybeSingle();
        if (!user) return res.status(401).json({ correct: false, message: "User not found" });

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) return res.status(401).json({ correct: false, message: "Incorrect password" });
        
        res.json({ correct: true });
    } catch (err) { res.status(500).json({ message: "Server error" }); }
};

// PUT /api/player/update-profile
export const updateProfile = async (req, res) => {
    try {
        const userId = req.user.id;
        const { email, mobile, photos, apartment, street, flat_building_wing, tshirt_size, city, state, pincode, country, gender, first_name, last_name } = req.body;

        const { data: currentUser, error: fetchError } = await supabaseAdmin.from("users").select("*").eq("id", userId).maybeSingle();
        if (fetchError || !currentUser) return res.status(404).json({ message: "User not found" });

        // currentUser.email is null for members added without one; reading
        // .toLowerCase() off it crashed the save the first time they typed one.
        const isSensitiveChange = (email && email.toLowerCase().trim() !== (currentUser.email || "").toLowerCase().trim()) || (mobile && mobile !== currentUser.mobile);

        if (isSensitiveChange) {
            const token = req.headers['x-verification-token'];
            if (!token) return res.status(403).json({ message: "Verification required", requiresVerification: true });
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                if (decoded.id !== userId || decoded.type !== 'verification') throw new Error("Invalid token");
            } catch (e) { return res.status(403).json({ message: "Invalid verification token" }); }
        }

        // Conflict Checks
        if (email && email !== currentUser.email) {
            const { data } = await supabaseAdmin.from("users").select("id").eq("email", email).neq("id", userId).maybeSingle();
            if (data) return res.status(409).json({ message: "Email taken" });
        }
        let family = null;
        if (mobile && mobile !== currentUser.mobile) {
            // A family is one number. One member moving to another number would
            // split it in two, so a shared number can't be changed from here.
            family = await getFamily(userId);
            if (family.ids.length > 1) {
                return res.status(409).json({ message: FAMILY_MOBILE_LOCKED_MESSAGE });
            }
            const { data, error } = await supabaseAdmin.from("users").select("id").eq("mobile", mobile).neq("id", userId).limit(1);
            if (error) throw error;
            if ((data || []).length > 0) return res.status(409).json({ message: MOBILE_IN_USE_MESSAGE });
        }

        let photoUrl = photos;
        if (photos && photos.startsWith('data:')) {
            photoUrl = await uploadBase64(photos, 'player-photos');
        }

        // Gender can be filled in once, by accounts made before signup required
        // it. After that it is fixed here: category eligibility depends on it,
        // so changing it goes through an admin, not the player.
        let nextGender = currentUser.gender;
        if (!normalizeGender(currentUser.gender) && gender) {
            nextGender = normalizeGender(gender);
            if (!nextGender) return res.status(400).json({ message: "Gender must be Male or Female" });
        }

        const updates = {
            email: email || currentUser.email,
            mobile: mobile || currentUser.mobile,
            first_name: first_name !== undefined ? first_name.trim() : currentUser.first_name,
            last_name: last_name !== undefined ? last_name.trim() : currentUser.last_name,
            apartment: apartment !== undefined ? apartment : currentUser.apartment,
            street: street !== undefined ? street : currentUser.street,
            city: city !== undefined ? city : currentUser.city,
            state: state !== undefined ? state : currentUser.state,
            pincode: pincode !== undefined ? pincode : currentUser.pincode,
            country: country !== undefined ? country : currentUser.country,
            gender: nextGender,
            photos: photoUrl || currentUser.photos,
            // Only written when the client sent them, so a database without the
            // columns still accepts every other profile edit.
            ...(flat_building_wing !== undefined ? { flat_building_wing: cleanFlatBuildingWing(flat_building_wing) } : {}),
            ...(tshirt_size !== undefined ? { tshirt_size: cleanTshirtSize(tshirt_size) } : {})
        };

        const { data: updatedPlayer, error } = await supabaseAdmin.from("users").update(updates).eq("id", userId).select();
        if (error) throw error;

        // Name and photo also show in the rest of the family's Family tab.
        await invalidateFamilyDashboards((family || await getFamily(userId)).ids);
        res.json({ success: true, player: withResolvedAge(updatedPlayer?.[0] || updates), message: "Profile updated" });

    } catch (err) {
        console.error("UPDATE ERROR:", err);
        res.status(500).json({ message: "Failed to update profile" });
    }
};

// PUT /api/player/change-password
export const changePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return res.status(400).json({ message: "All fields required" });

        const token = req.headers['x-verification-token'];
        if (!token) return res.status(403).json({ message: "Verification required", requiresVerification: true });
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            if (decoded.id !== req.user.id || decoded.type !== 'verification') throw new Error();
        } catch (e) { return res.status(403).json({ message: "Invalid token" }); }

        const { data: user } = await supabaseAdmin.from("users").select("password").eq("id", req.user.id).maybeSingle();
        let isMatch;
        try {
            isMatch = await bcrypt.compare(currentPassword, user.password);
        } catch (compareErr) {
            console.error("PASSWORD COMPARE ERROR:", compareErr.message);
            return res.status(500).json({ message: "Password verification failed. Please try again." });
        }
        if (!isMatch) return res.status(401).json({ message: "Incorrect current password" });

        let hashedNewPassword;
        try {
            hashedNewPassword = await bcrypt.hash(newPassword, 12);
        } catch (hashErr) {
            console.error("PASSWORD HASH ERROR:", hashErr.message);
            return res.status(500).json({ message: "Failed to secure new password. Please try again." });
        }
        const { error } = await supabaseAdmin.from("users").update({ password: hashedNewPassword }).eq("id", req.user.id);
        if (error) throw error;
        await invalidateDashboardCache(req.user.id);
        res.json({ success: true, message: "Password updated" });
    } catch (err) { res.status(500).json({ message: "Failed to change password" }); }
};

// DELETE /api/player/delete-account
/**
 * Check an account's own password: the proof needed before deleting it or
 * removing it from the family. Switching profiles gives anyone in a family
 * that member's session, but not their password.
 */
const passwordMatches = async (userId, password) => {
    if (!password) return false;
    const { data: user, error } = await supabaseAdmin.from("users").select("password").eq("id", userId).maybeSingle();
    if (error) throw error;
    if (!user?.password) return false;
    return bcrypt.compare(String(password), user.password);
};

const PASSWORD_REQUIRED_MESSAGE = "Enter this player's own password to confirm.";
const WRONG_PASSWORD_MESSAGE = "That password is not correct for this player.";

/**
 * Delete an account and everything under it. The family is re-anchored
 * first: deleting a user cascades their family_relations rows, which would
 * otherwise dissolve the family if this was its anchor.
 */
const deletePlayerAccount = async (userId) => {
    const touched = await leaveFamily(userId);
    await supabaseAdmin.from("player_school_details").delete().eq("player_id", userId);
    await supabaseAdmin.from("event_registrations").delete().eq("player_id", userId);
    await supabaseAdmin.from("transactions").delete().eq("user_id", userId);
    await supabaseAdmin.from("player_teams").delete().eq("captain_id", userId);
    const { error } = await supabaseAdmin.from("users").delete().eq("id", userId);
    if (error) throw error;
    await invalidateFamilyDashboards([userId, ...touched]);
};

// DELETE /api/player/delete-account  { password }
export const deleteAccount = async (req, res) => {
    try {
        const userId = req.user.id;
        const { password } = req.body || {};
        if (!password) return res.status(400).json({ message: PASSWORD_REQUIRED_MESSAGE });
        if (!(await passwordMatches(userId, password))) {
            return res.status(401).json({ message: WRONG_PASSWORD_MESSAGE });
        }

        await deletePlayerAccount(userId);
        res.json({ success: true, message: "Account deleted" });
    } catch (err) {
        console.error("DELETE ACCOUNT ERROR:", err);
        res.status(500).json({ message: "Failed to delete account" });
    }
};

/* ================= FAMILY MEMBER MANAGEMENT ================= */

// Everyone in a family manages it equally (see utils/family.js): anyone can
// add a member and edit another member's details. Removing a member needs
// that member's own password.

const FAMILY_ONLY_MESSAGE = "That player is not in your family.";

const GENDER_VALUES_MESSAGE = "Gender must be Male or Female";

const IDENTITY_LOCKED_MESSAGE = (field) =>
    `A player's ${field} can't be changed once it is set. If it is wrong, please contact the organisers to correct it.`;

/** Default password: the date of birth as DDMMYYYY. */
const dobPassword = (dob) => {
    const [year, month, day] = String(dob).slice(0, 10).split("-");
    return `${day}${month}${year}`;
};

export const addFamilyMember = async (req, res) => {
    try {
        const userId = req.user.id;
        const { name, dob, gender, email, aadhaar, apartment, street, flat_building_wing, tshirt_size, city, state, pincode, country } = req.body;

        if (!name?.trim() || !dob || !gender) {
            return res.status(400).json({ message: "Name, DOB, and Gender are required" });
        }
        // Same rule as Edit Profile: categories need Male or Female, and once
        // saved it is locked (see updateFamilyMember).
        if (!normalizeGender(gender)) {
            return res.status(400).json({ message: GENDER_VALUES_MESSAGE });
        }

        // The member joins the family's number. That is the anchor's number,
        // which every member shares.
        const { anchorId, ids: familyIds } = await getFamily(userId);
        const { data: anchor } = await supabaseAdmin
            .from("users")
            .select("mobile")
            .eq("id", anchorId)
            .maybeSingle();
        if (!anchor) return res.status(404).json({ message: "Player not found" });

        // Check email uniqueness (if provided)
        if (email) {
            const { data: emailExists } = await supabaseAdmin
                .from("users").select("id").eq("email", email).maybeSingle();
            if (emailExists) return res.status(400).json({ message: "Email already in use" });
        }

        // Check aadhaar uniqueness (if provided)
        if (aadhaar) {
            const { data: aadhaarExists } = await supabaseAdmin
                .from("users").select("id").eq("aadhaar", aadhaar).maybeSingle();
            if (aadhaarExists) return res.status(400).json({ message: "Aadhaar already in use" });
        }

        // Any age may be added. Each member logs in with their own password
        // (their DOB) and everyone in the family can switch to them.
        const age = calculateAge(dob);
        if (age === null) {
            return res.status(400).json({ message: "Invalid date of birth" });
        }

        // Password = bcrypt(DDMMYYYY, 12)
        const password = await bcrypt.hash(dobPassword(dob), 12);

        // Generate player_id
        let newPlayerId;
        try {
            newPlayerId = await getNextPlayerId();
        } catch (idError) {
            console.error("Family Member ID Generation Error:", idError);
            throw new Error("Failed to generate Player ID");
        }

        // Split name
        const nameParts = name.trim().split(/\s+/);
        const firstName = nameParts[0];
        const lastName = nameParts.slice(1).join(" ") || "";

        // Create user in users table
        const newUserId = crypto.randomUUID();
        const { data: newUser, error: insertError } = await supabaseAdmin
            .from("users")
            .insert({
                id: newUserId,
                player_id: newPlayerId,
                first_name: firstName,
                last_name: lastName,
                name: name.trim(),
                email: email || null,
                mobile: anchor.mobile || null,
                dob,
                age,
                gender: normalizeGender(gender),
                apartment: apartment || null,
                street: street || null,
                ...(cleanFlatBuildingWing(flat_building_wing) ? { flat_building_wing: cleanFlatBuildingWing(flat_building_wing) } : {}),
                ...(cleanTshirtSize(tshirt_size) ? { tshirt_size: cleanTshirtSize(tshirt_size) } : {}),
                city: city || null,
                state: state || null,
                pincode: pincode || null,
                country: country || "India",
                aadhaar: aadhaar || null,
                password,
                role: 'player',
                verification: 'verified'
            })
            .select()
            .maybeSingle();

        if (insertError) throw insertError;

        const { error: relError } = await supabaseAdmin
            .from("family_relations")
            .insert({
                head_player_id: anchorId,
                of_player_id: newUserId,
                relation: STORED_RELATION
            });

        if (relError) {
            // Rollback user creation
            await supabaseAdmin.from("users").delete().eq("id", newUserId);
            throw relError;
        }

        // Every member's Family tab now lists the new member.
        await invalidateFamilyDashboards([...familyIds, newUserId]);
        res.status(201).json({ success: true, familyMember: toFamilyMember(newUser) });
    } catch (err) {
        console.error("ADD FAMILY MEMBER ERROR:", err);
        res.status(500).json({ message: err.message || "Failed to add family member" });
    }
};

export const updateFamilyMember = async (req, res) => {
    try {
        const userId = req.user.id;
        const familyMemberId = req.params.id;

        // Your own details are edited from Player Info, which verifies
        // email/mobile changes by OTP.
        if (familyMemberId === userId) {
            return res.status(400).json({ message: "Edit your own details from Player Info." });
        }
        const { ids: familyIds } = await getFamily(userId);
        if (!familyIds.includes(familyMemberId)) {
            return res.status(403).json({ message: FAMILY_ONLY_MESSAGE });
        }

        const { data: member, error: memberError } = await supabaseAdmin
            .from("users").select("email, dob, gender").eq("id", familyMemberId).maybeSingle();
        if (memberError) throw memberError;
        if (!member) return res.status(404).json({ message: "Family member not found" });

        const { name, dob, gender, email, aadhaar, apartment, street, flat_building_wing, tshirt_size, city, state, pincode, country } = req.body;

        // An email someone already has is their login and where their codes go.
        // Changing it needs their own verification, from their profile.
        const normalizedEmail = (email || "").trim().toLowerCase();
        if (member.email && email !== undefined && normalizedEmail !== member.email.trim().toLowerCase()) {
            return res.status(403).json({
                message: "This member's email can only be changed from their own profile. Switch to them and use Edit Profile.",
            });
        }

        // Uniqueness, excluding the member being edited — otherwise re-saving a
        // form without touching the email would collide with the member's own
        // row. addFamilyMember checks these too; an update skipped them entirely
        // and let a duplicate through to the database constraint as a raw 500.
        if (email) {
            const { data: emailExists } = await supabaseAdmin
                .from("users").select("id").eq("email", email).neq("id", familyMemberId).maybeSingle();
            if (emailExists) return res.status(400).json({ message: "Email already in use" });
        }
        if (aadhaar) {
            const { data: aadhaarExists } = await supabaseAdmin
                .from("users").select("id").eq("aadhaar", aadhaar).neq("id", familyMemberId).maybeSingle();
            if (aadhaarExists) return res.status(400).json({ message: "Aadhaar already in use" });
        }

        // Date of birth and gender decide which categories a player may enter.
        // Once either is set, no family member can change it, and the player
        // can't either (Edit Profile doesn't accept them). Only an admin can
        // correct a wrong one, so an entry can't be made eligible by editing
        // a birth year. A member who has none yet can have it filled in once.
        const sameDob = String(dob ?? "").slice(0, 10) === String(member.dob ?? "").slice(0, 10);
        if (dob !== undefined && member.dob && !sameDob) {
            return res.status(403).json({ message: IDENTITY_LOCKED_MESSAGE("date of birth") });
        }
        const storedGender = normalizeGender(member.gender);
        if (gender !== undefined && storedGender && normalizeGender(gender) !== storedGender) {
            return res.status(403).json({ message: IDENTITY_LOCKED_MESSAGE("gender") });
        }

        // Build update object
        const updateData = {};
        if (name !== undefined) {
            if (!name.trim()) return res.status(400).json({ message: "Name is required" });
            updateData.name = name.trim();
            const parts = name.trim().split(/\s+/);
            updateData.first_name = parts[0];
            updateData.last_name = parts.slice(1).join(" ") || "";
        }
        // Only reached when filling in a missing value (see the lock above).
        if (dob && !member.dob) {
            const age = calculateAge(dob);
            if (age === null) {
                return res.status(400).json({ message: "Invalid date of birth" });
            }
            updateData.dob = dob;
            updateData.age = age;
        }
        if (gender && !storedGender) {
            if (!normalizeGender(gender)) return res.status(400).json({ message: GENDER_VALUES_MESSAGE });
            updateData.gender = normalizeGender(gender);
        }
        if (email !== undefined) updateData.email = email || null;
        if (aadhaar !== undefined) updateData.aadhaar = aadhaar || null;
        if (apartment !== undefined) updateData.apartment = apartment || null;
        if (street !== undefined) updateData.street = street || null;
        if (flat_building_wing !== undefined) updateData.flat_building_wing = cleanFlatBuildingWing(flat_building_wing);
        if (tshirt_size !== undefined) updateData.tshirt_size = cleanTshirtSize(tshirt_size);
        if (city !== undefined) updateData.city = city || null;
        if (state !== undefined) updateData.state = state || null;
        if (pincode !== undefined) updateData.pincode = pincode || null;
        if (country !== undefined) updateData.country = country || null;

        const { data: updatedUser, error: updateError } = await supabaseAdmin
            .from("users")
            .update(updateData)
            .eq("id", familyMemberId)
            .select()
            .maybeSingle();

        if (updateError) throw updateError;

        await invalidateFamilyDashboards(familyIds);
        res.json({ success: true, familyMember: toFamilyMember(updatedUser) });
    } catch (err) {
        console.error("UPDATE FAMILY MEMBER ERROR:", err);
        res.status(500).json({ message: "Failed to update family member" });
    }
};

// DELETE /api/player/delete-family-member/:id  { mode: 'full' | 'unlink', password }
export const deleteFamilyMember = async (req, res) => {
    try {
        const userId = req.user.id;
        const familyMemberId = req.params.id;
        const { mode, password } = req.body || {};
        if (mode !== "full" && mode !== "unlink") {
            return res.status(400).json({ message: "Choose how to remove this member." });
        }
        if (familyMemberId === userId) {
            return res.status(400).json({ message: "You can't remove yourself here. Switch to another family member to remove this profile." });
        }

        if (!(await inSameFamily(userId, familyMemberId))) {
            return res.status(403).json({ message: FAMILY_ONLY_MESSAGE });
        }
        if (!password) return res.status(400).json({ message: PASSWORD_REQUIRED_MESSAGE });
        if (!(await passwordMatches(familyMemberId, password))) {
            return res.status(401).json({ message: WRONG_PASSWORD_MESSAGE });
        }

        if (mode === "full") {
            await deletePlayerAccount(familyMemberId);
            return res.json({ success: true, message: "Family member removed and account deleted" });
        }

        // Unlink: out of the family, and off its number so the next signup on
        // that number doesn't merge them straight back in. Their remaining
        // sign-in routes are Player ID, email or aadhaar.
        const touched = await leaveFamily(familyMemberId);
        const { error } = await supabaseAdmin.from("users").update({ mobile: null }).eq("id", familyMemberId);
        if (error) throw error;
        await invalidateFamilyDashboards([familyMemberId, ...touched]);
        res.json({ success: true, message: "Family member unlinked. They can now operate independently." });
    } catch (err) {
        console.error("DELETE FAMILY MEMBER ERROR:", err);
        res.status(500).json({ message: "Failed to remove family member" });
    }
};
