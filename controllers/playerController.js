import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { cacheGet, cacheSet } from "../config/redisClient.js";
import { dashboardCacheKey, DASHBOARD_CACHE_TTL, invalidateDashboardCache } from "../utils/dashboardCache.js";
import { calculateAge, MINOR_AGE_LIMIT, resolveAge, withResolvedAge } from "../utils/age.js";
import { getPublicEventId } from "../utils/eventResolver.js";
import { getNextPlayerId } from "../utils/playerIdHelper.js";
import { uploadBase64 } from "../utils/uploadHelper.js";

/* ================= FAMILY VIEW HELPERS ================= */

// The head stores one label per member ("Child"). A member opening their own
// dashboard has to see the inverse of it, or every child would be told their
// parent is their "Child".
const REVERSED_RELATION = {
    Child: 'Parent',
    Parent: 'Child',
    Spouse: 'Spouse',
    Sibling: 'Sibling',
    Other: 'Family',
};

// And how one member should be labelled to another member, keyed by the head's
// label for that other person.
const SIBLING_RELATION = {
    Child: 'Sibling',
    Spouse: 'Parent',
    Parent: 'Family',
    Sibling: 'Family',
    Other: 'Family',
};

const displayName = (user) =>
    user?.name || `${user?.first_name || ""} ${user?.last_name || ""}`.trim();

const toFamilyMember = (user, relation) => ({
    id: user.id,
    player_id: user.player_id,
    name: displayName(user),
    relation,
    dob: user.dob,
    // Derived, never the stored column — see utils/age.js.
    age: resolveAge(user),
    gender: user.gender,
    email: user.email,
    aadhaar: user.aadhaar,
    photos: user.photos,
    apartment: user.apartment,
    street: user.street,
    city: user.city,
    state: user.state,
    pincode: user.pincode,
    country: user.country,
});

/**
 * Everything the dashboard needs to render the Family tab, from the point of
 * view of whoever is signed in.
 *
 * A head sees their minors and every event those minors are entered in. A minor
 * sees the head and their siblings, read-only, and no registrations — those
 * belong to the head to manage.
 */
