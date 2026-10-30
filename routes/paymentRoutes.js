import express from "express";
import { checkTeamsForCategory, createRazorpayOrder, validateRegistration, downloadRegistrationReceipt, getRazorpayOrderStatus, getRegistrationStatus, registerFree, submitManualPayment, verifyRazorpayPayment } from "../controllers/paymentController.js";
import { authenticateUser as verifyToken } from "../middleware/authMiddleware.js";

const router = express.Router();

// Dry run of every registration rule — called before the player pays
router.post("/validate-registration", verifyToken, validateRegistration);
// Which saved teams can enter one category, with the reason for the rest
router.post("/check-teams", verifyToken, checkTeamsForCategory);
router.post("/submit-manual-payment", verifyToken, submitManualPayment);
// Selections that total ₹0: no payment, registered as confirmed
router.post("/register-free", verifyToken, registerFree);
router.post("/create-razorpay-order", verifyToken, createRazorpayOrder);
router.post("/verify-razorpay-payment", verifyToken, verifyRazorpayPayment);
// Recovery path when the browser callback never fires (UPI app-switch / 3DS redirect)
router.get("/order-status/:orderId", verifyToken, getRazorpayOrderStatus);
router.get("/registration-status/:registrationNo", verifyToken, getRegistrationStatus);
// Same PDF as the confirmation email/WhatsApp — owner-only
router.get("/receipt/:registrationNo", verifyToken, downloadRegistrationReceipt);

export default router;
