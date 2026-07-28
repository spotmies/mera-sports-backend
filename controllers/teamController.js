import { supabaseAdmin } from "../config/supabaseClient.js";
import { createNotification } from "../services/notificationService.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === "string" && UUID_RE.test(value.trim());

/**
 * A usable mobile number, i.e. one we could actually match a user row on.
 *
 * `lookupPlayer` masks what it returns ("XXXXXX5123"), and the client stores
 * "N/A" when a player has no number on file. Both come straight back to us in
 * the create/update payload, so filtering here keeps junk out of the lookup.
 */
const isRealMobile = (value) => typeof value === "string" && /^\d{10,15}$/.test(value.trim());

/**
 * Batch-resolve member user UUIDs and send "added to team" notifications.
 *
 * One indexed `IN` query per identifier type, run in parallel. This used to be
 * a single `.or()` combining all three — but that made the whole lookup
 * all-or-nothing: one member carrying a non-UUID `id` (legacy rows stored the
 * player code there) made Postgres reject the entire filter, `resolveMemberUserIds`
 * returned an empty map, and *nobody* on the team got notified. Splitting the
 * query means a bad value can only cost us the column it appears in.
 */
async function resolveMemberUserIds(members) {
    if (!Array.isArray(members) || members.length === 0) return new Map();

    const knownIds = new Set();
    const playerIds = new Set();
    const mobiles = new Set();

    for (const m of members) {
        if (isUuid(m?.id)) knownIds.add(m.id.trim());
        const playerId = String(m?.player_id ?? "").trim();
        if (playerId) {
            // player_id casing is inconsistent across older rows, and `.in()`
            // cannot case-fold server-side, so ask for both forms.
            playerIds.add(playerId);
            playerIds.add(playerId.toUpperCase());
        }
        if (isRealMobile(m?.mobile)) mobiles.add(m.mobile.trim());
    }

    const lookupBy = async (column, values) => {
        if (values.size === 0) return [];
        const { data, error } = await supabaseAdmin
            .from('users')
            .select('id, player_id, mobile')
            .in(column, Array.from(values));
        if (error) {
            console.error(`[resolveMemberUserIds] lookup by ${column} failed:`, error);
            return [];
        }
        return data || [];
    };

    const [byIdRows, byPlayerIdRows, byMobileRows] = await Promise.all([
        lookupBy('id', knownIds),
        lookupBy('player_id', playerIds),
        lookupBy('mobile', mobiles),
    ]);

    // Build lookup maps for fast resolution
    const byId = new Map();
    const byPlayerId = new Map();
    const byMobile = new Map();
    for (const u of [...byIdRows, ...byPlayerIdRows, ...byMobileRows]) {
        if (u.id) byId.set(String(u.id), u.id);
        if (u.player_id) byPlayerId.set(String(u.player_id).toUpperCase(), u.id);
        if (u.mobile) byMobile.set(String(u.mobile), u.id);
    }

    // Resolve each member to a user UUID
    const resolved = new Map();
    for (const m of members) {
        const key = m?.id || m?.player_id || m?.mobile;
        if (!key) continue;
        const playerId = String(m?.player_id ?? "").trim().toUpperCase();
        const userId = (m?.id && byId.get(String(m.id)))
            || (playerId && byPlayerId.get(playerId))
            || (m?.mobile && byMobile.get(String(m.mobile)))
            || null;
        if (userId) resolved.set(key, userId);
    }
    return resolved;
}

async function notifyTeamMembers(members, teamName, captainName) {
    if (!Array.isArray(members) || members.length === 0) return;

    try {
        const resolvedIds = await resolveMemberUserIds(members);

        const notificationPromises = [];
        const unresolved = [];
        for (const member of members) {
            const key = member.id || member.player_id || member.mobile;
            const userId = key ? resolvedIds.get(key) : null;
            if (userId) {
                notificationPromises.push(
                    createNotification(
                        userId,
                        'Added to Team',
                        `${captainName} added you to the team "${teamName}".`,
                        'info',
                        // Deep-links the bell straight to the Teams tab, where the
                        // team now shows up under "Teams You're In".
                        '/dashboard?tab=teams'
                    )
                );
            } else {
                unresolved.push(member?.player_id || member?.id || '(unidentified)');
            }
        }

        // A member who cannot be resolved to a user row gets no notification and
        // no error — worth a line in the log, since from the captain's side the
        // add looks like it worked.
        if (unresolved.length > 0) {
            console.warn(`[notifyTeamMembers] "${teamName}": no user row for ${unresolved.join(', ')} — not notified`);
        }

        const results = await Promise.allSettled(notificationPromises);
        results.forEach((r, i) => {
            if (r.status === 'rejected') {
                console.error(`Team notification ${i} failed:`, r.reason);
            }
        });
    } catch (e) {
        console.error('notifyTeamMembers error:', e);
    }
}

