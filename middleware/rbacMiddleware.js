import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabaseClient.js";

dotenv.config();

// --------------------------------------------------------------------------
// 1. Verify Admin (Supabase Auth)
//    - Expects 'Authorization: Bearer <supabase_token>'
//    - Verifies token with Supabase
//    - Checks if users table has role = 'admin'
// --------------------------------------------------------------------------
export const verifyAdmin = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Missing admin token" });
        }

        const token = authHeader.split(" ")[1];

        // A. Verify with Supabase Auth
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

        if (error || !user) {
            return res.status(401).json({ error: "Invalid admin token" });
        }

        // B. Check Role in Public Users Table
        // We use 'id' from auth.users which should match public.users.id
        const { data: profile } = await supabaseAdmin
            .from("users")
            .select("role")
            .eq("id", user.id)
            .single();

        if (!profile || (profile.role !== 'admin' && profile.role !== 'superadmin')) {
            return res.status(403).json({ error: "Access denied: Admins only" });
        }

        // Attach role to req.user for use in routes
        req.user = { ...user, role: profile.role };
        next();
    } catch (err) {
        console.error("ADMIN AUTH ERROR:", err.message);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};

// --------------------------------------------------------------------------
// 2. Verify Player (Custom JWT)
//    - Expects 'Authorization: Bearer <jwt_token>'
//    - Verifies using process.env.JWT_SECRET
//    - Checks if payload role == 'player'
// --------------------------------------------------------------------------
export const verifyPlayer = (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Missing player token" });
        }

        const token = authHeader.split(" ")[1];

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Enforce Strict Role Check
        if (!decoded.role || decoded.role !== 'player') {
            console.warn(`Access denied: User ${decoded.id} with role ${decoded.role} tried to access player route.`);
            return res.status(403).json({ error: "Access denied: Restricted to Players only." });
        }

        req.user = decoded; // Attach decoded payload
        next();
    } catch (err) {
        // Distinguish between expired vs invalid
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: "Session expired. Please login again." });
        }
        console.error("PLAYER AUTH ERROR:", err.message);
        return res.status(403).json({ error: "Invalid authentication token." });
    }
};
