import express from "express";
import { createRazorpayOrder, downloadRegistrationReceipt, getRazorpayOrderStatus, submitManualPayment, verifyRazorpayPayment } from "../controllers/paymentController.js";
import { authenticateUser as verifyToken } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/submit-manual-payment", verifyToken, submitManualPayment);
router.post("/create-razorpay-order", verifyToken, createRazorpayOrder);
router.post("/verify-razorpay-payment", verifyToken, verifyRazorpayPayment);
// Recovery path when the browser callback never fires (UPI app-switch / 3DS redirect)
router.get("/order-status/:orderId", verifyToken, getRazorpayOrderStatus);
// Same PDF as the confirmation email/WhatsApp — owner-only
router.get("/receipt/:registrationNo", verifyToken, downloadRegistrationReceipt);

export default router;
