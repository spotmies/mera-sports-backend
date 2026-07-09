import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { getPublicEventId } from "../utils/eventResolver.js";
import { getNextPlayerId } from "../utils/playerIdHelper.js";
import { uploadBase64 } from "../utils/uploadHelper.js";

// GET /api/player/dashboard
export const getPlayerDashboard = async (req, res) => {
    try {
        const userId = req.user.id;
        const { data: player, error } = await supabaseAdmin.from("users").select("*").eq("id", userId).maybeSingle();
        if (error) throw error;
        if (!player) return res.status(404).json({ message: "Player not found" });

        const { data: schoolDetails } = await supabaseAdmin.from("player_school_details").select("*").eq("player_id", userId).maybeSingle();
        if (schoolDetails) player.schoolDetails = schoolDetails;

        // Fetch Teams
        let relevantTeamIds = [];
        let captainTeamIdSet = new Set();
        const { data: captainTeams } = await supabaseAdmin.from("player_teams").select("id").eq("captain_id", userId);
        if (captainTeams) {
            captainTeams.forEach(t => { relevantTeamIds.push(t.id); captainTeamIdSet.add(t.id); });
        }

        // Check membership by mobile
        if (player.mobile) {
            const { data: memberTeams } = await supabaseAdmin.from("player_teams").select("id").contains("members", [{ mobile: player.mobile }]);
            if (memberTeams) relevantTeamIds.push(...memberTeams.map(t => t.id));
        }

        // Check membership by player_id string or user UUID in members array
        {
            const { data: allTeams } = await supabaseAdmin.from("player_teams").select("id, members");
            if (allTeams) {
                allTeams.forEach(team => {
                    if (Array.isArray(team.members) && team.members.some(m =>
                        m.id === userId ||
                        (player.player_id && m.player_id === player.player_id)
                    )) {
                        relevantTeamIds.push(team.id);
                    }
                });
            }
        }
        relevantTeamIds = [...new Set(relevantTeamIds)];

        // Fetch Registrations
        let query = supabaseAdmin.from("event_registrations").select(`*, events ( id, public_id, name, sport, start_date, location )`).order('created_at', { ascending: false });
        if (relevantTeamIds.length > 0) {
            query = query.or(`player_id.eq.${userId},team_id.in.(${relevantTeamIds.join(',')})`);
        } else {
            query = query.eq("player_id", userId);
        }
        const { data: registrations } = await query;

        // Fetch Transactions
        const { data: transactions } = await supabaseAdmin.from("transactions").select("*").eq("user_id", userId);

        // Merge Details
        const detailedRegistrations = await Promise.all((registrations || []).map(async (reg) => {
            const txn = (transactions || []).find(t => (reg.transaction_id && t.id === reg.transaction_id) || (t.event_id === reg.event_id));
            let teamDetails = null;
            let isTeamMember = false;
            let isCaptain = false;
            if (reg.team_id) {
                const { data: team } = await supabaseAdmin.from("player_teams").select("*").eq("id", reg.team_id).maybeSingle();
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
        }));

        res.json({
            success: true,
            player,
            registrations: detailedRegistrations
        });

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
        const { data: currentUser } = await supabaseAdmin.from("users").select("age").eq("id", userId).maybeSingle();
        const allowSharedMobile = Number(currentUser?.age) <= 15;

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
        const { email, mobile, photos, apartment, street, city, state, pincode, country, gender } = req.body;

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
            const allowSharedMobile = Number(currentUser.age) <= 15;
            if (data && !allowSharedMobile) return res.status(409).json({ message: "Mobile taken" });
        }

        let photoUrl = photos;
        if (photos && photos.startsWith('data:')) {
            photoUrl = await uploadBase64(photos, 'player-photos');
        }

        const updates = {
            email: email || currentUser.email,
            mobile: mobile || currentUser.mobile,
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

        res.json({ success: true, player: updatedPlayer?.[0] || updates, message: "Profile updated" });

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

        // Calculate age from DOB
        const birth = new Date(dob);
        const today = new Date();
        let age = today.getFullYear() - birth.getFullYear();
        const m = today.getMonth() - birth.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;

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

        res.json({
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

        // Build update object
        const updateData = {};
        if (name !== undefined) {
            updateData.name = name.trim();
            const parts = name.trim().split(/\s+/);
            updateData.first_name = parts[0];
            updateData.last_name = parts.slice(1).join(" ") || "";
        }
        if (dob !== undefined) {
            updateData.dob = dob;
            const birth = new Date(dob);
            const today = new Date();
            let age = today.getFullYear() - birth.getFullYear();
            const m = today.getMonth() - birth.getMonth();
            if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
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
            res.json({ success: true, message: "Family member removed and account deleted" });
        } else {
            // Unlink — clear mobile so they operate independently
            await supabaseAdmin.from("users").update({ mobile: null }).eq("id", familyMemberId);
            res.json({ success: true, message: "Family member unlinked. They can now operate independently." });
        }
    } catch (err) {
        console.error("DELETE FAMILY MEMBER ERROR:", err);
        res.status(500).json({ message: "Failed to delete family member" });
    }
};
