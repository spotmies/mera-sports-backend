import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { cacheDel, cacheGet, cacheSet } from "../config/redisClient.js";
import { supabaseAdmin } from "../config/supabaseClient.js";

dotenv.config({ quiet: true });

// --------------------------------------------------------------------------
// 1. Verify Admin
//    - Expects 'Authorization: Bearer <backend_jwt>'
//    - The token only proves identity. Role and approval status are re-read
//      from the database (cached ~60s), so a deleted, demoted or un-approved
//      admin loses access within a minute instead of when the 30-day token
//      expires — and a promotion takes effect without logging in again.
// --------------------------------------------------------------------------
const ADMIN_AUTH_TTL_SECONDS = 60;
const adminAuthCacheKey = (id) => `admin:auth:${id}`;

export const invalidateAdminAuthCache = (adminId) => cacheDel(adminAuthCacheKey(adminId));

const loadAdminAccount = async (id) => {
    const cached = await cacheGet(adminAuthCacheKey(id));
    if (cached) return cached;
    const { data, error } = await supabaseAdmin
        .from("users")
        .select("id, role, verification")
        .eq("id", id)
        .maybeSingle();
    if (error) throw error;
    // Cache "gone" too, so a deleted account does not hit the DB per request.
    const account = data || { missing: true };
    await cacheSet(adminAuthCacheKey(id), account, ADMIN_AUTH_TTL_SECONDS);
    return account;
};

export const verifyAdmin = async (req, res, next) => {
    let decoded;
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Missing admin token" });
        }
        decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
    } catch (err) {
        console.error("ADMIN AUTH ERROR:", err.message);
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: "Token expired" });
        }
        return res.status(401).json({ error: "Invalid admin token" });
    }

    // Cheap reject before touching the DB: player/institute tokens never pass.
    if (!decoded?.id || (decoded.role !== 'admin' && decoded.role !== 'superadmin')) {
        return res.status(403).json({ error: "Access denied: Admins only" });
    }

    let account;
    try {
        account = await loadAdminAccount(decoded.id);
    } catch (err) {
        console.error("ADMIN AUTH DB ERROR:", err.message || err);
        return res.status(503).json({ error: "Database unavailable, please retry" });
    }

    if (account.missing) {
        return res.status(401).json({ error: "Admin account no longer exists" });
    }
    if (account.role !== 'admin' && account.role !== 'superadmin') {
        return res.status(403).json({ error: "Access denied: Admins only" });
    }
    // Pending and rejected admins keep a session (the pending screen polls
    // /api/auth/me with it) but may not use any admin endpoint.
    if (account.role === 'admin' && account.verification !== 'verified') {
        return res.status(403).json({ error: "Your admin account is awaiting approval", code: "ADMIN_NOT_APPROVED" });
    }

    req.user = { ...decoded, role: account.role, verification: account.verification };
    next();
};

// Use after verifyAdmin.
export const requireSuperAdmin = (req, res, next) => {
    if (req.user?.role !== 'superadmin') {
        return res.status(403).json({ error: "Only the super admin can do this", code: "SUPERADMIN_ONLY" });
    }
    next();
};

// --------------------------------------------------------------------------
// Admin feature permissions (Settings → admin permissions)
//   permit is the master switch; apartments, advertisements, broadcast and
//   reports are each gated by it. Superadmins always pass. A missing row means
//   everything is allowed, matching getMyPermissions.
// --------------------------------------------------------------------------
const PERMISSION_KEYS = ["apartments", "advertisements", "broadcast", "reports"];
const adminPermissionCacheKey = (id) => `admin:perm:${id}`;

export const invalidateAdminPermissionCache = (adminId) => cacheDel(adminPermissionCacheKey(adminId));

const loadAdminPermissions = async (adminId) => {
    const cached = await cacheGet(adminPermissionCacheKey(adminId));
    if (cached) return cached;
    const { data, error } = await supabaseAdmin
        .from("admin_permissions")
        .select("permit, apartments, advertisements, broadcast, reports")
        .eq("admin_id", adminId)
        .maybeSingle();
    if (error) throw error;
    const permissions = data || { permit: true, apartments: true, advertisements: true, broadcast: true, reports: true };
    await cacheSet(adminPermissionCacheKey(adminId), permissions, ADMIN_AUTH_TTL_SECONDS);
    return permissions;
};

export const adminHasPermission = async (user, key) => {
    if (user?.role === 'superadmin') return true;
    const permissions = await loadAdminPermissions(user.id);
    return permissions.permit !== false && permissions[key] !== false;
};

// Use after verifyAdmin (or after a middleware that sets req.user). Only admin
// and superadmin users are checked, so a shared route can still serve players.
export const requirePermission = (key) => {
    if (!PERMISSION_KEYS.includes(key)) throw new Error(`Unknown admin permission: ${key}`);
    return async (req, res, next) => {
        const role = req.user?.role;
        if (role !== 'admin' && role !== 'superadmin') return next();
        try {
            if (await adminHasPermission(req.user, key)) return next();
        } catch (err) {
            console.error("ADMIN PERMISSION DB ERROR:", err.message || err);
            return res.status(503).json({ error: "Database unavailable, please retry" });
        }
        return res.status(403).json({ error: "You don't have permission for this. Contact the super admin.", code: "PERMISSION_DENIED" });
    };
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

// --------------------------------------------------------------------------
// 3. Verify Institute Head
//    - Expects 'Authorization: Bearer <jwt_token>'
//    - Verifies using process.env.JWT_SECRET
//    - Checks if payload role == 'institutehead'
// --------------------------------------------------------------------------
export const verifyInstitute = (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Missing institute token" });
        }

        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Enforce Strict Role Check
        if (!decoded.role || decoded.role !== 'institutehead') {
            return res.status(403).json({ error: "Access denied: Restricted to Institute Heads only." });
        }

        req.user = decoded; // Attach decoded payload
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: "Session expired. Please login again." });
        }
        console.error("INSTITUTE AUTH ERROR:", err.message);
        return res.status(403).json({ error: "Invalid authentication token." });
    }
};
