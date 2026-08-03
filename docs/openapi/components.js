/**
 * Reusable OpenAPI pieces: security schemes, entity schemas, common
 * parameters and canned responses.
 *
 * Schemas mirror the Railway Postgres tables (see qa_schema.csv at the repo
 * root) plus the extra fields the controllers graft on before responding —
 * `public_id` on events, `assigned_admins` on an event detail, and so on.
 */

/* ── canned error bodies ─────────────────────────────────────────────────── */

const errorRef = (description) => ({
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
});

export const commonResponses = {
    BadRequest: errorRef("Validation failed — a required field is missing or malformed."),
    Unauthorized: errorRef("Missing or expired token."),
    Forbidden: errorRef("Token is valid but the role is not allowed on this route."),
    NotFound: errorRef("The requested record does not exist."),
    Conflict: errorRef("The request collides with existing data (duplicate email/mobile, already-processed payment, …)."),
    ServerError: errorRef("Unhandled server error."),
};

/** Attach the standard error set to an operation without repeating it. */
export const errors = (...codes) =>
    Object.fromEntries(
        codes.map((code) => {
            const name = {
                400: "BadRequest",
                401: "Unauthorized",
                403: "Forbidden",
                404: "NotFound",
                409: "Conflict",
                500: "ServerError",
            }[code];
            return [String(code), { $ref: `#/components/responses/${name}` }];
        })
    );

/** Shorthand for a 200 with an inline JSON schema. */
export const ok = (description, schema) => ({
    200: { description, content: { "application/json": { schema } } },
});

/** Shorthand for `{ success: true, ...extra }`. */
export const okEnvelope = (description, extra = {}) =>
    ok(description, {
        type: "object",
        properties: { success: { type: "boolean", example: true }, ...extra },
    });

/* ── reusable parameters ─────────────────────────────────────────────────── */

export const parameters = {
    Page: {
        name: "page",
        in: "query",
        description: "1-based page number. Pagination only applies when both `page` and `limit` are sent.",
        schema: { type: "integer", minimum: 1, example: 1 },
    },
    Limit: {
        name: "limit",
        in: "query",
        description: "Rows per page.",
        schema: { type: "integer", minimum: 1, maximum: 200, example: 20 },
    },
    Search: {
        name: "search",
        in: "query",
        description: "Case-insensitive substring match.",
        schema: { type: "string", example: "volleyball" },
    },
    EventIdPath: {
        name: "id",
        in: "path",
        required: true,
        description:
            "Event identifier. Accepts the numeric `id` (e.g. `13`) **or** the public id (e.g. `evt_53812ba99536`).",
        schema: { type: "string", example: "13" },
    },
    CategoryIdPath: {
        name: "categoryId",
        in: "path",
        required: true,
        description: "Category id from `events.categories[].id`.",
        schema: { type: "string", example: "1772700031582" },
    },
    CategoryLabelQuery: {
        name: "categoryLabel",
        in: "query",
        description:
            "Alternative to `categoryId` on the `/categories/...` variants of a route — the human label, e.g. `Above 17 Mixed`.",
        schema: { type: "string" },
    },
    VerificationTokenHeader: {
        name: "x-verification-token",
        in: "header",
        required: true,
        description:
            "Short-lived token returned by `POST /api/auth/verify-verification-otp`. Required before a player may change email/mobile or password.",
        schema: { type: "string" },
    },
};

/* ── entity schemas ──────────────────────────────────────────────────────── */

