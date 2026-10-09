import express from "express";
import {
    approveAdmin,
    deleteAdmin,
    getDashboardStats,
    listAdmins,
    getPendingInstitutes,
    getVerifiedInstitutes,
    getInstituteNames,
    getPendingStudentImports,
    getApprovedStudentImports,
    approveStudentImport,
    rejectStudentImport,
    approveInstitute,
    rejectInstitute,
    rejectAdmin,
    updateAdminRole,
    uploadAsset,
    getAllPermissions,
    updatePermissions,
    getMyPermissions,
    getAssignments
} from "../controllers/adminController.js";
import {
    bulkUpdateTransactions,
    createEventNews,
    deleteBracket,
    deleteEventNews,
    getAllCategories,
    getBrackets,
    getEventNews,
    getRegistrations, getTransactions,
    rejectTransaction,
    saveBracket,
    updateEventNews,
    verifyTransaction
} from "../controllers/adminEventController.js";
import {
    getPlayerDetails,
    listPlayers
} from "../controllers/adminPlayerController.js";
import {
    getBroadcastAudience,
    getBroadcastDetail,
    listBroadcasts,
    refreshBroadcast,
    retryBroadcast,
    sendBroadcast,
} from "../controllers/broadcastController.js";
import {
    getSettings, updateSettings
} from "../controllers/settingsController.js";
import { fromBody, fromQuery, fromRow, requireEventAccess } from "../middleware/eventAccess.js";
import { requirePermission, requireSuperAdmin, verifyAdmin } from "../middleware/rbacMiddleware.js";

const router = express.Router();

// Shorthands. superOnly: verifyAdmin + super admin. Event guards: the admin
// must manage the event the request is about (super admins always pass).
const superOnly = [verifyAdmin, requireSuperAdmin];
const newsEventFromBody = requireEventAccess(fromBody("eventId", "event_id"));
const newsEventFromRow = requireEventAccess(fromRow("event_news"));
const bracketEventFromQuery = requireEventAccess(fromQuery("eventId"));
const bracketEventFromBody = requireEventAccess(fromBody("eventId", "event_id"));
const bracketEventFromRow = requireEventAccess(fromRow("event_brackets"));
const registrationEvent = requireEventAccess(fromRow("event_registrations"));
const newsEventFromQuery = requireEventAccess(fromQuery("eventId"));
// A broadcast to one event's players needs that event; "all players" does not.
const broadcastAudienceEvent = (pickAudience) => {
    const guard = requireEventAccess((req) => pickAudience(req)?.eventId);
    return (req, res, next) => (pickAudience(req)?.type === "event" ? guard(req, res, next) : next());
};

/* ================= ADMIN MANAGEMENT ================= */
router.get("/list-admins", superOnly, listAdmins);
router.get("/assignments", superOnly, getAssignments);
router.get("/institutes/pending", superOnly, getPendingInstitutes);
router.get("/institutes/verified", superOnly, getVerifiedInstitutes);
router.get("/institutes/names", verifyAdmin, getInstituteNames);
router.get("/institutes/imports/pending", superOnly, getPendingStudentImports);
router.get("/institutes/imports/approved", superOnly, getApprovedStudentImports);
router.put("/institutes/imports/:id/approve", superOnly, approveStudentImport);
router.delete("/institutes/imports/:id/reject", superOnly, rejectStudentImport);
router.put("/institutes/:id/approve", superOnly, approveInstitute);
router.put("/institutes/:id/reject", superOnly, rejectInstitute);
router.post("/approve-admin/:id", superOnly, approveAdmin);
router.post("/reject-admin/:id", superOnly, rejectAdmin);
router.post("/update-admin-role/:id", superOnly, updateAdminRole);
router.delete("/delete-admin/:id", superOnly, deleteAdmin);

/* ================= DASHBOARD ================= */
router.get("/dashboard-stats", verifyAdmin, getDashboardStats);
router.post("/upload", verifyAdmin, uploadAsset);
/* ================= BROADCASTS ================= */
// /broadcast/audience must be declared before any /broadcast/:something route
// so "audience" is not swallowed as a parameter.
router.get("/broadcast/audience", verifyAdmin, requirePermission("broadcast"), broadcastAudienceEvent((req) => req.query), getBroadcastAudience);
router.post("/broadcast", verifyAdmin, requirePermission("broadcast"), broadcastAudienceEvent((req) => req.body?.audience), sendBroadcast);
router.get("/broadcasts", verifyAdmin, requirePermission("broadcast"), listBroadcasts);
router.get("/broadcasts/:id", verifyAdmin, requirePermission("broadcast"), getBroadcastDetail);
router.post("/broadcasts/:id/retry", verifyAdmin, requirePermission("broadcast"), retryBroadcast);
router.post("/broadcasts/:id/refresh", verifyAdmin, requirePermission("broadcast"), refreshBroadcast);

/* ================= PLAYER MANAGEMENT ================= */
router.get("/players", verifyAdmin, listPlayers);
router.get("/players/:id", verifyAdmin, getPlayerDetails);

/* ================= SETTINGS ================= */
router.get("/settings", verifyAdmin, getSettings);
router.post("/settings", superOnly, updateSettings);

/* ================= EVENT MANAGEMENT (GLOBAL) ================= */
router.get("/all-categories", verifyAdmin, getAllCategories);
router.get("/registrations", verifyAdmin, getRegistrations);
router.get("/transactions", verifyAdmin, getTransactions);

/* ================= TRANSACTION ACTIONS ================= */
router.put("/transactions/:id/verify", verifyAdmin, registrationEvent, verifyTransaction);
router.put("/transactions/:id/reject", verifyAdmin, registrationEvent, rejectTransaction);
router.post("/transactions/bulk-update", verifyAdmin, bulkUpdateTransactions);

/* ================= NEWS MANAGEMENT ================= */
router.get("/news", verifyAdmin, newsEventFromQuery, getEventNews);
router.post("/news", verifyAdmin, newsEventFromBody, createEventNews);
router.put("/news/:id", verifyAdmin, newsEventFromRow, updateEventNews);
router.delete("/news/:id", verifyAdmin, newsEventFromRow, deleteEventNews);

/* ================= BRACKETS MANAGEMENT ================= */
router.get("/brackets", verifyAdmin, bracketEventFromQuery, getBrackets);
router.post("/brackets", verifyAdmin, bracketEventFromBody, saveBracket);
router.delete("/brackets/:id", verifyAdmin, bracketEventFromRow, deleteBracket);

/* ================= PERMISSIONS MANAGEMENT ================= */
router.get("/permissions", superOnly, getAllPermissions);           // superadmin only — all admins + their permissions
router.put("/permissions/:adminId", superOnly, updatePermissions); // superadmin only — toggle specific admin's permissions
router.get("/my-permissions", verifyAdmin, getMyPermissions);         // any admin — get own permissions on login

export default router;