import express from "express";
import {
    checkUserConflict,
    getCurrentUser,
    loginAdmin,
    loginPlayer,
    reapplyGoogleAdmin,
    registerAdmin,
    registerPlayer,
    sendMobileRegistrationOtp,
    sendRegistrationOtp,
    sendVerificationOtp,
    verifyMobileRegistrationOtp,
    verifyRegistrationOtp,
    verifyVerificationOtp,
    registerInstitute,
    loginInstitute,
    resetPassword
} from "../controllers/authController.js";

const router = express.Router();

/* ================= SECURITY VERIFICATION ================= */
router.post("/send-verification-otp", sendVerificationOtp);
router.post("/verify-verification-otp", verifyVerificationOtp);

/* ================= OTP ROUTES (REGISTRATION) ================= */
router.post("/send-otp", sendRegistrationOtp);
router.post("/verify-otp", verifyRegistrationOtp);
router.post("/send-mobile-otp", sendMobileRegistrationOtp);
router.post("/verify-mobile-otp", verifyMobileRegistrationOtp);

/* ================= CHECK CONFLICT ================= */
router.post("/check-conflict", checkUserConflict);

/* ================= FORGOT PASSWORD ================= */
router.post("/forgot-password/reset", resetPassword);

/* ================= PLAYER AUTH ================= */
router.post("/register-player", registerPlayer);
router.post("/login", loginPlayer);

/* ================= ADMIN AUTH ================= */
router.post("/register-admin", registerAdmin);
router.post("/login-admin", loginAdmin);
router.post("/reapply-google-admin", reapplyGoogleAdmin);

/* ================= INSTITUTE HEAD AUTH ================= */
router.post("/register-institute", registerInstitute);
router.post("/login-institute", loginInstitute);

/* ================= SESSION ================= */
router.get("/me", getCurrentUser);

export default router;