// ── MUST be the very first line before any imports ──────────────────────────
// Expands libuv thread pool from 4 → 16 threads.
// Without this, bulk bcrypt hashing (Phase 2) fills all 4 slots, causing
// concurrent individual player registrations to queue behind it.
process.env.UV_THREADPOOL_SIZE = '16';

import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import adminRoutes from "./routes/adminRoutes.js"; // Added Admin Routes
import advertisementRoutes from "./routes/advertisementRoutes.js";
import apartmentRoutes from "./routes/apartmentRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import bracketRoutes from "./routes/bracketRoutes.js";
import contactRoutes from "./routes/contactRoutes.js";
import eventRoutes from "./routes/eventRoutes.js";
import fileRoutes from "./routes/fileRoutes.js";
import googleSyncRoutes from "./routes/googleSyncRoutes.js";
import leagueRoutes from "./routes/leagueRoutes.js";
import matchRoutes from "./routes/matchRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js"; // Added Notification Routes Import
import paymentRoutes from "./routes/paymentRoutes.js"; // Added Payment Routes
import instituteRoutes from "./routes/instituteRoutes.js"; // Added Institute Routes
import playerDashboardRoutes from "./routes/playerDashboardroutes.js";
import publicRoutes from "./routes/publicRoutes.js";
import teamRoutes from "./routes/teamRoutes.js";

dotenv.config({ quiet: true });

// Fail fast if the signing secret is missing — without it every jwt.sign/verify
// across auth, OTP reset tokens and payments would be silently insecure.
if (!process.env.JWT_SECRET) {
    console.error("❌ FATAL: JWT_SECRET is not set. Refusing to start.");
    process.exit(1);
}

const app = express();

app.use(cors());

// Webhook MUST be mounted before express.json() so it receives the raw body
// Razorpay signature verification requires the exact raw bytes — JSON parsing corrupts it
import { razorpayWebhook } from "./controllers/paymentController.js";
app.post("/api/payment/webhook", express.raw({ type: "application/json" }), razorpayWebhook);

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ limit: "15mb", extended: true }));
app.use("/api/player", playerDashboardRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/auth", googleSyncRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/payment", paymentRoutes); // Mounted Payment Routes
app.use("/api/admin/matches", matchRoutes); // Scoreboard Matches Routes (Prioritized)
app.use("/api/admin", leagueRoutes); // League routes (must be before bracket/admin to match /events/.../league)
app.use("/api/admin", bracketRoutes); // Bracket Management Routes
app.use("/api/admin", adminRoutes);
app.use("/api/advertisements", advertisementRoutes);
app.use("/api/apartments", apartmentRoutes);
app.use("/api/teams", teamRoutes);
app.use("/api/notifications", notificationRoutes); // Mounted Notification Routes
app.use("/api/institute", instituteRoutes); // Institute endpoints
app.use("/api/public", publicRoutes);
app.use("/api/files", fileRoutes); // Signed-URL delivery for Railway bucket files


const PORT = process.env.PORT || 5001;
import { createServer } from "http";
import { initRealtime } from "./services/realtimeService.js";

// Socket.IO needs the raw http server (Express 5's app.listen would hide it)
const httpServer = createServer(app);
initRealtime(httpServer);
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});