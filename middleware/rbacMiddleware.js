import dotenv from "dotenv";
import jwt from "jsonwebtoken";

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

        // VERIFY BACKEND JWT (Not Supabase Session)
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Check Role
        if (decoded.role !== 'admin' && decoded.role !== 'superadmin') {
            return res.status(403).json({ error: "Access denied: Admins only" });
        }

        // Attach user info to request
        req.user = decoded;
        next();

    } catch (err) {
        console.error("ADMIN AUTH ERROR:", err.message);
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: "Token expired" });
        }
        return res.status(401).json({ error: "Invalid admin token" });
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
