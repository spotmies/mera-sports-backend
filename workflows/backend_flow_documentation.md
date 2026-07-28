# Mera Sports Backend - Application Flow Documentation

This document outlines the entire architectural flow and business logic of the `mera-sports-backend` application. It serves as a comprehensive guide for developers to understand how data moves through the Node.js/Express server and interacts with the Railway PostgreSQL database.

> **Migrated off Supabase (2026-07).** Database, storage, auth and realtime all run on Railway now; the Supabase client and its rollback flags were removed on 2026-07-28. See `MIGRATION_REPORT_QA.md`.

## 1. System Architecture & Tech Stack
*   **Framework:** Node.js with Express.js
*   **Database:** **Railway PostgreSQL 18**, reached over HTTP through self-hosted **PostgREST v14.15**. Controllers use `@supabase/postgrest-js` — the PostgREST query builder, *not* Supabase-the-service — so every `.from()` / `.rpc()` call site reads like the old Supabase code. The handle is exported as `supabaseAdmin` from `config/supabaseClient.js`; the name is legacy, the service is not.
    *   Railway: `POSTGREST_URL=http://postgrest.railway.internal:3000` (private networking).
    *   Local: `POSTGREST_URL=http://localhost:3333` — `npm run dev` starts PostgREST for you (see `scripts/dev.mjs`).
*   **Authentication Mechanism:** Dual-strategy, both issuing this backend's own JWTs (`process.env.JWT_SECRET`). Supabase Auth is gone — `public.users` is the only user store.
    *   Admins/Superadmins sign in with **Google Identity Services**; the ID token is verified server-side by `google-auth-library` in `routes/googleSyncRoutes.js`, matched to an existing user by email. Password login uses bcrypt.
    *   Players use OTP-based authentication (WhatsApp Cloud API / email), with OTP state in Redis.
*   **Realtime:** **Socket.IO** on the Express server (JWT handshake, per-user rooms) — `services/realtimeService.js`.
*   **Caching:** Redis, fail-soft — a Redis outage degrades to direct DB reads rather than erroring.
*   **Payment Gateway:** Razorpay for processing event registration fees.
*   **File Uploads:** Custom `uploadBase64` utility (`utils/uploadHelper.js`) pipes media into the **private Railway Bucket** (Tigris S3) via the `utils/railwayStorage.js` shim. Files are served through `GET /api/files/:bucket/*`, which 302-redirects to a signed URL — the bucket is never publicly readable.

---

## 2. Authentication & Authorization Flows (RBAC)
The middleware `rbacMiddleware.js` controls the gateways to all APIs based on three primary roles: `player`, `admin`, and `superadmin` (with emerging support for `institutehead`).

### Player Flow
1. **Registration:** A player submits their details (DOB, name, etc.). The system verifies age criteria and sends an OTP (Mobile/Email).
2. **Verification & Creation:** Upon OTP validation, the user profile is inserted into the `users` table with `role: 'player'`.
3. **Session:** The backend issues a custom Node.js JSON Web Token (JWT). The frontend stores this and attaches it as a Bearer token. `verifyPlayer` middleware decodes this to ensure access strictly to `/api/player` public routes.

### Admin / Superadmin Flow
1. **Registration:** Admins log in/sign up usually via Google Sync (`routes/googleSyncRoutes.js`), which verifies the Google ID token directly and matches an existing user by email.
2. **Pending State:** Newly registered admins default to `role: 'admin'` and `verification: 'pending'`. They **cannot** access the system yet.
3. **Approval:** A `superadmin` uses the Admin Control dashboard to approve them (`POST /api/admin/approve-admin/:id`). This switches their status to `verified` and generates an `admin_permissions` database row.
4. **Session:** Admins communicate with backend APIs using this backend's own JWTs, verified by the `verifyAdmin` middleware. `superadmin` bypasses most sub-permissions constraints natively.

---

## 3. Core Engine Flows

