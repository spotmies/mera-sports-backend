import express from "express";
import {
    updateInstituteProfile,
    requestBulkApproval,
    getApprovalStatus,
    finalizeBulkImport,
    getApprovedPlayers
} from "../controllers/instituteController.js";
import { verifyInstitute } from "../middleware/rbacMiddleware.js";

const router = express.Router();

// 1. PUT /api/institute/profile
router.put("/profile", verifyInstitute, updateInstituteProfile);

// 2. POST /api/institute/request-bulk-approval
router.post("/request-bulk-approval", verifyInstitute, requestBulkApproval);

// 2. GET /api/institute/approval-status
router.get("/approval-status", verifyInstitute, getApprovalStatus);

// 3. POST /api/institute/bulk-import-finalize
router.post("/bulk-import-finalize", verifyInstitute, finalizeBulkImport);

// 4. GET /api/institute/approved-players
router.get("/approved-players", verifyInstitute, getApprovedPlayers);

export default router;
