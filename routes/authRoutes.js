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
    resetPassword,
    sendForgotPasswordOtp,
    sendInstituteForgotPasswordOtp,
    verifyForgotPasswordOtp
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
router.post("/forgot-password/send-otp", sendForgotPasswordOtp);
router.post("/forgot-password/verify-otp", verifyForgotPasswordOtp);
router.post("/forgot-password/reset", resetPassword);

// Institute step 1. Steps 2 and 3 reuse the two shared endpoints above with
// method: 'email' — see sendInstituteForgotPasswordOtp for why that is safe.
router.post("/institute/forgot-password/send-otp", sendInstituteForgotPasswordOtp);

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