### A. The Event Lifecycle
1. **Creation (`eventController.js`):** An Admin creates an event via `POST /api/events/create`. The backend auto-generates a QR code for the event URL, uploads banners/sponsor logos, and stores it in the `events` table. 
   * *Notification Hook:* The backend triggers a push to the `notifications` table to alert all superadmins that a new event requires review/assignment.
2. **Assignment:** A Superadmin assigns the event to a specific Admin. This populates `assigned_to` and `assigned_by` on the `events` table.
3. **Public Viewing:** Players fetch upcoming events via public endpoints to view brackets, news, and details.

### B. Event Registration & Payments (`paymentController.js`)
1. **Initiation:** A player selects an event category to join and requests registration.
2. **Order Creation:** Backend creates a Razorpay Order ID and returns it to the frontend.
3. **Verification:** Frontend completes payment and sends the signature back; backend `verifyPayment` mathematically verifies the HMAC signature.
4. **Fulfillment:** If valid, the backend creates an `event_registrations` row linking the `player_id` to the `event_id` with `status: 'verified'`.
5. *Bulk Imports:* An `institutehead` can bypass individual payments, uploading bulk Excel sheets of students representing a school, requiring Superadmin approval.

### C. The Tournament Engine (Matches & Brackets)
This is the most complex logic center of the application, broken down by tournament style:

**1. Knockout Brackets (`bracketController.js`)**
*   **Initialization:** Admins initialize a draw. The system calculates seeds and byes based on the total number of registered players. 
*   **Structure:** It generates a JSON structure mapping "Round of 32", "Round of 16", "Quarter-Finals", etc.
*   **Progression:** When a match score is submitted (`setMatchResult`), the backend explicitly calculates the winner, updates the match row, and dynamically forwards the winner into the next bracket slot in the JSON data structure.

**2. Round-Robin / Leagues (`leagueController.js` & `matchController.js`)**
*   **Generation:** Triggered via `generateLeagueMatches`. The backend reads all registered participants for a given league category.
*   **Combinatorics Algorithm:** It loops through the entities and pairs everyone against everyone else exactly once, ensuring no duplicate match-ups.
*   **Match Table:** It bulk-inserts these pairings into the standard `matches` table under the round name `'LEAGUE'`.

---

## 4. Sub-Systems

### A. Automatic Internal Notifications (`notificationController.js`)
*   Notifications are entirely backend-driven — the frontend never writes them directly.
*   *Mechanism:* When a significant action occurs (e.g., Admin creates an event, User submits 'Contact Us' form), the controller identifies the target users (like Superadmins) and bulk-inserts customized payload objects into the `public.notifications` table, then emits over Socket.IO for immediate delivery.
*   RLS no longer exists: the 36 Supabase policies were dropped in the migration (the service key bypassed them anyway). **Authorization lives entirely in API middleware** — `verifyAdmin` / `rbacMiddleware`. Nothing in the database enforces access control, so route guards are not optional.

### B. Admin Sub-Permissions
*   Superadmins can restrict standard admins to granular pieces of the dashboard (e.g., `permit: true/false`, `broadcast: true/false`).
*   This is evaluated dynamically by querying the `admin_permissions` table connected to the admin's UUID.

### C. Storage & Base64 Uploads (`utils/uploadHelper.js`)
*   The frontend avoids complex multipart form data by sending raw Base64 strings.
*   The backend decodes these buffers and streams them into the **private Railway Bucket** (Tigris S3) via `utils/railwayStorage.js`, under the legacy key prefixes (`event-assets/banners`, `admin-assets/avatars`, …) so existing paths kept working across the migration.
*   Stored URLs point at the **API domain**, not the bucket: `<FILE_BASE_URL>/api/files/<bucket>/<path>`. `routes/fileRoutes.js` 302-redirects those to short-lived signed URLs (path-traversal guarded). Direct public reads on the bucket return 403 by design — and because the DB stores API URLs, swapping the storage backend again would need no URL rewrite.
