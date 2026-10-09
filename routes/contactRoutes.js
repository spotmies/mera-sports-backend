import express from "express";
import { getMessages, sendMessage, updateMessageStatus } from "../controllers/contactController.js";
import { requirePermission, verifyAdmin } from "../middleware/rbacMiddleware.js";

// Reading and handling messages needs the admin's "reports" permission.
const canHandleReports = [verifyAdmin, requirePermission("reports")];

const router = express.Router();

router.get("/", canHandleReports, getMessages);
router.put("/:id/status", canHandleReports, updateMessageStatus);
router.post("/send", sendMessage);

export default router;