const buildFamilyView = async (userId, headRelations, memberRelation) => {
    // Anyone who is not linked *under* someone is a head — including a brand new
    // account with no children yet. Gating this on "has children" instead would
    // hide the Add Member button from exactly the people who need it first.
    const isHead = !memberRelation;

    if (isHead) {
        const memberIds = (headRelations || []).map(r => r.of_player_id).filter(Boolean);
        if (memberIds.length === 0) {
            return { familyMembers: [], familyRegistrations: [], isHead: true, registeredBy: null };
        }

        const relationById = new Map((headRelations || []).map(r => [r.of_player_id, r.relation]));

        // One query for all members and one for all their registrations — not
        // one pair per child.
        const [
            { data: memberUsers, error: memberUsersError },
            { data: memberRegs, error: memberRegsError },
        ] = await Promise.all([
            supabaseAdmin.from("users").select("*").in("id", memberIds),
            supabaseAdmin
                .from("event_registrations")
                .select(`id, registration_no, status, created_at, event_id, player_id, categories, amount_paid, events ( id, public_id, name, sport, start_date, location )`)
                .in("player_id", memberIds)
                .order("created_at", { ascending: false }),
        ]);
        if (memberUsersError) throw memberUsersError;
        if (memberRegsError) throw memberRegsError;

        const usersById = new Map((memberUsers || []).map(u => [u.id, u]));

        const familyMembers = memberIds
            .map(id => usersById.get(id))
            .filter(Boolean)
            .map(u => toFamilyMember(u, relationById.get(u.id) || 'Child'))
            .sort((a, b) => (b.age ?? 0) - (a.age ?? 0));

        const familyRegistrations = (memberRegs || []).map(reg => {
            const member = usersById.get(reg.player_id);
            return {
                ...reg,
                events: reg.events
                    ? { ...reg.events, public_id: getPublicEventId(reg.events) }
                    : reg.events,
                member_name: member ? displayName(member) : null,
                member_player_id: member?.player_id || null,
                relation: relationById.get(reg.player_id) || 'Child',
            };
        });

        return { familyMembers, familyRegistrations, isHead: true, registeredBy: null };
    }

    // ---- Signed in as a family member ----
    const headId = memberRelation.head_player_id;
    const [
        { data: headUser, error: headUserError },
        { data: siblingRels, error: siblingRelsError },
    ] = await Promise.all([
        supabaseAdmin.from("users").select("*").eq("id", headId).maybeSingle(),
        supabaseAdmin.from("family_relations").select("of_player_id, relation").eq("head_player_id", headId),
    ]);
    if (headUserError) throw headUserError;
    if (siblingRelsError) throw siblingRelsError;

    const familyMembers = [];
    let registeredBy = null;

    if (headUser) {
        const asSeenByMember = REVERSED_RELATION[memberRelation.relation] || 'Family';
        familyMembers.push(toFamilyMember(headUser, asSeenByMember));
        registeredBy = {
            id: headUser.id,
            name: displayName(headUser),
            player_id: headUser.player_id,
            relation: asSeenByMember,
        };
    }

    const siblingIds = (siblingRels || []).map(r => r.of_player_id).filter(id => id && id !== userId);
    if (siblingIds.length > 0) {
        const { data: siblings, error: siblingsError } = await supabaseAdmin
            .from("users").select("*").in("id", siblingIds);
        if (siblingsError) throw siblingsError;

        const siblingRelationById = new Map((siblingRels || []).map(r => [r.of_player_id, r.relation]));
        (siblings || [])
            .sort((a, b) => (resolveAge(b) ?? 0) - (resolveAge(a) ?? 0))
            .forEach(u => {
                familyMembers.push(toFamilyMember(u, SIBLING_RELATION[siblingRelationById.get(u.id)] || 'Family'));
            });
    }

    // A member's own registrations already come back in `registrations`; the
    // family list is the head's management view and stays empty here.
    return { familyMembers, familyRegistrations: [], isHead: false, registeredBy };
};

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
            { data: headRelations, error: headRelationsError },
            { data: memberRelations, error: memberRelationsError },
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
            // Who this player heads, and who (if anyone) heads them.
            supabaseAdmin.from("family_relations").select("of_player_id, relation").eq("head_player_id", userId),
            supabaseAdmin.from("family_relations").select("head_player_id, relation").eq("of_player_id", userId),
        ]);

        // These three decide `relevantTeamIds`, which decides whether team
        // registrations appear at all. Swallowing a failure here silently drops
        // every event the player entered as part of a squad, and the result is
        // then cached — so it must fail loudly rather than under-report.
        // schoolDetails and transactions are presentational and stay tolerant.
        const teamLookupError = captainTeamsError || memberTeamsError || allTeamsError;
        if (teamLookupError) throw teamLookupError;

        // Same reasoning for the family lookups: a swallowed error here renders
        // a parent's dashboard as though they have no children, and the lie is
        // then cached for DASHBOARD_CACHE_TTL.
        const familyLookupError = headRelationsError || memberRelationsError;
        if (familyLookupError) throw familyLookupError;

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
        let query = supabaseAdmin.from("event_registrations").select(`*, events ( id, public_id, name, sport, start_date, location )`).order('created_at', { ascending: false });
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
            return {
                ...reg,
                events: reg.events
                    ? { ...reg.events, public_id: getPublicEventId(reg.events) }
                    : reg.events,
                transactions: txn || null,
                team_details: teamDetails,
                is_team_member: isTeamMember,
                is_captain: isCaptain,
                registered_by: reg.player_id === userId ? 'self' : 'team'
            };
        });

        const { familyMembers, familyRegistrations, isHead, registeredBy } =
            await buildFamilyView(userId, headRelations, (memberRelations || [])[0] || null);

        const payload = {
            success: true,
            // age recomputed from dob so the client never sees a stale value
            player: withResolvedAge(player),
            registrations: detailedRegistrations,
            familyMembers,
            familyRegistrations,
            isHead,
            registeredBy
        };

        // Fire-and-forget: a cache write must not delay the response.
        void cacheSet(dashboardKey, payload, DASHBOARD_CACHE_TTL);
        res.json(payload);

    } catch (err) {
        console.error("DASHBOARD ERROR:", err);
        res.status(500).json({ message: "Failed to load dashboard" });
    }
};

