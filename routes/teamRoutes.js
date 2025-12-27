import express from 'express';
import { supabaseAdmin } from '../config/supabaseClient.js';
import { authenticateUser as verifyToken } from '../middleware/authMiddleware.js';

const router = express.Router();

// Get My Teams
router.get('/my-teams', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;

        const { data, error } = await supabaseAdmin
            .from('player_teams')
            .select('*')
            .eq('captain_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({ success: true, teams: data });
    } catch (err) {
        console.error("Get Teams Error:", err);
        res.status(500).json({ message: "Failed to fetch teams" });
    }
});

// Lookup Player by ID (for Team Creation)
router.get('/player-lookup/:playerId', verifyToken, async (req, res) => {
    try {
        const { playerId } = req.params;

        // Case-insensitive lookup on player_id
        const { data: player, error } = await supabaseAdmin
            .from('users')
            .select('id, first_name, last_name, dob, mobile, player_id, aadhaar')
            .ilike('player_id', playerId) // Using ilike for case-insensitivity if needed, or eq
            .single();

        if (error || !player) {
            return res.status(404).json({ success: false, message: "Player ID not found" });
        }

        // Calculate Age from DOB
        let age = "";
        if (player.dob) {
            // Check if DOB is YYYY-MM-DD or DD MMM YYYY. 
            // supabaseAdmin usually returns standard format if date column.
            const dobDate = new Date(player.dob);
            if (!isNaN(dobDate.getTime())) {
                const diffMs = Date.now() - dobDate.getTime();
                const ageDt = new Date(diffMs);
                age = Math.abs(ageDt.getUTCFullYear() - 1970).toString();
            }
        }

        res.json({
            success: true,
            player: {
                id: player.id, // Internal UUID
                player_id: player.player_id, // Display ID
                name: `${player.first_name} ${player.last_name}`,
                age: age,
                mobile: player.mobile,
                aadhaar: player.aadhaar
            }
        });

    } catch (err) {
        console.error("Player Lookup Error:", err);
        res.status(500).json({ success: false, message: "Lookup failed" });
    }
});

// Create New Team
router.post('/create', verifyToken, async (req, res) => {
    try {
        const { team_name, sport, members } = req.body;
        const userId = req.user.id;

        // Fetch captain details (name/mobile)
        let captainName = "Unknown";
        let captainMobile = "";

        // Determine table for profile (profiles or users?)
        // authRoutes uses 'users' table mainly. But teamRoutes used 'profiles'.
        // Let's assume 'profiles' exists or use 'users' if that's the standard.
        // I'll stick to 'profiles' as originally written but use supabaseAdmin.
        // If 'profiles' doesn't exist, this might fail, but I must fix the syntax error first.
        // Actually authRoutes uses "from('users')". I should probably check if profiles exists.
        // But for now, fixing the Syntax Error is priority. I'll transform the syntax.

        const { data: profile, error: profileError } = await supabaseAdmin
            .from('users')
            .select('first_name, last_name, mobile')
            .eq('id', userId)
            .single();

        if (profile) {
            captainName = `${profile.first_name} ${profile.last_name}`.trim();
            captainMobile = profile.mobile;
        }

        const { data, error } = await supabaseAdmin
            .from('player_teams')
            .insert([
                {
                    team_name,
                    sport,
                    captain_id: userId,
                    captain_name: captainName,
                    captain_mobile: captainMobile,
                    members: members || []
                }
            ])
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, team: data });
    } catch (err) {
        console.error("Create Team Error:", err);
        res.status(500).json({ message: "Failed to create team" });
    }
});

// Update Team
router.put('/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { team_name, sport, members } = req.body;
        const userId = req.user.id;

        // 1. Verify Ownership
        const { data: team, error: fetchError } = await supabaseAdmin
            .from('player_teams')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchError || !team) {
            return res.status(404).json({ message: "Team not found" });
        }

        if (team.captain_id !== userId) {
            return res.status(403).json({ message: "You are not authorized to edit this team" });
        }

        // 2. Update Team
        const { data: updatedTeam, error: updateError } = await supabaseAdmin
            .from('player_teams')
            .update({
                team_name,
                sport,
                members: members || []
            })
            .eq('id', id)
            .select()
            .single();

        if (updateError) throw updateError;

        res.json({ success: true, team: updatedTeam });
    } catch (err) {
        console.error("Update Team Error:", err);
        res.status(500).json({ message: "Failed to update team" });
    }
});



// Delete Team
router.delete('/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        // 1. Verify Ownership
        const { data: team, error: fetchError } = await supabaseAdmin
            .from('player_teams')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchError || !team) {
            return res.status(404).json({ message: "Team not found" });
        }

        if (team.captain_id !== userId) {
            return res.status(403).json({ message: "You are not authorized to delete this team" });
        }

        // 2. Delete Team
        const { error: deleteError } = await supabaseAdmin
            .from('player_teams')
            .delete()
            .eq('id', id);

        if (deleteError) throw deleteError;

        res.json({ success: true, message: "Team deleted successfully" });
    } catch (err) {
        console.error("Delete Team Error:", err);
        res.status(500).json({ message: "Failed to delete team" });
    }
});

export default router;
