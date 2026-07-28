import bcrypt from "bcryptjs";
import crypto from "crypto";
import dotenv from "dotenv";
import express from "express";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { supabaseAdmin } from "../config/supabaseClient.js";

dotenv.config({ quiet: true });

const router = express.Router();

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * Verify a Google ID token (from Google Identity Services on the frontend)
 * and return its payload. Throws on any verification failure.
 * Replaces the old Supabase-hosted OAuth + supabaseAdmin.auth.getUser flow.
 */
export async function verifyGoogleIdToken(idToken) {
    const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
    });
    return ticket.getPayload(); // { sub, email, email_verified, name, given_name, family_name, picture }
}

router.post('/sync', async (req, res) => {
    try {
        // 1. Verify the Google ID token sent from Frontend
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'No token provided' });

        const token = authHeader.split(' ')[1];

        let payload;
        try {
            payload = await verifyGoogleIdToken(token);
        } catch (e) {
            console.error("Google token verification failed:", e.message);
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (!payload?.email || payload.email_verified === false) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        // 2. CHECK IF USER ALREADY EXISTS (by email — IDs are our own UUIDs now)
        const { data: existingUser, error: lookupError } = await supabaseAdmin
            .from('users')
            .select('*')
            .eq('email', payload.email)
            .maybeSingle();

        // This error used to be discarded. An unreachable database therefore
        // looked identical to "no such user", so a returning admin fell straight
        // into the new-user branch below — which then failed its INSERT and
        // returned 500. Worse, had the write succeeded where the read did not,
        // it would have silently created a duplicate account for an existing
        // admin. Bail out instead: 503 tells the client to retry, not to
        // re-register.
        if (lookupError) {
            console.error('Google sync: user lookup failed:', lookupError);
            return res.status(503).json({ error: 'Database unavailable, please retry' });
        }

        // Robust Name Parsing
        const fullName = payload.name || 'Admin User';
        let firstName = payload.given_name || fullName;
        let lastName = payload.family_name || '';
        if (!lastName && fullName.includes(' ')) {
            const parts = fullName.trim().split(' ');
            firstName = parts[0];
            lastName = parts.slice(1).join(' ');
        }

        const googleId = payload.sub || null;
        const photoUrl = payload.picture || '';

        let finalUser;

        if (existingUser) {
            // STRICT SEPARATION: If email belongs to a PLAYER, block Admin access
            if (existingUser.role === 'player') {
                return res.status(403).json({
                    error: "This email is registered as a Player. To access Admin, please use a different email."
                });
            }

            const previous_login = existingUser.last_login || null;
            const last_login = new Date().toISOString();

            // UPDATE ONLY GOOGLE FIELDS (Preserve Mobile/DOB and ROLE)
            const { data: updatedUser, error: updateError } = await supabaseAdmin
                .from('users')
                .update({
                    first_name: firstName,
                    last_name: lastName,
                    name: fullName,
                    photos: photoUrl,
                    avatar: photoUrl,
                    google_id: googleId,
                    previous_login,
                    last_login
                    // role never overwritten
                })
                .eq('id', existingUser.id)
                .select()
                .single();

            if (updateError) {
                console.error("Error updating existing admin:", updateError);
                finalUser = existingUser;
            } else {
                finalUser = updatedUser;
            }
        } else {
            // 3. IF NEW USER, CREATE WITH DUMMY DATA
            // Random per-account sentinel so the password is never guessable.
            const oauthSentinel = crypto.randomBytes(32).toString("hex");
            const hashedOAuthSentinel = await bcrypt.hash(oauthSentinel, 12);
            const userData = {
                id: crypto.randomUUID(), // our own UUID (no Supabase Auth uid anymore)
                email: payload.email,
                first_name: firstName,
                last_name: lastName,
                name: fullName,
                photos: photoUrl,
                avatar: photoUrl,
                google_id: googleId,
                role: 'admin', // ONLY set for NEW users
                verification: 'pending', // Pending SuperAdmin approval
                last_login: new Date().toISOString(),

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
                password: hashedOAuthSentinel,
                player_id: `ADM-${Date.now().toString().slice(-6)}`
            };

            const { data: savedUser, error: dbError } = await supabaseAdmin
                .from('users')
                .upsert(userData, { onConflict: 'id' })
                .select()
                .single();

            if (dbError) {
                console.error('CRITICAL DATABASE ERROR:', dbError);
                return res.status(500).json({ error: 'Failed to save user', details: dbError });
            }
            finalUser = savedUser;
        }

        // 4. VERIFICATION CHECK — Block only rejected admins.
        if (finalUser.role === 'admin' && finalUser.verification === 'rejected') {
            return res.status(403).json({
                error: "Your admin application has been rejected.",
                code: "ADMIN_REJECTED"
            });
        }

        // 5. Generate Backend Token (consistent with login-admin)
        const backendToken = jwt.sign(
            { id: finalUser.id, role: finalUser.role },
            process.env.JWT_SECRET,
            { expiresIn: "30d" }
        );

        // 6. Return the user data AND token to frontend
        const userPayload = {
            id: finalUser.id,
            name: finalUser.name,
            email: finalUser.email,
            role: finalUser.role,
            avatar: finalUser.photos || finalUser.avatar,
            verification: finalUser.verification,
            last_login: finalUser.last_login,
            previous_login: finalUser.previous_login
        };
        res.json({ success: true, user: userPayload, token: backendToken });

    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