export const schemas = {
    ErrorResponse: {
        type: "object",
        description:
            "Error shape. Most handlers return `message`; a few also set `success: false`, and validation helpers may add `code`.",
        properties: {
            success: { type: "boolean", example: false },
            message: { type: "string", example: "Invalid credentials" },
            error: { type: "string", description: "Used by a handful of older handlers instead of `message`." },
            code: { type: "string", example: "FILE_TOO_LARGE" },
        },
    },

    SuccessMessage: {
        type: "object",
        properties: {
            success: { type: "boolean", example: true },
            message: { type: "string", example: "Saved" },
        },
    },

    /* ── users ───────────────────────────────────────────────────────────── */

    User: {
        type: "object",
        description: "`users` row. `password` is never serialised.",
        properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string", example: "Arjun Kumar" },
            first_name: { type: "string", example: "Arjun" },
            last_name: { type: "string", example: "Kumar" },
            email: { type: "string", format: "email", nullable: true },
            mobile: { type: "string", example: "9876543210", nullable: true },
            role: {
                type: "string",
                enum: ["player", "admin", "superadmin", "institutehead"],
                example: "player",
            },
            verification: {
                type: "string",
                nullable: true,
                enum: ["pending", "approved", "rejected", null],
                description: "Admin/institute approval state. Players leave this null.",
            },
            player_id: { type: "string", nullable: true, example: "SP-000123" },
            aadhaar: { type: "string", nullable: true },
            dob: { type: "string", format: "date", nullable: true, example: "2005-04-11" },
            age: { type: "integer", nullable: true, description: "Recomputed from `dob` on read — do not trust the stored column." },
            gender: { type: "string", nullable: true, enum: ["Male", "Female", "Other", null] },
            apartment: { type: "string", nullable: true },
            street: { type: "string", nullable: true },
            city: { type: "string", nullable: true },
            state: { type: "string", nullable: true },
            pincode: { type: "string", nullable: true },
            country: { type: "string", nullable: true, example: "India" },
            photos: { type: "string", nullable: true, description: "Profile photo URL." },
            avatar: { type: "string", nullable: true },
            google_id: { type: "string", nullable: true },
            institute_name: { type: "string", nullable: true },
            website: { type: "string", nullable: true },
            last_login: { type: "string", format: "date-time", nullable: true },
            previous_login: { type: "string", format: "date-time", nullable: true },
            created_at: { type: "string", format: "date-time" },
        },
    },

    AuthUser: {
        type: "object",
        description: "Trimmed user object returned by the login/register endpoints.",
        properties: {
            id: { type: "string", format: "uuid" },
            firstName: { type: "string" },
            lastName: { type: "string" },
            role: { type: "string", example: "player" },
            photos: { type: "string", nullable: true },
            dob: { type: "string", format: "date", nullable: true },
            gender: { type: "string", nullable: true },
            age: { type: "integer", nullable: true },
        },
    },

    AuthSuccess: {
        type: "object",
        description: "Paste `token` into the **Authorize** box at the top of this page to call the protected routes.",
        properties: {
            success: { type: "boolean", example: true },
            token: { type: "string", description: "Signed JWT. Player tokens last 7d, admin tokens 30d." },
            playerId: { type: "string", nullable: true, description: "Only on register-player." },
            user: { $ref: "#/components/schemas/AuthUser" },
        },
    },

    /* ── events ──────────────────────────────────────────────────────────── */

    EventCategory: {
        type: "object",
        description: "One entry of the `events.categories` JSONB array.",
        properties: {
            id: { type: "string", example: "1772700031582", description: "Client-generated, usually an epoch-ms string." },
            category: { type: "string", example: "Above 17" },
            gender: { type: "string", example: "Mixed", enum: ["Male", "Female", "Mixed"] },
            format: { type: "string", example: "KNOCKOUT", enum: ["KNOCKOUT", "LEAGUE"] },
            matchType: { type: "string", example: "Team", enum: ["Single", "Double", "Team"] },
            entryFee: { type: "string", example: "500", description: "Sent as a string by the admin UI. `0` means a free category." },
            openings: { type: "string", example: "16" },
            minTeamSize: { type: "string", nullable: true, example: "3" },
            maxTeamSize: { type: "string", nullable: true, example: "7" },
            lastDateToRegister: { type: "string", format: "date", example: "2026-03-09" },
            customFields: { type: "array", items: { type: "object", additionalProperties: true } },
        },
    },

    Sponsor: {
        type: "object",
        properties: {
            name: { type: "string" },
            logo: {
                type: "string",
                description: "On write: a `data:` base64 URL (it gets uploaded). On read: the stored file URL.",
            },
            tier: { type: "string", nullable: true },
            website: { type: "string", nullable: true },
            mediaItems: {
                type: "array",
                items: { type: "object", properties: { url: { type: "string" }, type: { type: "string" } } },
            },
        },
    },

    Event: {
        type: "object",
        properties: {
            id: { type: "integer", format: "int64", example: 13 },
            public_id: { type: "string", example: "evt_53812ba99536", description: "Shareable id used in public URLs." },
            name: { type: "string", example: "Volleyball Premier League" },
            sport: { type: "string", example: "volleyball" },
            status: { type: "string", enum: ["upcoming", "ongoing", "completed", "cancelled"], example: "upcoming" },
            event_format_type: { type: "string", nullable: true, example: "KNOCKOUT" },
            start_date: { type: "string", format: "date", example: "2026-03-10" },
            end_date: { type: "string", format: "date", nullable: true },
            start_time: { type: "string", example: "16:00:00" },
            location: { type: "string", example: "Visakhapatnam" },
            venue: { type: "string", nullable: true },
            city: { type: "string", nullable: true },
            state: { type: "string", nullable: true },
            pincode: { type: "string", nullable: true },
            google_map_link: { type: "string", nullable: true },
            categories: { type: "array", items: { $ref: "#/components/schemas/EventCategory" } },
            sponsors: { type: "array", items: { $ref: "#/components/schemas/Sponsor" } },
            banner_url: { type: "string", nullable: true },
            qr_code: { type: "string", nullable: true, description: "Auto-generated share QR pointing at the public event page." },
            document_url: { type: "string", nullable: true },
            document_description: { type: "string", nullable: true },
            is_document_required: { type: "boolean" },
            show_slots: { type: "boolean" },
            payment_method: { type: "string", enum: ["manual", "razorpay"], example: "manual" },
            payment_gateway: { type: "string", enum: ["manual", "razorpay"], example: "manual" },
            payment_qr_image: { type: "string", nullable: true },
            upi_id: { type: "string", nullable: true },
            created_by: { type: "string", format: "uuid", nullable: true },
            assigned_to: { type: "string", format: "uuid", nullable: true, description: "Primary assigned admin (first of `assigned_admin_ids`)." },
            assigned_by: { type: "string", format: "uuid", nullable: true },
            assigned_admin_ids: { type: "array", items: { type: "string", format: "uuid" } },
            assigned_admins: { type: "array", items: { $ref: "#/components/schemas/User" } },
            event_registrations: {
                type: "array",
                description: "Postgrest aggregate — `[{ count: n }]`.",
                items: { type: "object", properties: { count: { type: "integer" } } },
            },
            created_at: { type: "string", format: "date-time" },
        },
    },

    EventWriteRequest: {
        type: "object",
        description:
            "Any `events` column may be sent — unlisted keys are passed straight through to the insert/update. Image fields accept `data:` base64 URLs and are uploaded to the bucket server-side.",
        required: ["name", "sport", "start_date"],
        properties: {
            name: { type: "string", example: "QA Smoke Test Event" },
            sport: { type: "string", example: "volleyball" },
            start_date: { type: "string", format: "date", example: "2026-09-01" },
            end_date: { type: "string", format: "date", example: "2026-09-03" },
            start_time: { type: "string", example: "16:00:00" },
            location: { type: "string", example: "Visakhapatnam" },
            venue: { type: "string", example: "Sports Arena" },
            city: { type: "string", example: "Visakhapatnam" },
            state: { type: "string", example: "Andhra Pradesh" },
            pincode: { type: "string", example: "530018" },
            google_map_link: { type: "string" },
            categories: { type: "array", items: { $ref: "#/components/schemas/EventCategory" } },
            sponsors: { type: "array", items: { $ref: "#/components/schemas/Sponsor" } },
            banner_image: { type: "string", description: "`data:image/...;base64,...` — uploaded, stored as `banner_url`." },
            document_file: { type: "string", description: "`data:application/pdf;base64,...` — uploaded, stored as `document_url`." },
            document_url: { type: "string", description: "Used verbatim when `document_file` is absent." },
            payment_qr_image: { type: "string", description: "`data:` URL or existing URL." },
            payment_method: { type: "string", enum: ["manual", "razorpay"] },
            payment_gateway: { type: "string", enum: ["manual", "razorpay"] },
            upi_id: { type: "string" },
            is_document_required: { type: "boolean" },
            show_slots: { type: "boolean" },
            status: { type: "string", enum: ["upcoming", "ongoing", "completed", "cancelled"] },
            assigned_admin_ids: {
                type: "array",
                items: { type: "string", format: "uuid" },
                description: "Full assignment list. The first id also lands in `assigned_to`.",
            },
            assigned_to: { type: "string", format: "uuid", description: "Legacy single-admin field; used only when `assigned_admin_ids` is absent." },
        },
    },

    /* ── registrations & money ───────────────────────────────────────────── */

    Registration: {
        type: "object",
        properties: {
            id: { type: "string", format: "uuid" },
            registration_no: { type: "string", nullable: true, example: "REG-2026-000451" },
            event_id: { type: "integer", format: "int64" },
            player_id: { type: "string", format: "uuid", nullable: true },
            team_id: { type: "string", format: "uuid", nullable: true },
            transaction_id: { type: "string", format: "uuid", nullable: true },
            categories: { type: "array", items: { type: "object", additionalProperties: true } },
            amount_paid: { type: "number", format: "double", nullable: true },
            payment_mode: { type: "string", enum: ["manual", "razorpay"], example: "manual" },
            manual_transaction_id: { type: "string", nullable: true },
            screenshot_url: { type: "string", nullable: true },
            document_url: { type: "string", nullable: true },
            status: {
                type: "string",
                enum: ["registered", "pending", "verified", "rejected"],
                example: "registered",
            },
            created_at: { type: "string", format: "date-time" },
        },
    },

    Transaction: {
        type: "object",
        properties: {
            id: { type: "string", format: "uuid" },
            user_id: { type: "string", format: "uuid", nullable: true },
            amount: { type: "number", format: "double", nullable: true },
            currency: { type: "string", example: "INR" },
            payment_mode: { type: "string", enum: ["manual", "razorpay"] },
            order_id: { type: "string", nullable: true, example: "order_Q1a2B3c4D5" },
            payment_id: { type: "string", nullable: true, example: "pay_Q1a2B3c4D5" },
            razorpay_signature: { type: "string", nullable: true },
            manual_transaction_id: { type: "string", nullable: true },
            screenshot_url: { type: "string", nullable: true },
            created_at: { type: "string", format: "date-time" },
        },
    },

    /* ── teams ───────────────────────────────────────────────────────────── */

    TeamMember: {
        type: "object",
        properties: {
            id: { type: "string", format: "uuid", nullable: true },
            player_id: { type: "string", nullable: true, example: "SP-000123" },
            name: { type: "string" },
            mobile: { type: "string", nullable: true },
        },
    },

    Team: {
        type: "object",
        properties: {
            id: { type: "string", format: "uuid" },
            team_name: { type: "string", example: "Vizag Smashers" },
            sport: { type: "string", example: "volleyball" },
            captain_id: { type: "string", format: "uuid" },
            captain_name: { type: "string", nullable: true },
            captain_mobile: { type: "string", nullable: true },
            members: { type: "array", items: { $ref: "#/components/schemas/TeamMember" } },
            status: { type: "string", example: "active" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
        },
    },

    /* ── draws, brackets, leagues, matches ───────────────────────────────── */

    Bracket: {
        type: "object",
        description: "`event_brackets` row — one per event × category × round.",
        properties: {
            id: { type: "string", format: "uuid" },
            event_id: { type: "integer", format: "int64" },
            category: { type: "string", description: "Category label." },
            category_id: { type: "string", format: "uuid", nullable: true },
            round_name: { type: "string", example: "Round 1" },
            mode: { type: "string", enum: ["MEDIA", "BRACKET"], example: "BRACKET" },
            draw_type: { type: "string", nullable: true },
            draw_data: { type: "object", nullable: true, additionalProperties: true },
            bracket_data: { type: "object", additionalProperties: true },
            round_structure: { type: "array", items: { type: "object", additionalProperties: true } },
            media_urls: { type: "array", items: { type: "object", additionalProperties: true } },
            pdf_url: { type: "string", nullable: true },
            published: { type: "boolean" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
        },
    },

    BracketPlayer: {
        type: "object",
        description: "A slot in a bracket match. `null`/`{}` means an empty slot; `isBye: true` marks a BYE.",
        properties: {
            id: { type: "string", nullable: true },
            name: { type: "string", nullable: true, example: "Arjun Kumar" },
            player_id: { type: "string", nullable: true },
            rank: { type: "integer", nullable: true },
            isBye: { type: "boolean" },
        },
    },

    Match: {
        type: "object",
        description: "`matches` row. Note `event_id`/`category_id`/`bracket_id` are stored as text.",
        properties: {
            id: { type: "string", format: "uuid" },
            event_id: { type: "string", example: "13" },
            category_id: { type: "string", example: "1772700031582" },
            bracket_id: { type: "string" },
            bracket_match_id: { type: "string", nullable: true },
            round_name: { type: "string", example: "Quarter Final" },
            match_index: { type: "integer", example: 0 },
            player_a: { $ref: "#/components/schemas/BracketPlayer" },
            player_b: { $ref: "#/components/schemas/BracketPlayer" },
            score: {
                type: "object",
                additionalProperties: true,
                description: "Sport-specific. Typically `{ sets: [{ a: 21, b: 18 }, …] }` or `{ a: 3, b: 1 }`.",
                example: { sets: [{ a: 21, b: 18 }, { a: 19, b: 21 }, { a: 15, b: 12 }] },
            },
            winner: { $ref: "#/components/schemas/BracketPlayer" },
            status: {
                type: "string",
                enum: ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"],
                example: "SCHEDULED",
            },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
        },
    },

    LeagueParticipant: {
        type: "object",
        properties: {
            id: { type: "string" },
            name: { type: "string" },
            player_id: { type: "string", nullable: true },
            team_id: { type: "string", nullable: true },
        },
    },

    League: {
        type: "object",
        properties: {
            id: { type: "string", format: "uuid" },
            event_id: { type: "integer", format: "int64" },
            category_id: { type: "string", nullable: true },
            category_label: { type: "string" },
            participants: { type: "array", items: { $ref: "#/components/schemas/LeagueParticipant" } },
            rules: {
                type: "object",
                properties: {
                    pointsWin: { type: "integer", example: 3 },
                    pointsDraw: { type: "integer", example: 1 },
                    pointsLoss: { type: "integer", example: 0 },
                },
                additionalProperties: true,
            },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
        },
    },

    /* ── misc ────────────────────────────────────────────────────────────── */

    Notification: {
        type: "object",
        properties: {
            id: { type: "string", format: "uuid" },
            user_id: { type: "string", format: "uuid" },
            title: { type: "string" },
            message: { type: "string" },
            type: { type: "string", example: "info" },
            link: { type: "string", nullable: true },
            is_read: { type: "boolean" },
            created_at: { type: "string", format: "date-time" },
        },
    },

    Advertisement: {
        type: "object",
        properties: {
            id: { type: "string", format: "uuid" },
            title: { type: "string" },
            image_url: { type: "string" },
            link_url: { type: "string", nullable: true },
            placement: { type: "string", example: "home-banner" },
            is_active: { type: "boolean" },
            user_id: { type: "string", format: "uuid" },
            created_at: { type: "string", format: "date-time" },
        },
    },

    Apartment: {
        type: "object",
        properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string", example: "Green Meadows" },
            pincode: { type: "string", nullable: true, example: "530018" },
            locality: { type: "string", nullable: true },
            zone: { type: "string", nullable: true },
            created_at: { type: "string", format: "date-time" },
        },
    },

    ContactMessage: {
        type: "object",
        properties: {
            id: { type: "integer", format: "int64" },
            name: { type: "string" },
            email: { type: "string", format: "email" },
            phone: { type: "string", nullable: true },
            subject: { type: "string", nullable: true },
            message: { type: "string", nullable: true },
            status: { type: "string", enum: ["pending", "read", "resolved"], example: "pending" },
            created_at: { type: "string", format: "date-time" },
        },
    },

    EventNews: {
        type: "object",
        properties: {
            id: { type: "string", format: "uuid" },
            event_id: { type: "integer", format: "int64", nullable: true },
            title: { type: "string" },
            content: { type: "string", nullable: true },
            image_url: { type: "string", nullable: true },
            is_highlight: { type: "boolean" },
            created_at: { type: "string", format: "date-time" },
        },
    },

    PlatformSettings: {
        type: "object",
        properties: {
            id: { type: "integer" },
            platform_name: { type: "string", example: "Sports Paramount" },
            support_email: { type: "string", format: "email" },
            support_phone: { type: "string" },
            logo_url: { type: "string", nullable: true },
            logo_size: { type: "integer", example: 64 },
            registration_config: {
                type: "object",
                properties: {
                    showSchool: { type: "boolean" },
                    showStreet: { type: "boolean" },
                    showApartment: { type: "boolean" },
                },
                additionalProperties: true,
            },
            updated_at: { type: "string", format: "date-time" },
        },
    },

    AdminPermissions: {
        type: "object",
        properties: {
            admin_id: { type: "string", format: "uuid" },
            permit: { type: "boolean" },
            apartments: { type: "boolean" },
            advertisements: { type: "boolean" },
            broadcast: { type: "boolean" },
            reports: { type: "boolean" },
            updated_at: { type: "string", format: "date-time" },
            updated_by: { type: "string", format: "uuid", nullable: true },
        },
    },

    BroadcastRecipient: {
        type: "object",
        properties: {
            key: { type: "string", description: "Stable id for this recipient — pass back in `audience.keys` to narrow the send." },
            name: { type: "string" },
            mobile: { type: "string" },
            source: { type: "string", example: "registration" },
        },
    },

    Broadcast: {
        type: "object",
        description: "`broadcast_logs` row.",
        properties: {
            id: { type: "string", format: "uuid" },
            title: { type: "string" },
            message: { type: "string" },
            image_url: { type: "string", nullable: true },
            recipient_type: { type: "string", example: "all" },
            target_count: { type: "integer" },
            success_count: { type: "integer" },
            failure_count: { type: "integer" },
            meta: { type: "object", additionalProperties: true, description: "Per-recipient delivery state, channels, event/category filters." },
            created_at: { type: "string", format: "date-time" },
        },
    },

    PlayerUpload: {
        type: "object",
        properties: {
            id: { type: "string", format: "uuid" },
            player_id: { type: "string", format: "uuid" },
            file_name: { type: "string" },
            file_url: { type: "string" },
            file_type: { type: "string", enum: ["image", "video"] },
            mime_type: { type: "string", nullable: true },
            file_size: { type: "integer", nullable: true, description: "Bytes." },
            created_at: { type: "string", format: "date-time" },
        },
    },

    InstituteApproval: {
        type: "object",
        properties: {
            id: { type: "string", format: "uuid" },
            institute_id: { type: "string", format: "uuid" },
            institute_name: { type: "string" },
            student_count: { type: "integer" },
            is_approved: { type: "boolean" },
            is_rejected: { type: "boolean" },
            approved_by: { type: "string", format: "uuid", nullable: true },
            rejected_by: { type: "string", format: "uuid", nullable: true },
            rejection_remark: { type: "string", nullable: true },
            created_at: { type: "string", format: "date-time" },
        },
    },
};

export const securitySchemes = {
    bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: [
            "Backend-signed JWT sent as `Authorization: Bearer <token>`.",
            "",
            "There is one scheme but four audiences, and routes check the `role` claim:",
            "",
            "| Role | Get a token from | Reaches |",
            "|---|---|---|",
            "| `player` | `POST /api/auth/login` | `/api/player/*`, `/api/teams/*`, `/api/payment/*` |",
            "| `admin` / `superadmin` | `POST /api/auth/login-admin` | `/api/admin/*`, event writes, `/api/contact` |",
            "| `institutehead` | `POST /api/auth/login-institute` | `/api/institute/*` |",
            "",
            "A player token on an admin route returns **403**, not 401.",
        ].join("\n"),
    },
};
