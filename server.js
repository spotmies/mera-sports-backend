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
import googleSyncRoutes from "./routes/googleSyncRoutes.js";
import leagueRoutes from "./routes/leagueRoutes.js";
import matchRoutes from "./routes/matchRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js"; // Added Notification Routes Import
import paymentRoutes from "./routes/paymentRoutes.js"; // Added Payment Routes
import instituteRoutes from "./routes/instituteRoutes.js"; // Added Institute Routes
import playerDashboardRoutes from "./routes/playerDashboardroutes.js";
import publicRoutes from "./routes/publicRoutes.js";
import teamRoutes from "./routes/teamRoutes.js";
import tempSeedRoutes from "./routes/tempSeedRoutes.js"; // Seed routes for testing

dotenv.config({ quiet: true });

const app = express();

app.use(cors());
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
app.use("/api/seed", tempSeedRoutes); // Seed routes (for testing only - remove in production)


const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});