export const getMyTeams = async (req, res) => {
    try {
        const userId = req.user.id;

        // 1. Teams where user is captain
        const { data: captainTeams, error } = await supabaseAdmin.from('player_teams').select('*').eq('captain_id', userId).order('created_at', { ascending: false });
        if (error) throw error;

        // 2. Teams where user is a member (lookup by UUID, mobile, or player_id)
        const { data: player } = await supabaseAdmin.from('users').select('mobile, player_id').eq('id', userId).maybeSingle();

        // JSONB containment pushes the member match into Postgres. The previous
        // version pulled *every* team row in the table back and filtered them in
        // memory, which silently truncated at PostgREST's default row cap — past
        // that point a player simply stopped seeing teams they'd been added to.
        // `@>` matches on a partial object, so {id} alone matches the full
        // stored member object.
        const membershipProbes = [{ id: userId }];
        if (player?.player_id) membershipProbes.push({ player_id: player.player_id });
        if (player?.mobile) membershipProbes.push({ mobile: player.mobile });

        const memberTeamResults = await Promise.all(
            membershipProbes.map(async (probe) => {
                const { data, error: probeError } = await supabaseAdmin
                    .from('player_teams')
                    .select('*')
                    .neq('captain_id', userId)
                    // Must be a pre-stringified JSON array: given a JS array,
                    // supabase-js builds a Postgres *array* literal
                    // (`cs.{[object Object]}`) instead of a jsonb one.
                    .contains('members', JSON.stringify([probe]))
                    .order('created_at', { ascending: false });
                if (probeError) {
                    console.error('[getMyTeams] membership probe failed:', probe, probeError);
                    return [];
                }
                return data || [];
            })
        );

        const captainTeamIds = new Set((captainTeams || []).map(t => t.id));
        const seenMemberTeamIds = new Set();
        const memberTeams = [];
        for (const team of memberTeamResults.flat()) {
            if (captainTeamIds.has(team.id) || seenMemberTeamIds.has(team.id)) continue;
            seenMemberTeamIds.add(team.id);
            memberTeams.push(team);
        }
        memberTeams.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        // Mark each team with the user's role
        const ownTeams = (captainTeams || []).map(t => ({ ...t, user_role: 'captain' }));
        const addedTeams = memberTeams.map(t => ({ ...t, user_role: 'member' }));

        res.json({ success: true, teams: ownTeams, teams_added_you: addedTeams });
    } catch (err) {
        console.error("Get Teams Error:", err);
        res.status(500).json({ message: "Failed to fetch teams" });
    }
};

