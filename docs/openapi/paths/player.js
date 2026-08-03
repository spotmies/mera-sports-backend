/**
 * Player-facing surface: dashboard, profile, media, teams, payments,
 * notifications, plus the institute-head area and the small public
 * contact / apartment / advertisement endpoints.
 */

import { errors, ok, okEnvelope } from "../components.js";

const p = (ref) => ({ $ref: `#/components/parameters/${ref}` });
const s = (name) => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (name) => ({ type: "array", items: s(name) });

const jsonBody = (schema) => ({ required: true, content: { "application/json": { schema } } });
const obj = (properties, required = []) => ({ type: "object", required, properties });

const auth = [{ bearerAuth: [] }];
const idParam = (description, format) => ({
    name: "id",
    in: "path",
    required: true,
    description,
    schema: format ? { type: "string", format } : { type: "string" },
});

export const playerPaths = {
    /* ── player dashboard & profile ──────────────────────────────────────── */

    "/api/player/dashboard": {
        get: {
            tags: ["Player"],
            summary: "Player dashboard — profile plus every registration",
            description:
                "Player token only. Each registration is enriched with its transaction, team details, and whether this player is the captain, a member, or registered themselves. Cached in Redis and invalidated on profile/registration writes.",
            security: auth,
            responses: {
                ...okEnvelope("Dashboard payload.", {
                    player: s("User"),
                    registrations: {
                        type: "array",
                        items: {
                            allOf: [
                                s("Registration"),
                                obj({
                                    events: s("Event"),
                                    transactions: { oneOf: [s("Transaction"), { type: "null" }] },
                                    team_details: { oneOf: [s("Team"), { type: "null" }] },
                                    is_captain: { type: "boolean" },
                                    is_team_member: { type: "boolean" },
                                    registered_by: { type: "string", enum: ["self", "team"] },
                                }),
                            ],
                        },
                    },
                }),
                ...errors(401, 403, 404, 500),
            },
        },
    },

    "/api/player/check-conflict": {
        post: {
            tags: ["Player"],
            summary: "Check whether a new email/mobile is already taken",
            description: "Use before submitting a profile update. A mobile already shared with a family member is allowed.",
            security: auth,
            requestBody: jsonBody(obj({ email: { type: "string", format: "email" }, mobile: { type: "string" } })),
            responses: {
                ...ok("Verdict.", obj({ conflict: { type: "boolean" }, field: { type: "string", nullable: true }, message: { type: "string", nullable: true } })),
                ...errors(401, 403, 409, 500),
            },
        },
    },

    "/api/player/check-password": {
        post: {
            tags: ["Player"],
            summary: "Confirm the current password",
            security: auth,
            requestBody: jsonBody(obj({ currentPassword: { type: "string", format: "password" } }, ["currentPassword"])),
            responses: { ...ok("Correct.", obj({ correct: { type: "boolean", example: true } })), ...errors(400, 401, 403, 500) },
        },
    },

    "/api/player/update-profile": {
        put: {
            tags: ["Player"],
            summary: "Update the player profile",
            description:
                "Changing **email or mobile** additionally requires the `x-verification-token` header from the step-up OTP flow (`/api/auth/send-verification-otp` → `/api/auth/verify-verification-otp`). Other fields do not. A 403 with `requiresVerification: true` means the header was missing.",
            security: auth,
            parameters: [{ ...p("VerificationTokenHeader"), required: false }],
            requestBody: jsonBody(
                obj({
                    email: { type: "string", format: "email" },
                    mobile: { type: "string", example: "9876543210" },
                    photos: { type: "string", description: "`data:image/...;base64,...` or an existing URL." },
                    apartment: { type: "string" },
                    street: { type: "string" },
                    city: { type: "string" },
                    state: { type: "string" },
                    pincode: { type: "string" },
                    country: { type: "string" },
                    gender: { type: "string", enum: ["Male", "Female", "Other"] },
                })
            ),
            responses: { ...okEnvelope("Updated.", { player: s("User"), message: { type: "string" } }), ...errors(401, 403, 404, 409, 500) },
        },
    },

    "/api/player/change-password": {
        put: {
            tags: ["Player"],
            summary: "Change the player password",
            description: "Always requires the `x-verification-token` header.",
            security: auth,
            parameters: [p("VerificationTokenHeader")],
            requestBody: jsonBody(
                obj(
                    { currentPassword: { type: "string", format: "password" }, newPassword: { type: "string", format: "password", minLength: 6 } },
                    ["currentPassword", "newPassword"]
                )
            ),
            responses: { ...okEnvelope("Password updated."), ...errors(400, 401, 403, 500) },
        },
    },

    "/api/player/delete-account": {
        delete: {
            tags: ["Player"],
            summary: "Delete the signed-in player account",
            description: "Destructive — do not run against shared QA fixtures you still need.",
            security: auth,
            responses: { ...okEnvelope("Account deleted."), ...errors(401, 403, 500) },
        },
    },

    /* ── player media ────────────────────────────────────────────────────── */

    "/api/player/upload-media": {
        post: {
            tags: ["Player"],
            summary: "Upload a photo or video to the player gallery",
            description:
                "`multipart/form-data`, field name **`image`** (videos use the same field). Limits: 4 MB per image, 6 MB per video, 10 MB total per player. Oversized files return 400 with `code: FILE_TOO_LARGE`.",
            security: auth,
            requestBody: {
                required: true,
                content: {
                    "multipart/form-data": {
                        schema: obj({ image: { type: "string", format: "binary", description: "JPEG, PNG, WEBP, MP4, WEBM, MOV or AVI." } }, ["image"]),
                    },
                },
            },
            responses: { ...okEnvelope("Uploaded.", { media: s("PlayerUpload") }), ...errors(400, 401, 403, 500) },
        },
    },

    "/api/player/media": {
        get: {
            tags: ["Player"],
            summary: "List the player's uploads",
            security: auth,
            responses: { ...okEnvelope("Uploads.", { media: arrayOf("PlayerUpload") }), ...errors(401, 403, 500) },
        },
    },

    "/api/player/delete-media/{id}": {
        delete: {
            tags: ["Player"],
            summary: "Delete one upload",
            security: auth,
            parameters: [idParam("`player_uploads.id`.", "uuid")],
            responses: { ...okEnvelope("Deleted."), ...errors(401, 403, 404, 500) },
        },
    },

    /* ── teams ───────────────────────────────────────────────────────────── */

    "/api/teams/my-teams": {
        get: {
            tags: ["Teams"],
            summary: "Teams you captain, and teams that added you",
            description: "Accepts any authenticated token.",
            security: auth,
            responses: {
                ...okEnvelope("Teams.", { teams: arrayOf("Team"), teams_added_you: arrayOf("Team") }),
                ...errors(401, 500),
            },
        },
    },

    "/api/teams/player-lookup/{playerId}": {
        get: {
            tags: ["Teams"],
            summary: "Look up a player by player id, to add as a team member",
            description: "Mobile and aadhaar come back masked — only enough to confirm you found the right person.",
            security: auth,
            parameters: [{ name: "playerId", in: "path", required: true, description: "`users.player_id`.", schema: { type: "string", example: "SP-000123" } }],
            responses: {
                ...okEnvelope("Player found.", {
                    player: obj({
                        id: { type: "string", format: "uuid" },
                        player_id: { type: "string" },
                        name: { type: "string" },
                        age: { type: "string" },
                        mobile: { type: "string", description: "Masked, e.g. `••••••3210`." },
                        aadhaar: { type: "string", description: "Masked." },
                    }),
                }),
                ...errors(401, 404, 500),
            },
        },
    },

    "/api/teams/create": {
        post: {
            tags: ["Teams"],
            summary: "Create a team",
            description: "The caller becomes the captain.",
            security: auth,
            requestBody: jsonBody(
                obj(
                    {
                        team_name: { type: "string", example: "Vizag Smashers" },
                        sport: { type: "string", example: "volleyball" },
                        members: arrayOf("TeamMember"),
                    },
                    ["team_name", "sport"]
                )
            ),
            responses: { ...okEnvelope("Created.", { team: s("Team") }), ...errors(400, 401, 500) },
        },
    },

    "/api/teams/{id}": {
        put: {
            tags: ["Teams"],
            summary: "Update a team",
            description: "Captain only — anyone else gets 403.",
            security: auth,
            parameters: [idParam("`player_teams.id`.", "uuid")],
            requestBody: jsonBody(obj({ team_name: { type: "string" }, sport: { type: "string" }, members: arrayOf("TeamMember") })),
            responses: { ...okEnvelope("Updated.", { team: s("Team") }), ...errors(400, 401, 403, 404, 500) },
        },
        delete: {
            tags: ["Teams"],
            summary: "Delete a team",
            description: "Captain only. Refuses with 400 when the team is already used in a registration.",
            security: auth,
            parameters: [idParam("`player_teams.id`.", "uuid")],
            responses: { ...okEnvelope("Deleted."), ...errors(400, 401, 403, 404, 500) },
        },
    },

    /* ── payments ────────────────────────────────────────────────────────── */

    "/api/payment/create-razorpay-order": {
        post: {
            tags: ["Payments"],
            summary: "Create a Razorpay order for an event registration",
            description:
                "Player token only (admins get 403). The server recomputes the fee from the event's categories and rejects a mismatched `amount` with 400 — you cannot register cheaper by editing the request.",
            security: auth,
            requestBody: jsonBody(
                obj(
                    {
                        eventId: { oneOf: [{ type: "integer" }, { type: "string" }], example: 13 },
                        amount: { type: "number", description: "Rupees. Must match the server-side total.", example: 500 },
                        categories: {
                            type: "array",
                            description: "The categories being entered.",
                            items: { type: "object", additionalProperties: true },
                        },
                        teamMemberCount: { type: "integer", example: 5, description: "For per-head team pricing." },
                        teamId: { type: "string", format: "uuid", nullable: true },
                    },
                    ["eventId", "categories"]
                )
            ),
            responses: {
                ...okEnvelope("Order created — hand these to Razorpay Checkout.", {
                    order_id: { type: "string", example: "order_Q1a2B3c4D5" },
                    amount: { type: "integer", description: "**Paise**, as Razorpay returns it.", example: 50000 },
                    currency: { type: "string", example: "INR" },
                    key_id: { type: "string", example: "rzp_test_XXXXXXXX" },
                }),
                ...errors(400, 401, 403, 404, 500),
            },
        },
    },

    "/api/payment/verify-razorpay-payment": {
        post: {
            tags: ["Payments"],
            summary: "Verify the Razorpay callback and create the registration",
            description:
                "Checks the HMAC signature, that the order belongs to this user and this event, then writes the registration. Replaying a processed payment returns **409**; a payment Razorpay has not confirmed yet returns **202** with `pending: true` — poll `/order-status/{orderId}`.",
            security: auth,
            requestBody: jsonBody(
                obj(
                    {
                        razorpay_order_id: { type: "string", example: "order_Q1a2B3c4D5" },
                        razorpay_payment_id: { type: "string", example: "pay_Q1a2B3c4D5" },
                        razorpay_signature: { type: "string" },
                        eventId: { oneOf: [{ type: "integer" }, { type: "string" }] },
                        categories: { type: "array", items: { type: "object", additionalProperties: true } },
                        teamId: { type: "string", format: "uuid", nullable: true },
                    },
                    ["razorpay_order_id", "razorpay_payment_id", "razorpay_signature", "eventId", "categories"]
                )
            ),
            responses: {
                ...okEnvelope("Payment verified and registration recorded.", {
                    message: { type: "string", example: "Payment verified" },
                    registrationNo: { type: "string", example: "REG-2026-000451" },
                    paymentId: { type: "string" },
                }),
                202: { description: "Payment not confirmed by Razorpay yet — poll the order-status endpoint." },
                ...errors(400, 401, 403, 404, 409, 500),
            },
        },
    },

    "/api/payment/order-status/{orderId}": {
        get: {
            tags: ["Payments"],
            summary: "Reconcile an order whose browser callback never fired",
            description:
                "Recovery path for UPI app-switch and 3DS redirects. If Razorpay says the order is paid but nothing was recorded, this endpoint writes the registration and returns it with `recovered: true`. Orders belonging to another user report `not_found` rather than leaking their existence.",
            security: auth,
            parameters: [{ name: "orderId", in: "path", required: true, schema: { type: "string", example: "order_Q1a2B3c4D5" } }],
            responses: {
                ...okEnvelope("Order state.", {
                    status: { type: "string", enum: ["registered", "pending", "unpaid", "not_found"] },
                    registrationNo: { type: "string", nullable: true },
                    paymentId: { type: "string", nullable: true },
                    amount: { type: "number", nullable: true },
                    eventId: { type: "integer", nullable: true },
                    recovered: { type: "boolean", nullable: true, description: "True when this call is what recorded the registration." },
                }),
                ...errors(400, 401, 404, 500),
            },
        },
    },

    "/api/payment/submit-manual-payment": {
        post: {
            tags: ["Payments"],
            summary: "Submit a manual (UPI screenshot) payment",
            description: "For events on `payment_method: manual`. Creates a pending transaction an admin then verifies or rejects.",
            security: auth,
            requestBody: jsonBody(
                obj(
                    {
                        eventId: { oneOf: [{ type: "integer" }, { type: "string" }], example: 13 },
                        amount: { type: "number", example: 500 },
                        categories: { type: "array", items: { type: "object", additionalProperties: true } },
                        transactionId: { type: "string", description: "UPI/UTR reference typed by the player.", example: "412345678901" },
                        screenshot: { type: "string", description: "`data:image/...;base64,...` proof of payment. Required." },
                        document: { type: "string", nullable: true, description: "`data:` URL, when the event requires a document." },
                        teamId: { type: "string", format: "uuid", nullable: true },
                    },
                    ["eventId", "amount", "categories", "screenshot"]
                )
            ),
            responses: {
                ...okEnvelope("Submitted for verification.", {
                    message: { type: "string", example: "Payment submitted" },
                    transactionId: { type: "string", format: "uuid" },
                    registrationNo: { type: "string" },
                }),
                ...errors(400, 401, 403, 404, 500),
            },
        },
    },

    "/api/payment/receipt/{registrationNo}": {
        get: {
            tags: ["Payments"],
            summary: "Download the registration receipt PDF",
            description: "Owner-only — the same PDF that goes out over email and WhatsApp.",
            security: auth,
            parameters: [{ name: "registrationNo", in: "path", required: true, schema: { type: "string", example: "REG-2026-000451" } }],
            responses: {
                200: { description: "PDF bytes.", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } },
                ...errors(400, 401, 404, 500),
            },
        },
    },

    /* ── notifications ───────────────────────────────────────────────────── */

    "/api/notifications": {
        get: {
            tags: ["Notifications"],
            summary: "Notifications for the signed-in user",
            description: "Any authenticated role.",
            security: auth,
            responses: { ...okEnvelope("Notifications.", { notifications: arrayOf("Notification") }), ...errors(401, 500) },
        },
    },

    "/api/notifications/mark-read": {
        post: {
            tags: ["Notifications"],
            summary: "Mark one notification, or all of them, as read",
            security: auth,
            requestBody: jsonBody(
                obj({
                    notificationId: { type: "string", format: "uuid", description: "Mark just this one." },
                    markAll: { type: "boolean", description: "Mark every unread notification for this user." },
                })
            ),
            responses: { ...okEnvelope("Marked."), ...errors(400, 401, 500) },
        },
    },

    /* ── institute head ──────────────────────────────────────────────────── */

    "/api/institute/profile": {
        put: {
            tags: ["Institute"],
            summary: "Update the institute profile",
            security: auth,
            requestBody: jsonBody(
                obj(
                    {
                        instituteName: { type: "string", example: "St. Xavier High School" },
                        email: { type: "string", format: "email" },
                        contactNumber: { type: "string", description: "Exactly 10 digits.", example: "9876543212" },
                        website: { type: "string" },
                        address: { type: "string" },
                    },
                    ["instituteName", "email", "contactNumber"]
                )
            ),
            responses: { ...okEnvelope("Updated.", { user: s("User") }), ...errors(400, 401, 403, 409, 500) },
        },
    },

    "/api/institute/request-bulk-approval": {
        post: {
            tags: ["Institute"],
            summary: "Ask an admin to approve a bulk student import",
            description: "Step 1 of bulk import. Nothing can be imported until an admin approves this request.",
            security: auth,
            requestBody: jsonBody(obj({ student_count: { type: "integer", minimum: 1, example: 120 } }, ["student_count"])),
            responses: { ...okEnvelope("Request submitted."), ...errors(400, 401, 403, 404, 500) },
        },
    },

    "/api/institute/approval-status": {
        get: {
            tags: ["Institute"],
            summary: "Check the bulk-import approval state",
            description: "`is_approved: null` means there is no open request.",
            security: auth,
            responses: {
                ...okEnvelope("Approval state.", { is_approved: { type: "boolean", nullable: true }, message: { type: "string", nullable: true } }),
                ...errors(401, 403, 500),
            },
        },
    },

    "/api/institute/cancel-approval": {
        delete: {
            tags: ["Institute"],
            summary: "Withdraw a pending bulk-import request",
            security: auth,
            responses: { ...okEnvelope("Cancelled."), ...errors(401, 403, 500) },
        },
    },

    "/api/institute/bulk-import-finalize": {
        post: {
            tags: ["Institute"],
            summary: "Import students from an Excel sheet",
            description:
                "Step 3 — only works once the request is approved (otherwise 403). Rows that fail validation are reported in `results.failed`; the rest are created. The approval record is consumed, so a second import needs a fresh request.",
            security: auth,
            requestBody: jsonBody(
                obj({ excelBase64: { type: "string", description: "Base64 of the .xlsx file (with or without the `data:` prefix)." } }, ["excelBase64"])
            ),
            responses: {
                ...okEnvelope("Import finished — check `results.failed`.", {
                    message: { type: "string" },
                    results: obj({
                        successful: { type: "array", items: { type: "object", additionalProperties: true } },
                        failed: {
                            type: "array",
                            items: obj({ row: { type: "integer" }, reason: { type: "string" } }),
                        },
                    }),
                }),
                ...errors(400, 401, 403, 500),
            },
        },
    },

    "/api/institute/approved-players": {
        get: {
            tags: ["Institute"],
            summary: "Students belonging to this institute",
            security: auth,
            responses: { ...okEnvelope("Players.", { players: arrayOf("User") }), ...errors(401, 403, 404, 500) },
        },
    },

    /* ── contact ─────────────────────────────────────────────────────────── */

    "/api/contact/send": {
        post: {
            tags: ["Contact"],
            summary: "Submit a contact / enquiry form",
            description:
                "Unauthenticated. Field caps: name 100, email 254, phone exactly 10 digits, subject 50, message 1000. An unrecognised `source` is coerced to `website` rather than rejected.",
            requestBody: jsonBody(
                obj(
                    {
                        name: { type: "string", example: "Arjun Kumar" },
                        email: { type: "string", format: "email" },
                        phone: { type: "string", example: "9876543210" },
                        subject: { type: "string", example: "Registration query" },
                        message: { type: "string", example: "How do I add a team member?" },
                        source: { type: "string", enum: ["website", "institute"], default: "website" },
                    },
                    ["name", "email", "message"]
                )
            ),
            responses: { ...okEnvelope("Message stored and emailed."), ...errors(400, 500) },
        },
    },

    "/api/contact": {
        get: {
            tags: ["Contact"],
            summary: "List contact messages",
            description: "Admin only. Newest first.",
            security: auth,
            responses: { ...okEnvelope("Messages.", { messages: arrayOf("ContactMessage") }), ...errors(401, 403, 500) },
        },
    },

    "/api/contact/{id}/status": {
        put: {
            tags: ["Contact"],
            summary: "Change a message's status",
            security: auth,
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", format: "int64" } }],
            requestBody: jsonBody(obj({ status: { type: "string", enum: ["pending", "read", "resolved"] } }, ["status"])),
            responses: { ...okEnvelope("Updated."), ...errors(400, 401, 403, 404, 500) },
        },
    },

    /* ── apartments (unauthenticated) ────────────────────────────────────── */

    "/api/apartments": {
        get: {
            tags: ["Apartments"],
            summary: "List apartments",
            description: "Unauthenticated — the registration form's apartment picker reads this.",
            parameters: [p("Search"), p("Page"), p("Limit")],
            responses: { ...okEnvelope("Apartments.", { apartments: arrayOf("Apartment"), total_count: { type: "integer" } }), ...errors(500) },
        },
        post: {
            tags: ["Apartments"],
            summary: "Add an apartment",
            description: "⚠️ Unauthenticated in the current build — anyone who can reach the API can write here.",
            requestBody: jsonBody(
                obj(
                    { name: { type: "string", example: "Green Meadows" }, pincode: { type: "string", example: "530018" }, locality: { type: "string" }, zone: { type: "string" } },
                    ["name"]
                )
            ),
            responses: { ...okEnvelope("Created.", { apartment: s("Apartment") }), ...errors(400, 500) },
        },
    },

    "/api/apartments/{id}": {
        put: {
            tags: ["Apartments"],
            summary: "Update an apartment",
            parameters: [idParam("`apartments.id`.", "uuid")],
            requestBody: jsonBody(obj({ name: { type: "string" }, pincode: { type: "string" }, locality: { type: "string" }, zone: { type: "string" } })),
            responses: { ...okEnvelope("Updated.", { apartment: s("Apartment") }), ...errors(400, 404, 500) },
        },
        delete: {
            tags: ["Apartments"],
            summary: "Delete an apartment",
            parameters: [idParam("`apartments.id`.", "uuid")],
            responses: { ...okEnvelope("Deleted."), ...errors(404, 500) },
        },
    },

    "/api/apartments/migrate": {
        post: {
            tags: ["Apartments"],
            summary: "Seed the apartments table from the bundled list",
            description: "One-off data-load helper. Idempotent, but there is rarely a reason to call it outside first-time setup.",
            responses: { ...okEnvelope("Migrated.", { inserted: { type: "integer" } }), ...errors(500) },
        },
    },

    /* ── advertisements ──────────────────────────────────────────────────── */

    "/api/advertisements": {
        get: {
            tags: ["Advertisements"],
            summary: "List advertisements",
            description: "Unauthenticated — the public site renders these.",
            parameters: [p("Page"), p("Limit")],
            responses: { ...okEnvelope("Advertisements.", { advertisements: arrayOf("Advertisement"), total_count: { type: "integer" } }), ...errors(500) },
        },
        post: {
            tags: ["Advertisements"],
            summary: "Create an advertisement",
            security: auth,
            requestBody: jsonBody(
                obj(
                    {
                        title: { type: "string", example: "Summer Camp 2026" },
                        image: { type: "string", description: "`data:image/...;base64,...` — uploaded and stored as `image_url`." },
                        linkUrl: { type: "string", example: "https://example.com/camp" },
                        placement: { type: "string", example: "home-banner" },
                        isActive: { type: "boolean", default: true },
                    },
                    ["title", "image", "placement"]
                )
            ),
            responses: { ...okEnvelope("Created.", { advertisement: s("Advertisement") }), ...errors(400, 401, 403, 500) },
        },
    },

    "/api/advertisements/{id}": {
        put: {
            tags: ["Advertisements"],
            summary: "Update an advertisement",
            security: auth,
            parameters: [idParam("`advertisements.id`.", "uuid")],
            requestBody: jsonBody(
                obj({ title: { type: "string" }, image: { type: "string" }, linkUrl: { type: "string" }, placement: { type: "string" }, isActive: { type: "boolean" } })
            ),
            responses: { ...okEnvelope("Updated.", { advertisement: s("Advertisement") }), ...errors(400, 401, 403, 404, 500) },
        },
        delete: {
            tags: ["Advertisements"],
            summary: "Delete an advertisement",
            security: auth,
            parameters: [idParam("`advertisements.id`.", "uuid")],
            responses: { ...okEnvelope("Deleted."), ...errors(401, 403, 404, 500) },
        },
    },

    "/api/advertisements/{id}/toggle": {
        patch: {
            tags: ["Advertisements"],
            summary: "Activate / deactivate an advertisement",
            security: auth,
            parameters: [idParam("`advertisements.id`.", "uuid")],
            requestBody: jsonBody(obj({ isActive: { type: "boolean" } }, ["isActive"])),
            responses: { ...okEnvelope("Toggled.", { advertisement: s("Advertisement") }), ...errors(400, 401, 403, 404, 500) },
        },
    },
};
