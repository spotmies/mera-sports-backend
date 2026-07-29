import express from "express";
import {
    handleWhatsAppWebhook,
    verifyWhatsAppWebhook,
} from "../controllers/whatsappWebhookController.js";

const router = express.Router();

// Public by design — Meta calls these, and it cannot present our admin JWT.
// The GET handshake is guarded by WHATSAPP_WEBHOOK_VERIFY_TOKEN; the POST body
// only ever moves a known message id forward in status, so it carries no
// authority beyond what Meta already told us.
router.get("/webhook", verifyWhatsAppWebhook);
router.post("/webhook", handleWhatsAppWebhook);

export default router;
