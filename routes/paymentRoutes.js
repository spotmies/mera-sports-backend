import express from "express";
import { createRazorpayOrder, submitManualPayment, verifyRazorpayPayment } from "../controllers/paymentController.js";
import { authenticateUser as verifyToken } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/submit-manual-payment", verifyToken, submitManualPayment);
router.post("/create-razorpay-order", verifyToken, createRazorpayOrder);
router.post("/verify-razorpay-payment", verifyToken, verifyRazorpayPayment);

export default router;
