/** /api/auth/* — OTP, registration, login and session restore. */

import { errors, ok, okEnvelope } from "../components.js";

const jsonBody = (schema, required = true) => ({
    required,
    content: { "application/json": { schema } },
});

const obj = (properties, required = []) => ({ type: "object", required, properties });

const AUTH_TAG = ["Auth"];

export const authPaths = {
    /* ── registration OTP (unauthenticated) ───────────────────────────────── */

    "/api/auth/send-otp": {
        post: {
            tags: AUTH_TAG,
            summary: "Send an email OTP for player registration",
            description: "Step 1 of email verification during sign-up. The OTP lives in Redis (or the in-process fallback) for a few minutes.",
            requestBody: jsonBody(obj({ email: { type: "string", format: "email", example: "tester@example.com" } }, ["email"])),
            responses: { ...okEnvelope("OTP dispatched.", { message: { type: "string", example: "OTP sent to email" } }), ...errors(400, 500) },
        },
    },

    "/api/auth/verify-otp": {
        post: {
            tags: AUTH_TAG,
            summary: "Verify the registration email OTP",
            requestBody: jsonBody(
                obj(
                    { email: { type: "string", format: "email" }, otp: { type: "string", example: "483920" } },
                    ["email", "otp"]
                )
            ),
            responses: { ...okEnvelope("OTP accepted.", { message: { type: "string" } }), ...errors(400, 500) },
        },
    },

    "/api/auth/send-mobile-otp": {
        post: {
            tags: AUTH_TAG,
            summary: "Send a WhatsApp OTP for player registration",
            description: "Returns a `sessionId` that must be echoed back on verification.",
            requestBody: jsonBody(obj({ mobile: { type: "string", example: "9876543210" } }, ["mobile"])),
            responses: {
                ...okEnvelope("OTP dispatched.", { sessionId: { type: "string" }, message: { type: "string" } }),
                ...errors(400, 500),
            },
        },
    },

    "/api/auth/verify-mobile-otp": {
        post: {
            tags: AUTH_TAG,
            summary: "Verify the registration mobile OTP",
            requestBody: jsonBody(
                obj(
                    {
                        mobile: { type: "string", example: "9876543210" },
                        otp: { type: "string", example: "483920" },
                        sessionId: { type: "string", description: "From `send-mobile-otp`." },
                    },
                    ["mobile", "otp"]
                )
            ),
            responses: { ...okEnvelope("OTP accepted."), ...errors(400, 500) },
        },
    },

    "/api/auth/check-conflict": {
        post: {
            tags: AUTH_TAG,
            summary: "Pre-flight duplicate check before registering",
            description:
                "Reports whether a mobile / email / aadhaar is already taken so the sign-up form can fail early. A shared family mobile is allowed and is reported separately.",
            requestBody: jsonBody(
                obj(
                    {
                        mobile: { type: "string", example: "9876543210" },
                        email: { type: "string", format: "email" },
                        aadhaar: { type: "string", example: "123412341234" },
                        dob: { type: "string", format: "date" },
                    },
                    ["mobile", "email"]
                )
            ),
            responses: {
                ...ok("Conflict verdict.", {
                    type: "object",
                    properties: {
                        conflict: { type: "boolean", example: false },
                        field: { type: "string", nullable: true, example: "email" },
                        message: { type: "string", nullable: true },
                    },
                }),
                ...errors(400, 500),
            },
        },
    },

    /* ── forgot password ─────────────────────────────────────────────────── */

    "/api/auth/institute/forgot-password/send-otp": {
        post: {
            tags: AUTH_TAG,
            summary: "Institute head — start password reset",
            description:
                "Step 1 of the institute reset flow. Steps 2 and 3 reuse the two shared endpoints below with `method: \"email\"`.",
            requestBody: jsonBody(obj({ email: { type: "string", format: "email" } }, ["email"])),
            responses: { ...okEnvelope("OTP emailed."), ...errors(400, 403, 404, 500) },
        },
    },

    "/api/auth/forgot-password/verify-otp": {
        post: {
            tags: AUTH_TAG,
            summary: "Verify a forgot-password OTP",
            description: "On success returns a short-lived `resetToken` that `/forgot-password/reset` requires.",
            requestBody: jsonBody(
                obj(
                    {
                        method: { type: "string", enum: ["email", "mobile"], example: "email" },
                        value: { type: "string", description: "The email address or mobile number the OTP was sent to." },
                        otp: { type: "string", example: "483920" },
                        sessionId: { type: "string", description: "Required when `method` is `mobile`." },
                    },
                    ["method", "value", "otp"]
                )
            ),
            responses: { ...okEnvelope("OTP accepted.", { resetToken: { type: "string" } }), ...errors(400, 500) },
        },
    },

    "/api/auth/forgot-password/reset": {
        post: {
            tags: AUTH_TAG,
            summary: "Set a new password using a reset token",
            requestBody: jsonBody(
                obj(
                    {
                        method: { type: "string", enum: ["email", "mobile"] },
                        value: { type: "string" },
                        newPassword: { type: "string", minLength: 6, example: "NewPass@123" },
                        resetToken: { type: "string", description: "From `/forgot-password/verify-otp`." },
                    },
                    ["method", "value", "newPassword", "resetToken"]
                )
            ),
            responses: { ...okEnvelope("Password updated."), ...errors(400, 401, 404, 500) },
        },
    },

    /* ── step-up verification for logged-in players ──────────────────────── */

    "/api/auth/send-verification-otp": {
        post: {
            tags: AUTH_TAG,
            summary: "Send a step-up OTP to the logged-in user",
            description:
                "Required before a player may change their email/mobile or password. Sends to whichever channel `method` names, using the contact details already on the account.",
            security: [{ bearerAuth: [] }],
            requestBody: jsonBody(obj({ method: { type: "string", enum: ["email", "mobile"], example: "mobile" } }, ["method"])),
            responses: {
                ...okEnvelope("OTP dispatched.", {
                    method: { type: "string", example: "mobile" },
                    sessionId: { type: "string", nullable: true, description: "Present for `mobile` only." },
                }),
                ...errors(400, 401, 404, 500),
            },
        },
    },

    "/api/auth/verify-verification-otp": {
        post: {
            tags: AUTH_TAG,
            summary: "Verify the step-up OTP",
            description:
                "Returns a `verificationToken`. Send it as the **`x-verification-token`** header on `PUT /api/player/update-profile` and `PUT /api/player/change-password`.",
            security: [{ bearerAuth: [] }],
            requestBody: jsonBody(
                obj(
                    {
                        method: { type: "string", enum: ["email", "mobile"] },
                        otp: { type: "string", example: "483920" },
                        sessionId: { type: "string", description: "Required when `method` is `mobile`." },
                    },
                    ["method", "otp"]
                )
            ),
            responses: { ...okEnvelope("Verified.", { verificationToken: { type: "string" } }), ...errors(400, 401, 500) },
        },
    },

    /* ── player ──────────────────────────────────────────────────────────── */

    "/api/auth/register-player": {
        post: {
            tags: AUTH_TAG,
            summary: "Register a player",
            description:
                "Creates the account, generates a `player_id`, and emails + WhatsApps the credentials. The password is generated server-side, not supplied.",
            requestBody: jsonBody(
                obj(
                    {
                        firstName: { type: "string", example: "Arjun" },
                        lastName: { type: "string", example: "Kumar" },
                        mobile: { type: "string", example: "9876543210" },
                        email: { type: "string", format: "email", example: "arjun@example.com" },
                        dob: { type: "string", format: "date", example: "2005-04-11" },
                        gender: { type: "string", enum: ["Male", "Female", "Other"], example: "Male" },
                        aadhaar: { type: "string", example: "123412341234" },
                        apartment: { type: "string", example: "Green Meadows" },
                        street: { type: "string", example: "MVP Colony" },
                        city: { type: "string", example: "Visakhapatnam" },
                        state: { type: "string", example: "Andhra Pradesh" },
                        pincode: { type: "string", example: "530017" },
                        country: { type: "string", example: "India" },
                        photos: { type: "string", description: "`data:image/...;base64,...` — uploaded to the player-photos bucket." },
                        isVerified: { type: "boolean", description: "Set by the client once both OTP steps passed." },
                        schoolDetails: {
                            type: "object",
                            nullable: true,
                            description: "Written to `player_school_details`.",
                            properties: {
                                school_name: { type: "string" },
                                school_address: { type: "string" },
                                school_city: { type: "string" },
                                school_pincode: { type: "string" },
                            },
                        },
                    },
                    ["firstName", "mobile", "email", "dob"]
                )
            ),
            responses: {
                ...ok("Account created; token returned.", { $ref: "#/components/schemas/AuthSuccess" }),
                ...errors(400, 500),
            },
        },
    },

    "/api/auth/login": {
        post: {
            tags: AUTH_TAG,
            summary: "Player login",
            description: "Identify by **player id or aadhaar** — not by email. Token is valid 7 days.",
            requestBody: jsonBody(
                obj(
                    {
                        playerIdOrAadhaar: { type: "string", example: "SP-000123" },
                        password: { type: "string", format: "password", example: "Player@123" },
                    },
                    ["playerIdOrAadhaar", "password"]
                )
            ),
            responses: {
                ...ok("Signed in.", { $ref: "#/components/schemas/AuthSuccess" }),
                ...errors(400, 401, 403, 500),
            },
        },
    },

    /* ── admin ───────────────────────────────────────────────────────────── */

    "/api/auth/register-admin": {
        post: {
            tags: AUTH_TAG,
            summary: "Register an admin (lands in `verification: pending`)",
            description: "A superadmin must approve the account via `POST /api/admin/approve-admin/{id}` before it can sign in.",
            requestBody: jsonBody(
                obj(
                    {
                        name: { type: "string", example: "QA Admin" },
                        email: { type: "string", format: "email", example: "qa.admin@example.com" },
                        mobile: { type: "string", example: "9876543211" },
                        password: { type: "string", format: "password", example: "Admin@123" },
                    },
                    ["name", "email", "password"]
                )
            ),
            responses: { ...okEnvelope("Application submitted."), ...errors(400, 500) },
        },
    },

    "/api/auth/login-admin": {
        post: {
            tags: AUTH_TAG,
            summary: "Admin / superadmin login",
            description: "Token is valid 30 days. Rejected or unapproved admins get 403.",
            requestBody: jsonBody(
                obj(
                    { email: { type: "string", format: "email" }, password: { type: "string", format: "password" } },
                    ["email", "password"]
                )
            ),
            responses: {
                ...ok("Signed in.", { $ref: "#/components/schemas/AuthSuccess" }),
                ...errors(400, 401, 403, 500),
            },
        },
    },

    "/api/auth/reapply-google-admin": {
        post: {
            tags: AUTH_TAG,
            summary: "Re-submit a rejected Google admin application",
            requestBody: jsonBody(obj({ token: { type: "string", description: "Google ID token." } }, ["token"])),
            responses: { ...okEnvelope("Re-application accepted."), ...errors(400, 401, 500) },
        },
    },

    "/api/auth/sync": {
        post: {
            tags: AUTH_TAG,
            summary: "Google sign-in for admins",
            description:
                "Send the **Google ID token** (from Google Identity Services) as `Authorization: Bearer <google_id_token>` — not a backend JWT. First-time emails are created as `admin` with `verification: pending`; the response carries the backend JWT to use from then on.",
            security: [{ bearerAuth: [] }],
            responses: {
                ...okEnvelope("Synced.", {
                    token: { type: "string", description: "Backend JWT." },
                    user: { $ref: "#/components/schemas/User" },
                }),
                ...errors(401, 403, 500),
                503: { description: "Database unreachable — retry; do not re-register." },
            },
        },
    },

    /* ── institute head ──────────────────────────────────────────────────── */

    "/api/auth/register-institute": {
        post: {
            tags: AUTH_TAG,
            summary: "Register an institute head",
            requestBody: jsonBody(
                obj(
                    {
                        instituteName: { type: "string", example: "St. Xavier High School" },
                        email: { type: "string", format: "email", example: "head@stxavier.edu" },
                        contactNumber: { type: "string", example: "9876543212" },
                        password: { type: "string", format: "password", example: "Institute@123" },
                        website: { type: "string", example: "https://stxavier.edu" },
                        address: { type: "string", example: "Beach Road, Visakhapatnam" },
                    },
                    ["instituteName", "email", "contactNumber", "password"]
                )
            ),
            responses: { ...okEnvelope("Institute registered."), ...errors(400, 409, 500) },
        },
    },

    "/api/auth/login-institute": {
        post: {
            tags: AUTH_TAG,
            summary: "Institute head login",
            requestBody: jsonBody(
                obj(
                    { email: { type: "string", format: "email" }, password: { type: "string", format: "password" } },
                    ["email", "password"]
                )
            ),
            responses: {
                ...ok("Signed in.", { $ref: "#/components/schemas/AuthSuccess" }),
                ...errors(400, 401, 403, 500),
            },
        },
    },

    /* ── session ─────────────────────────────────────────────────────────── */

    "/api/auth/me": {
        get: {
            tags: AUTH_TAG,
            summary: "Restore the session for the bearer token",
            description: "Works for every role. A 503 here means the DB is down — clients should keep the token and retry rather than log out.",
            security: [{ bearerAuth: [] }],
            responses: {
                ...okEnvelope("Current user.", { user: { $ref: "#/components/schemas/User" } }),
                ...errors(401, 404),
                503: { description: "Database unavailable — retry." },
            },
        },
    },
};