/** Last 4 digits only, e.g. 9492085123 -> XXXXXX5123. */
const maskTail = (value, visible = 4, groupWith = "") => {
    const digits = String(value ?? "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.length <= visible) return digits;
    const masked = "X".repeat(digits.length - visible) + digits.slice(-visible);
    if (!groupWith) return masked;
    return masked.replace(/(.{4})(?=.)/g, `$1${groupWith}`);
};

/**
 * Look up a player by their public player id, so a captain can add them to a
 * team.
 *
 * Mobile and Aadhaar are masked. This endpoint is reachable by any logged-in
 * user for any player id, and player ids are sequential (P1770, P1771, …), so
 * returning them in full let one account walk the range and harvest every
 * player's phone number and Aadhaar. The captain only needs enough to confirm
 * they picked the right person — the name and age do that.
 *
 * Masking here rather than in the UI is deliberate: the values must not reach
 * the browser at all. Callers that need to act on the member (notifications,
 * registration) resolve them by `id` / `player_id`, both still returned.
 */
export const lookupPlayer = async (req, res) => {
    try {
        const { playerId } = req.params;
        const { data: player, error } = await supabaseAdmin.from('users').select('id, first_name, last_name, dob, mobile, player_id, aadhaar').ilike('player_id', playerId).maybeSingle();
        if (error || !player) return res.status(404).json({ success: false, message: "Player ID not found" });

        let age = "";
        if (player.dob) {
            const ageDt = new Date(Date.now() - new Date(player.dob).getTime());
            age = Math.abs(ageDt.getUTCFullYear() - 1970).toString();
        }

        res.json({
            success: true,
            player: {
                id: player.id,
                player_id: player.player_id,
                name: `${player.first_name} ${player.last_name}`,
                age,
                mobile: maskTail(player.mobile),
                aadhaar: maskTail(player.aadhaar, 4, "-"),
            }
        });
    } catch (err) {
        console.error("Player Lookup Error:", err);
        res.status(500).json({ success: false, message: "Lookup failed" });
    }
};

export const createTeam = async (req, res) => {
    try {
        const { team_name, sport, members } = req.body;
        const userId = req.user.id;

        const { data: profile } = await supabaseAdmin.from('users').select('first_name, last_name, mobile').eq('id', userId).maybeSingle();
        const captainName = profile ? `${profile.first_name} ${profile.last_name}`.trim() : "Unknown";
        const captainMobile = profile?.mobile || "";

        const { data, error } = await supabaseAdmin.from('player_teams').insert([{ team_name, sport, captain_id: userId, captain_name: captainName, captain_mobile: captainMobile, members: members || [] }]).select().maybeSingle();
        if (error) throw error;

        // Notify team members (async, non-blocking)
        notifyTeamMembers(members, team_name, captainName).catch(e => console.error('Notify members error:', e));

        res.json({ success: true, team: data });
    } catch (err) {
        console.error("Create Team Error:", err);
        res.status(500).json({ message: "Failed to create team" });
    }
};

export const updateTeam = async (req, res) => {
    try {
        const { id } = req.params;
        const { team_name, sport, members } = req.body;
        const userId = req.user.id;

        const { data: team, error: fetchError } = await supabaseAdmin.from('player_teams').select('*').eq('id', id).maybeSingle();
        if (fetchError || !team) return res.status(404).json({ message: "Team not found" });
        if (team.captain_id !== userId) return res.status(403).json({ message: "Unauthorized" });

        const { data: updatedTeam, error } = await supabaseAdmin.from('player_teams').update({ team_name, sport, members: members || [] }).eq('id', id).select().maybeSingle();
        if (error) throw error;

        // Find newly added members and notify them
        const oldMemberIds = new Set((team.members || []).map(m => m.id || m.player_id || m.mobile));
        const newMembers = (members || []).filter(m => {
            const key = m.id || m.player_id || m.mobile;
            return key && !oldMemberIds.has(key);
        });
        if (newMembers.length > 0) {
            const captainName = team.captain_name || 'Your captain';
            notifyTeamMembers(newMembers, team_name || team.team_name, captainName).catch(e => console.error('Notify members error:', e));
        }

        res.json({ success: true, team: updatedTeam });
    } catch (err) {
        console.error("Update Team Error:", err);
        res.status(500).json({ message: "Failed to update team" });
    }
};

export const deleteTeam = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const { data: team, error: fetchError } = await supabaseAdmin.from('player_teams').select('*').eq('id', id).maybeSingle();
        if (fetchError || !team) return res.status(404).json({ message: "Team not found" });
        if (team.captain_id !== userId) return res.status(403).json({ message: "Unauthorized" });

        // Block deletion if team has active event registrations
        const activeStatuses = [
            'pending_verification', 'payment_pending', 'registered',
            'pending', 'Submitted', 'confirmed', 'verified', 'approved', 'paid'
        ];
        const { data: activeRegs } = await supabaseAdmin
            .from('event_registrations')
            .select('id')
            .eq('team_id', id)
            .in('status', activeStatuses)
            .limit(1);

        if (activeRegs?.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete team while it is registered for an active event.'
            });
        }

        const { error } = await supabaseAdmin.from('player_teams').delete().eq('id', id);
        if (error) throw error;
        res.json({ success: true, message: "Team deleted successfully" });
    } catch (err) {
        console.error("Delete Team Error:", err);
        res.status(500).json({ message: "Failed to delete team" });
    }
};
