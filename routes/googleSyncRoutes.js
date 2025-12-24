import dotenv from "dotenv";
import express from "express";
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabaseClient.js";

dotenv.config();

const router = express.Router();

router.get('/google-url', (req, res) => {
    const supabaseUrl = process.env.SUPABASE_URL;
    // The redirect_to should point to your ADMIN Frontend Login page
    // Using 8080 as default for Admin Hub based on vite.config.ts
    const frontendUrl = process.env.ADMIN_FRONTEND_URL || 'http://localhost:8080';
    const redirectUrl = `${supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${frontendUrl}/login`;

    res.json({ url: redirectUrl });
});

router.post('/sync', async (req, res) => {
    try {
        // 1. Verify the token sent from Frontend
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'No token provided' });

        const token = authHeader.split(' ')[1];

        // Get the user details from Supabase Auth (using the token)
        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

        if (authError || !user) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        // 2. CHECK IF USER ALREADY EXISTS
        const { data: existingUser } = await supabaseAdmin
            .from('users')
            .select('*')
            .eq('id', user.id)
            .single();

        // Robust Name Parsing
        const meta = user.user_metadata || {};
        const fullName = meta.full_name || meta.name || 'Admin User';

        let firstName = meta.given_name || meta.first_name || meta.name;
        let lastName = meta.family_name || meta.last_name || '';

        if (!lastName && fullName.includes(' ')) {
            const parts = fullName.trim().split(' ');
            firstName = parts[0];
            lastName = parts.slice(1).join(' ');
        }

        const googleId = user.identities?.find(id => id.provider === 'google')?.id || null;
        const photoUrl = meta.avatar_url || meta.picture || '';

        let finalUser;

        if (existingUser) {
            // UPDATE ONLY GOOGLE FIELDS (Preserve Mobile/DOB)
            const { data: updatedUser, error: updateError } = await supabaseAdmin
                .from('users')
                .update({
                    first_name: firstName,
                    last_name: lastName,
                    name: fullName,
                    photos: photoUrl,
                    avatar: photoUrl,
                    google_id: googleId
                })
                .eq('id', user.id)
                .select()
                .single();

            if (updateError) {
                console.error("Error updating existing admin:", updateError);
                // If update fails, fallback to existing data but STILL generate token
                finalUser = existingUser;
            } else {
                finalUser = updatedUser;
            }
        } else {
            // 3. IF NEW USER, CREATE WITH DUMMY DATA
            const userData = {
                id: user.id,
                email: user.email,
                first_name: firstName,
                last_name: lastName,
                name: fullName,
                photos: photoUrl,
                avatar: photoUrl,
                google_id: googleId,
                role: 'admin',
                verification: 'verified', // Admins are auto-verified via Google

                // ROBUST DUMMY DATA STRATEGY
                mobile: `9${Date.now().toString().slice(-9)}`,
                dob: '2000-01-01',
                age: 25,
                aadhaar: `ADM-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 1000)}`,
                apartment: 'Admin HQ',
                street: 'Admin St',
                city: 'Cloud City',
                state: 'Web',
                pincode: '000000',
                country: 'India',
                password: 'GOOGLE_AUTH_ADMIN',
                player_id: `ADM-${Date.now().toString().slice(-6)}`
            };

            // 3. Upsert into public.users
            const { data: savedUser, error: dbError } = await supabaseAdmin
                .from('users')
                .upsert(userData, { onConflict: 'id' })
                .select() // Important to return the row
                .single();

            if (dbError) {
                console.error('CRITICAL DATABASE ERROR:', dbError);
                return res.status(500).json({ error: 'Failed to save user', details: dbError });
            }
            console.log("✅ Admin Sync Saved Successfully:", savedUser.id);
            finalUser = savedUser;
        }

        // 4. Generate Backend Token (consistent with login-admin)
        const backendToken = jwt.sign(
            { id: finalUser.id, role: finalUser.role },
            process.env.JWT_SECRET,
            { expiresIn: "12h" }
        );

        // 5. Return the user data AND token to frontend
        res.json({ success: true, user: finalUser, token: backendToken });

    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;