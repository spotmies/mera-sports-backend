import { supabaseAdmin } from "../config/supabaseClient.js";
import { createNotification } from "../services/notificationService.js";

/**
 * Batch-resolve member user UUIDs and send "added to team" notifications.
 * Uses a single prefetch query instead of sequential per-member lookups.
 */
async function resolveMemberUserIds(members) {
    if (!Array.isArray(members) || members.length === 0) return new Map();

    // Collect all known UUIDs, player_ids, and mobiles
    const knownIds = [];
    const playerIds = [];
    const mobiles = [];
    for (const m of members) {
        if (m.id) knownIds.push(m.id);
        if (m.player_id) playerIds.push(m.player_id.toUpperCase());
        if (m.mobile) mobiles.push(m.mobile);
    }

    // Batch fetch all matching users in a single query
    const orFilters = [];
    if (knownIds.length > 0) orFilters.push(`id.in.(${knownIds.join(',')})`);
    if (playerIds.length > 0) orFilters.push(`player_id.in.(${playerIds.join(',')})`);
    if (mobiles.length > 0) orFilters.push(`mobile.in.(${mobiles.join(',')})`);

    if (orFilters.length === 0) return new Map();

    const { data: users, error } = await supabaseAdmin
        .from('users')
        .select('id, player_id, mobile')
        .or(orFilters.join(','));

    if (error) {
        console.error('Batch user lookup error:', error);
        return new Map();
    }

    // Build lookup maps for fast resolution
    const byId = new Map();
    const byPlayerId = new Map();
    const byMobile = new Map();
    for (const u of (users || [])) {
        if (u.id) byId.set(u.id, u.id);
        if (u.player_id) byPlayerId.set(u.player_id.toUpperCase(), u.id);
        if (u.mobile) byMobile.set(u.mobile, u.id);
    }

    // Resolve each member to a user UUID
    const resolved = new Map();
    for (const m of members) {
        const key = m.id || m.player_id || m.mobile;
        const userId = (m.id && byId.get(m.id))
            || (m.player_id && byPlayerId.get(m.player_id.toUpperCase()))
            || (m.mobile && byMobile.get(m.mobile))
            || null;
        if (userId && key) resolved.set(key, userId);
    }
    return resolved;
}

async function notifyTeamMembers(members, teamName, captainName) {
    if (!Array.isArray(members) || members.length === 0) return;

    try {
        const resolvedIds = await resolveMemberUserIds(members);

        const notificationPromises = [];
        for (const member of members) {
            const key = member.id || member.player_id || member.mobile;
            const userId = key ? resolvedIds.get(key) : null;
            if (userId) {
                notificationPromises.push(
                    createNotification(
                        userId,
                        'Added to Team',
                        `${captainName} added you to the team "${teamName}".`,
                        'info'
                    )
                );
            }
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

        const { data: allTeams } = await supabaseAdmin.from('player_teams').select('*').neq('captain_id', userId).order('created_at', { ascending: false });

        const captainTeamIds = new Set((captainTeams || []).map(t => t.id));
        const memberTeams = (allTeams || []).filter(team => {
            if (captainTeamIds.has(team.id)) return false;
            return Array.isArray(team.members) && team.members.some(m =>
                m.id === userId ||
                (player?.mobile && m.mobile === player.mobile) ||
                (player?.player_id && m.player_id === player.player_id)
            );
        });

        // Mark each team with the user's role
        const ownTeams = (captainTeams || []).map(t => ({ ...t, user_role: 'captain' }));
        const addedTeams = memberTeams.map(t => ({ ...t, user_role: 'member' }));

        res.json({ success: true, teams: ownTeams, teams_added_you: addedTeams });
    } catch (err) {
        console.error("Get Teams Error:", err);
        res.status(500).json({ message: "Failed to fetch teams" });
    }
};

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
                age, mobile: player.mobile, aadhaar: player.aadhaar
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