// POST /api/player/check-conflict
export const checkConflict = async (req, res) => {
    try {
        const userId = req.user.id;
        const { email, mobile } = req.body;
        const { data: currentUser } = await supabaseAdmin.from("users").select("age, dob").eq("id", userId).maybeSingle();
        // Derived from dob — the stored age column is stale for anyone who has
        // had a birthday since signup.
        const resolvedAge = resolveAge(currentUser);
        const allowSharedMobile = resolvedAge !== null && resolvedAge <= 15;

        if (email) {
            const { data } = await supabaseAdmin.from("users").select("id").eq("email", email).neq("id", userId).maybeSingle();
            if (data) return res.status(409).json({ conflict: true, field: 'email', message: "Email already taken" });
        }
        if (mobile) {
            const { data } = await supabaseAdmin.from("users").select("id").eq("mobile", mobile).neq("id", userId).maybeSingle();
            if (data && !allowSharedMobile) return res.status(409).json({ conflict: true, field: 'mobile', message: "Mobile already taken" });
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
        const { email, mobile, photos, apartment, street, city, state, pincode, country, gender, first_name, last_name } = req.body;

        const { data: currentUser, error: fetchError } = await supabaseAdmin.from("users").select("*").eq("id", userId).maybeSingle();
        if (fetchError || !currentUser) return res.status(404).json({ message: "User not found" });

        const isSensitiveChange = (email && email.toLowerCase().trim() !== currentUser.email.toLowerCase().trim()) || (mobile && mobile !== currentUser.mobile);

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
        if (mobile && mobile !== currentUser.mobile) {
            const { data } = await supabaseAdmin.from("users").select("id").eq("mobile", mobile).neq("id", userId).maybeSingle();
            const resolvedAge = resolveAge(currentUser);
            const allowSharedMobile = resolvedAge !== null && resolvedAge <= 15;
            if (data && !allowSharedMobile) return res.status(409).json({ message: "Mobile taken" });
        }

        let photoUrl = photos;
        if (photos && photos.startsWith('data:')) {
            photoUrl = await uploadBase64(photos, 'player-photos');
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
            gender: gender !== undefined ? gender : currentUser.gender,
            photos: photoUrl || currentUser.photos
        };

        const { data: updatedPlayer, error } = await supabaseAdmin.from("users").update(updates).eq("id", userId).select();
        if (error) throw error;

        await invalidateDashboardCache(userId);
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
export const deleteAccount = async (req, res) => {
    try {
        const userId = req.user.id;
        await supabaseAdmin.from("player_school_details").delete().eq("player_id", userId);
        await supabaseAdmin.from("event_registrations").delete().eq("player_id", userId);
        await supabaseAdmin.from("transactions").delete().eq("user_id", userId);
        await supabaseAdmin.from("player_teams").delete().eq("captain_id", userId);
        const { error } = await supabaseAdmin.from("users").delete().eq("id", userId);

        if (error) throw error;
        await invalidateDashboardCache(userId);
        res.json({ success: true, message: "Account deleted" });
    } catch (err) {
        console.error("DELETE ACCOUNT ERROR:", err);
        res.status(500).json({ message: "Failed to delete account" });
    }
};

/* ================= FAMILY MEMBER MANAGEMENT ================= */

export const addFamilyMember = async (req, res) => {
    try {
        const headUserId = req.user.id;
        const { name, relation, dob, gender, email, aadhaar, apartment, street, city, state, pincode, country } = req.body;

        if (!name || !relation || !dob || !gender) {
            return res.status(400).json({ message: "Name, Relation, DOB, and Gender are required" });
        }

        // Single-level only: head cannot itself be a family member
        const { data: isFamily } = await supabaseAdmin
            .from("family_relations")
            .select("id")
            .eq("of_player_id", headUserId)
            .maybeSingle();

        if (isFamily) {
            return res.status(403).json({ message: "Family members cannot add their own family members" });
        }

        // Get head player's mobile
        const { data: headPlayer } = await supabaseAdmin
            .from("users")
            .select("mobile")
            .eq("id", headUserId)
            .maybeSingle();

        if (!headPlayer) return res.status(404).json({ message: "Player not found" });

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

        // Only minors may ride on someone else's mobile. An adult added here
        // would end up sharing the head's number while being independently
        // able to log in by that number, which is exactly the ambiguity the
        // profile chooser resolves by treating the adult as the head.
        const age = calculateAge(dob);
        if (age === null) {
            return res.status(400).json({ message: "Invalid date of birth" });
        }
        if (age > MINOR_AGE_LIMIT) {
            return res.status(400).json({
                message: `Only children aged ${MINOR_AGE_LIMIT} or under can be added to your family. Anyone older needs their own account and mobile number.`
            });
        }

        // Password = bcrypt(DDMMYYYY, 12)
        const [year, month, day] = dob.split("-");
        const plainPassword = `${day}${month}${year}`;
        const password = await bcrypt.hash(plainPassword, 12);

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
                mobile: headPlayer.mobile,
                dob,
                age,
                gender,
                apartment: apartment || null,
                street: street || null,
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

        // Create family relation
        const { error: relError } = await supabaseAdmin
            .from("family_relations")
            .insert({
                head_player_id: headUserId,
                of_player_id: newUserId,
                relation
            });

        if (relError) {
            // Rollback user creation
            await supabaseAdmin.from("users").delete().eq("id", newUserId);
            throw relError;
        }

        // The head's list changed, and so did the new member's own family view.
        await Promise.all([
            invalidateDashboardCache(headUserId),
            invalidateDashboardCache(newUserId),
        ]);
        res.status(201).json({
            success: true,
            familyMember: {
                id: newUser.id,
                name: newUser.name,
                player_id: newUser.player_id,
                relation,
                dob: newUser.dob,
                age: newUser.age,
                gender: newUser.gender,
                email: newUser.email,
                aadhaar: newUser.aadhaar,
                apartment: newUser.apartment,
                street: newUser.street,
                city: newUser.city,
                state: newUser.state,
                pincode: newUser.pincode,
                country: newUser.country
            }
        });
    } catch (err) {
        console.error("ADD FAMILY MEMBER ERROR:", err);
        res.status(500).json({ message: err.message || "Failed to add family member" });
    }
};

export const updateFamilyMember = async (req, res) => {
    try {
        const headUserId = req.user.id;
        const familyMemberId = req.params.id;

        // Verify ownership via family_relations
        const { data: relRecord, error: relError } = await supabaseAdmin
            .from("family_relations")
            .select("id, relation")
            .eq("head_player_id", headUserId)
            .eq("of_player_id", familyMemberId)
            .maybeSingle();

        if (relError || !relRecord) {
            return res.status(403).json({ message: "Not your family member" });
        }

        const { name, relation: newRelation, dob, gender, email, aadhaar, apartment, street, city, state, pincode, country } = req.body;

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

        // Build update object
        const updateData = {};
        if (name !== undefined) {
            updateData.name = name.trim();
            const parts = name.trim().split(/\s+/);
            updateData.first_name = parts[0];
            updateData.last_name = parts.slice(1).join(" ") || "";
        }
        if (dob !== undefined) {
            const age = calculateAge(dob);
            if (age === null) {
                return res.status(400).json({ message: "Invalid date of birth" });
            }
            // The same ceiling as creation. Without it a head could add a child
            // and then edit the DOB to an adult one, producing an adult account
            // on a shared number that add-family-member would have refused.
            if (age > MINOR_AGE_LIMIT) {
                return res.status(400).json({
                    message: `A family member can only be ${MINOR_AGE_LIMIT} or under. Use "Unlink" to give them their own independent account.`
                });
            }
            updateData.dob = dob;
            updateData.age = age;
            // Password changes with DOB
            const [year, month, day] = dob.split("-");
            const plainPassword = `${day}${month}${year}`;
            updateData.password = await bcrypt.hash(plainPassword, 12);
        }
        if (gender !== undefined) updateData.gender = gender;
        if (email !== undefined) updateData.email = email || null;
        if (aadhaar !== undefined) updateData.aadhaar = aadhaar || null;
        if (apartment !== undefined) updateData.apartment = apartment || null;
        if (street !== undefined) updateData.street = street || null;
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

        // Update relation if changed
        if (newRelation && newRelation !== relRecord.relation) {
            await supabaseAdmin
                .from("family_relations")
                .update({ relation: newRelation })
                .eq("id", relRecord.id);
        }

        await Promise.all([
            invalidateDashboardCache(headUserId),
            invalidateDashboardCache(familyMemberId),
        ]);
        res.json({
            success: true,
            familyMember: {
                id: updatedUser.id,
                name: updatedUser.name,
                player_id: updatedUser.player_id,
                relation: newRelation || relRecord.relation,
                dob: updatedUser.dob,
                age: updatedUser.age,
                gender: updatedUser.gender,
                email: updatedUser.email,
                aadhaar: updatedUser.aadhaar,
                apartment: updatedUser.apartment,
                street: updatedUser.street,
                city: updatedUser.city,
                state: updatedUser.state,
                pincode: updatedUser.pincode,
                country: updatedUser.country
            }
        });
    } catch (err) {
        console.error("UPDATE FAMILY MEMBER ERROR:", err);
        res.status(500).json({ message: "Failed to update family member" });
    }
};

export const deleteFamilyMember = async (req, res) => {
    try {
        const headUserId = req.user.id;
        const familyMemberId = req.params.id;
        const { mode } = req.body || {}; // 'full' or 'unlink'

        // Verify ownership
        const { data: relRecord } = await supabaseAdmin
            .from("family_relations")
            .select("id")
            .eq("head_player_id", headUserId)
            .eq("of_player_id", familyMemberId)
            .maybeSingle();

        if (!relRecord) {
            return res.status(403).json({ message: "Not your family member" });
        }

        // Delete the relation
        await supabaseAdmin.from("family_relations").delete().eq("id", relRecord.id);

        if (mode === 'full') {
            // Delete the user entirely
            await supabaseAdmin.from("users").delete().eq("id", familyMemberId);
            await invalidateDashboardCache(headUserId);
            res.json({ success: true, message: "Family member removed and account deleted" });
        } else {
            // Unlink — clear mobile so they operate independently. Their only
            // remaining sign-in routes are Player ID, email or aadhaar, so the
            // client warns before choosing this for a child with no email.
            await supabaseAdmin.from("users").update({ mobile: null }).eq("id", familyMemberId);
            await Promise.all([
                invalidateDashboardCache(headUserId),
                invalidateDashboardCache(familyMemberId),
            ]);
            res.json({ success: true, message: "Family member unlinked. They can now operate independently." });
        }
    } catch (err) {
        console.error("DELETE FAMILY MEMBER ERROR:", err);
        res.status(500).json({ message: "Failed to delete family member" });
    }
};
