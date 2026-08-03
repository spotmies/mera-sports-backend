/**
 * OpenAPI 3.0 description of the Mera Sports / Sports Paramount API.
 *
 * Hand-written rather than generated: the routes carry no annotations, and a
 * spec the QA team can read beats one that merely enumerates handlers.
 *
 * Keeping it honest when routes change:
 *   node scripts/check_openapi_coverage.mjs
 * fails if a mounted Express route has no entry here (or vice versa).
 */

import { commonResponses, parameters, schemas, securitySchemes } from "./components.js";
import { adminPaths } from "./paths/admin.js";
import { authPaths } from "./paths/auth.js";
import { eventPaths } from "./paths/events.js";
import { playerPaths } from "./paths/player.js";
import { tournamentPaths } from "./paths/tournament.js";

const DESCRIPTION = `
QA reference for the Sports Paramount backend. **This page is served on QA only** — it is off by default and refuses to start when live payment keys are present.

### Getting a token in 30 seconds
1. Call **Auth → \`POST /api/auth/login\`** (player) or **\`POST /api/auth/login-admin\`** (admin).
2. Copy \`token\` from the response.
3. Click **Authorize** (top right), paste the token, **Authorize**, **Close**.
4. Every 🔒 endpoint now sends \`Authorization: Bearer <token>\` for you.

One token type does not open another's doors — a player token on an admin route returns **403**, not 401.

### Things worth knowing before you file a bug
- **Event ids are dual.** Anywhere the path says \`{id}\` for an event you may send the numeric \`id\` (\`13\`) or the public id (\`evt_53812ba99536\`).
- **Categories are addressed two ways.** Most draw routes exist twice: \`/categories/{categoryId}/…\` and \`/categories/…?categoryLabel=…\`. Same handler, both documented.
- **Images go in as base64.** Fields like \`banner_image\`, \`photos\`, \`screenshot\` and \`image\` take a \`data:image/...;base64,...\` string; the server uploads to the bucket and stores the URL.
- **Reads are cached.** The events list, event detail, player dashboard and public settings come from Redis. A write you just made should invalidate it — if a GET looks stale, that is worth reporting.
- **Money is validated server-side.** \`create-razorpay-order\` recomputes the fee and rejects a mismatched \`amount\` with 400.
- **Error shape is not uniform.** Most handlers return \`{ message }\`, some add \`success: false\`, a few older ones use \`error\`. Treat any non-2xx as a failure and read both keys.

### Safe to run against QA?
Green (GET) endpoints are read-only. Destructive ones are called out in their descriptions — \`DELETE /api/player/delete-account\`, \`DELETE /api/events/{id}\`, \`DELETE /api/admin/matches/category/{eventId}\` and the broadcast send, which really does message people. QA WhatsApp and Razorpay are on test credentials, but the broadcast audience is real QA data.
`.trim();

const tags = [
    { name: "Auth", description: "OTP, registration, login, session restore. Start here." },
    { name: "Public", description: "Unauthenticated reads the public site uses." },
    { name: "Events", description: "Event CRUD plus the public event reads." },
    { name: "Player", description: "Player dashboard, profile and media. Player token." },
    { name: "Teams", description: "Team creation and membership." },
    { name: "Payments", description: "Razorpay orders, manual payments, receipts, reconciliation." },
    { name: "Notifications", description: "In-app notifications for any signed-in user." },
    { name: "Institute", description: "Institute-head area, including bulk student import." },
    { name: "Contact", description: "Enquiry form and its admin inbox." },
    { name: "Apartments", description: "Apartment master data for the registration form." },
    { name: "Advertisements", description: "Promo banners on the public site." },
    { name: "Admin · Accounts", description: "Admin approval, roles, event assignment." },
    { name: "Admin · Permissions", description: "Per-admin feature flags. Mostly superadmin-only." },
    { name: "Admin · Dashboard", description: "Headline stats and generic asset upload." },
    { name: "Admin · Settings", description: "Platform branding and registration-form config." },
    { name: "Admin · Players", description: "Player directory." },
    { name: "Admin · Institutes", description: "Institute verification and bulk-import approval." },
    { name: "Admin · Registrations", description: "Registrations, transactions, payment verification." },
    { name: "Admin · News", description: "Per-event news items." },
    { name: "Admin · Broadcasts", description: "WhatsApp / in-app campaigns and their delivery reports." },
    { name: "Admin · Brackets (simple)", description: "Flat CRUD over `event_brackets` — the media/PDF draw uploader." },
    { name: "Admin · Draws", description: "The interactive draw engine: seeding, BYEs, results, publishing." },
    { name: "Admin · Leagues", description: "Round-robin blueprints and promotions." },
    { name: "Admin · Matches", description: "Match generation, scoring and finalisation." },
    { name: "Files", description: "Signed-URL delivery from the private Railway bucket." },
    { name: "Health", description: "Infrastructure probes." },
    { name: "Webhooks", description: "Inbound calls from Razorpay and Meta. Not for clients." },
];

/**
 * @param {{ serverUrl?: string }} [options]
 */
export function buildOpenApiSpec({ serverUrl } = {}) {
    const servers = [];
    if (serverUrl) servers.push({ url: serverUrl, description: "This server" });
    if (process.env.SWAGGER_SERVER_URL && process.env.SWAGGER_SERVER_URL !== serverUrl) {
        servers.push({ url: process.env.SWAGGER_SERVER_URL, description: "Configured QA base URL" });
    }
    if (servers.length === 0) servers.push({ url: "/", description: "This server" });

    return {
        openapi: "3.0.3",
        info: {
            title: "Sports Paramount API — QA",
            version: "1.0.0",
            description: DESCRIPTION,
            contact: { name: "Sports Paramount backend" },
        },
        servers,
        tags,
        security: [],
        paths: {
            ...authPaths,
            ...eventPaths,
            ...playerPaths,
            ...adminPaths,
            ...tournamentPaths,
        },
        components: {
            securitySchemes,
            schemas,
            parameters,
            responses: commonResponses,
        },
    };
}
