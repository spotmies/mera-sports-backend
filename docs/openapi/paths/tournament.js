/**
 * The tournament engine: draws/brackets, leagues and matches.
 * All admin-only, all mounted under /api/admin.
 *
 * ── The two addressing styles ────────────────────────────────────────────────
 * Almost every draw route exists twice:
 *
 *   /events/{id}/categories/{categoryId}/…   ← address the category by id
 *   /events/{id}/categories/…?categoryLabel= ← address it by label
 *
 * They hit the same handler. `pair()` below emits both from one definition so
 * the two can never drift apart in this document.
 */

import { errors, ok, okEnvelope } from "../components.js";

const p = (ref) => ({ $ref: `#/components/parameters/${ref}` });
const s = (name) => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (name) => ({ type: "array", items: s(name) });

const jsonBody = (schema) => ({ required: true, content: { "application/json": { schema } } });
const obj = (properties, required = []) => ({ type: "object", required, properties });

const auth = [{ bearerAuth: [] }];
const DRAWS = ["Admin · Draws"];

/** `{ success, bracket, message }` — the shape most draw mutations return. */
const bracketResult = (description) => okEnvelope(description, { bracket: s("Bracket"), message: { type: "string" } });

/**
 * Emit the `{categoryId}` and `?categoryLabel=` variants of one draw route.
 *
 * @param suffix     path after `/categories` (e.g. `/bracket/init`), or `""`
 * @param method     http method
 * @param operation  the OpenAPI operation, minus the category parameter
 * @param extra      additional path params for the label variant, e.g. mediaId
 */
const pair = (suffix, method, operation, extra = []) => {
    const byId = `/api/admin/events/{id}/categories/{categoryId}${suffix}`;
    const byLabel = `/api/admin/events/{id}/categories${suffix}`;
    const base = operation.parameters || [];

    return {
        [byId]: {
            [method]: { ...operation, tags: operation.tags || DRAWS, security: auth, parameters: [p("EventIdPath"), p("CategoryIdPath"), ...extra, ...base] },
        },
        [byLabel]: {
            [method]: {
                ...operation,
                tags: operation.tags || DRAWS,
                security: auth,
                summary: `${operation.summary} (by category label)`,
                description: `${operation.description || ""}\n\nSame handler as the \`{categoryId}\` variant — the category is named by the \`categoryLabel\` query parameter (or the \`categoryLabel\` body field) instead.`.trim(),
                parameters: [p("EventIdPath"), p("CategoryLabelQuery"), ...extra, ...base],
            },
        },
    };
};

/** Body field present on every label-addressable draw mutation. */
const categoryLabelField = {
    categoryLabel: { type: "string", description: "Category label. Required when the path has no `{categoryId}`.", example: "Above 17 Mixed" },
};

const matchFilterQuery = [
    { name: "categoryId", in: "query", schema: { type: "string" } },
    { name: "categoryName", in: "query", description: "Alternative to `categoryId`.", schema: { type: "string" } },
    { name: "roundName", in: "query", description: "`round_name` is accepted as a snake_case alias.", schema: { type: "string" } },
];

export const tournamentPaths = {
    /* ── draw summaries ──────────────────────────────────────────────────── */

    "/api/admin/events/draws/summary": {
        get: {
            tags: DRAWS,
            summary: "Draw progress for many events at once",
            description: "Feeds the events list's per-event draw badge without one request per event.",
            security: auth,
            parameters: [
                {
                    name: "eventIds",
                    in: "query",
                    required: true,
                    description: "Comma-separated event ids. Empty ⇒ empty summary.",
                    schema: { type: "string", example: "13,14,15" },
                },
            ],
            responses: {
                ...okEnvelope("Keyed by event id.", {
                    summary: {
                        type: "object",
                        additionalProperties: obj({
                            drawsCount: { type: "integer" },
                            roundsCompleted: { type: "integer" },
                            drawsUploaded: { type: "boolean" },
                        }),
                        example: { 13: { drawsCount: 2, roundsCompleted: 1, drawsUploaded: true } },
                    },
                }),
                ...errors(401, 403, 500),
            },
        },
    },

    "/api/admin/events/{id}/draws": {
        get: {
            tags: DRAWS,
            summary: "Every category's draw for one event, in a single query",
            description: "What the Draws tab loads on open, instead of one `…/draw` call per category.",
            security: auth,
            parameters: [p("EventIdPath")],
            responses: {
                ...okEnvelope("Draws per category.", { draws: { type: "array", items: { type: "object", additionalProperties: true } } }),
                ...errors(401, 403, 404, 500),
            },
        },
    },

    /* ── read one category's draw ────────────────────────────────────────── */

    ...pair("/draw", "get", {
        summary: "Get the draw for one category",
        description:
            "Returns whichever mode the category is in: `MEDIA` (uploaded images/PDF), `BRACKET` (the interactive draw) or `LEAGUE`.",
        responses: {
            ...okEnvelope("Draw.", {
                draw: obj({
                    categoryId: { type: "string", nullable: true },
                    categoryLabel: { type: "string", nullable: true },
                    mode: { type: "string", enum: ["MEDIA", "BRACKET", "LEAGUE"] },
                    published: { type: "boolean" },
                    media: { type: "object", nullable: true, additionalProperties: true },
                    rounds: { type: "array", items: { type: "object", additionalProperties: true } },
                }),
            }),
            ...errors(400, 401, 403, 404, 500),
        },
    }),

    ...pair("/draw/validate", "get", {
        summary: "Validate bracket integrity",
        description: "Semifinal-safe structural check. Run this before publishing; `errors` lists what is wrong.",
        responses: {
            ...okEnvelope("Validation result.", {
                valid: { type: "boolean" },
                errors: { type: "array", items: { type: "string" } },
            }),
            ...errors(400, 401, 403, 404, 500),
        },
    }),

    /* ── build the bracket ───────────────────────────────────────────────── */

    ...pair("/bracket/init", "post", {
        summary: "Initialise an empty bracket",
        description: "Creates the `event_brackets` row and its round skeleton. Use `/bracket/start` to also generate every round's matches in one call.",
        requestBody: jsonBody(
            obj({
                ...categoryLabelField,
                roundStructure: {
                    type: "array",
                    description: "Rounds to create, in order.",
                    items: obj({ name: { type: "string", example: "Round 1" }, matchCount: { type: "integer", example: 8 } }),
                },
                bracketData: { type: "object", additionalProperties: true, description: "Pre-built bracket to seed from." },
                players: { type: "array", items: s("BracketPlayer") },
                createdFrom: { type: "string", description: "Provenance tag, e.g. `registrations`." },
            })
        ),
        responses: { ...bracketResult("Bracket initialised."), ...errors(400, 401, 403, 404, 500) },
    }),

    ...pair("/bracket/start", "post", {
        summary: "Create the full bracket structure — all rounds and matches",
        description: "The one-shot 'Start rounds' action. Handles 100+ player draws in a single request.",
        requestBody: jsonBody(
            obj({
                ...categoryLabelField,
                seedingMode: { type: "string", enum: ["AUTO", "MANUAL", "RANK"], default: "AUTO" },
                rounds: {
                    type: "array",
                    description: "Per-round configuration.",
                    items: obj({ name: { type: "string" }, matchCount: { type: "integer" }, selectedSets: { type: "integer", example: 3 } }),
                },
                playerIds: { type: "array", items: { type: "string" }, description: "Restrict seeding to these players." },
            })
        ),
        responses: {
            ...okEnvelope("Structure created.", {
                bracket: s("Bracket"),
                message: { type: "string" },
                debug: { type: "object", additionalProperties: true, description: "Round/match counts — handy when a seed looks wrong." },
            }),
            ...errors(400, 401, 403, 404, 500),
        },
    }),

    ...pair("/bracket/round/add", "post", {
        summary: "Append a round to the bracket",
        requestBody: jsonBody(obj({ ...categoryLabelField, roundName: { type: "string", example: "Semi Final" } })),
        responses: { ...bracketResult("Round added."), ...errors(400, 401, 403, 404, 500) },
    }),

    ...pair("/bracket/round/delete", "post", {
        summary: "Delete the last round",
        requestBody: jsonBody(obj({ ...categoryLabelField, roundName: { type: "string" } })),
        responses: { ...bracketResult("Round deleted."), ...errors(400, 401, 403, 404, 500) },
    }),

    ...pair("/bracket/round/replace", "post", {
        summary: "Replace every match in a round",
        description: "Bulk seeding path — one request rather than a `/bracket/match` call per pairing.",
        requestBody: jsonBody(
            obj(
                {
                    ...categoryLabelField,
                    roundName: { type: "string", example: "Round 1" },
                    matches: {
                        type: "array",
                        items: obj({
                            matchId: { type: "string", nullable: true },
                            player1: s("BracketPlayer"),
                            player2: s("BracketPlayer"),
                            matchIndex: { type: "integer" },
                        }),
                    },
                },
                ["roundName", "matches"]
            )
        ),
        responses: { ...bracketResult("Round replaced."), ...errors(400, 401, 403, 404, 500) },
    }),

    ...pair("/bracket/match", "post", {
        summary: "Place, move, clear or delete a single bracket match",
        description:
            "The drag-and-drop endpoint. Send `deleteMatch: true` to remove the match; send the ranking fields to persist seeding without touching pairings.",
        requestBody: jsonBody(
            obj({
                ...categoryLabelField,
                roundName: { type: "string", example: "Round 1" },
                matchId: { type: "string", nullable: true },
                matchIndex: { type: "integer" },
                player1: { oneOf: [s("BracketPlayer"), { type: "null" }] },
                player2: { oneOf: [s("BracketPlayer"), { type: "null" }] },
                winner: { oneOf: [s("BracketPlayer"), { type: "null" }] },
                deleteMatch: { type: "boolean" },
                updatePlayerRanks: { type: "boolean", description: "Persist ranks only, leaving the pairing alone." },
                playerRanks: { type: "object", additionalProperties: { type: "integer" }, description: "Legacy flat map, playerId → rank." },
                enableRanking: { type: "boolean" },
                playerRanksByRound: {
                    type: "object",
                    additionalProperties: { type: "object", additionalProperties: { type: "integer" } },
                    description: "Per-round ranks: roundName → playerId → rank. `player_ranks_by_round` is accepted as a snake_case alias.",
                },
                enableRankingByRound: { type: "object", additionalProperties: { type: "boolean" }, description: "`enable_ranking_by_round` also accepted." },
            })
        ),
        responses: { ...bracketResult("Match updated."), ...errors(400, 401, 403, 404, 500) },
    }),

    ...pair("/bracket/result", "post", {
        summary: "Record a match result and advance the winner",
        description: "Writes the score, marks the match complete and propagates the winner into the next round.",
        requestBody: jsonBody(
            obj(
                {
                    ...categoryLabelField,
                    roundName: { type: "string" },
                    matchId: { type: "string" },
                    winner: s("BracketPlayer"),
                    score: { type: "object", additionalProperties: true, example: { sets: [{ a: 21, b: 18 }, { a: 21, b: 15 }] } },
                    sets: { type: "array", items: { type: "object", additionalProperties: true }, description: "Alternative to `score.sets`." },
                },
                ["matchId", "winner"]
            )
        ),
        responses: { ...bracketResult("Result saved and winner advanced."), ...errors(400, 401, 403, 404, 500) },
    }),

    /* ── BYEs ────────────────────────────────────────────────────────────── */

    ...pair("/bracket/round/randomize-byes", "post", {
        summary: "Randomise BYE placement in Round 1",
        description: "Alias: `…/bracket/round1/reshuffle-byes` — identical handler, kept for the naming the admin console uses.",
        requestBody: jsonBody(obj({ ...categoryLabelField, roundName: { type: "string", default: "Round 1" } })),
        responses: { ...bracketResult("BYE placement randomised."), ...errors(400, 401, 403, 404, 500) },
    }),

    ...pair("/bracket/round1/reshuffle-byes", "post", {
        summary: "Randomise BYE placement in Round 1 (alias)",
        description: "Same handler as `…/bracket/round/randomize-byes`.",
        requestBody: jsonBody(obj({ ...categoryLabelField, roundName: { type: "string", default: "Round 1" } })),
        responses: { ...bracketResult("BYE placement randomised."), ...errors(400, 401, 403, 404, 500) },
    }),

    ...pair("/bracket/round1/assign-bye", "patch", {
        summary: "Give a specific player a BYE",
        description: "Manual override for the automatic BYE distribution.",
        requestBody: jsonBody(obj({ ...categoryLabelField, matchId: { type: "string" }, playerId: { type: "string" } }, ["playerId"])),
        responses: { ...bracketResult("BYE assigned."), ...errors(400, 401, 403, 404, 500) },
    }),

    ...pair("/bracket/finalize-byes", "post", {
        summary: "Lock in BYEs once the entry list is final",
        description: "`expectedTotalPlayers` lets the server check the draw size still matches the field before committing.",
        requestBody: jsonBody(obj({ ...categoryLabelField, expectedTotalPlayers: { type: "integer", example: 24 } })),
        responses: { ...bracketResult("BYEs finalised."), ...errors(400, 401, 403, 404, 500) },
    }),

    /* ── publish, reset, delete, media ───────────────────────────────────── */

    ...pair("/publish", "post", {
        summary: "Publish or unpublish a category's draw",
        description: "Publishing is what makes the draw visible on `/api/public/events/{id}/draws`.",
        requestBody: jsonBody(obj({ ...categoryLabelField, published: { type: "boolean", description: "Required, must be a real boolean." } }, ["published"])),
        responses: {
            ...okEnvelope("Publish state changed.", { message: { type: "string" }, draws: { type: "array", items: s("Bracket") } }),
            ...errors(400, 401, 403, 404, 500),
        },
    }),

    ...pair("/bracket/reset", "post", {
        summary: "Clear all results and pairings, keeping the structure",
        requestBody: jsonBody(obj({ ...categoryLabelField })),
        responses: { ...bracketResult("Bracket reset."), ...errors(400, 401, 403, 404, 500) },
    }),

    ...pair("/bracket", "delete", {
        summary: "Delete a category's bracket",
        description:
            "Unpublished draws only.\n\nSend `categoryLabel` alongside the id whenever you have it. " +
            "Brackets created before brackets became id-keyed are stored under the label alone, and an " +
            "id-only delete answers 404 for a bracket the `GET /draw` (which sends both keys) renders fine. " +
            "The `{categoryId}` variant accepts the same `categoryLabel` query parameter as the by-label variant " +
            "below (`category` is an alias), and it is only ever a fallback: the id wins whenever it owns a bracket.",
        responses: { ...okEnvelope("Bracket deleted."), ...errors(400, 401, 403, 404, 500) },
    }),

    ...pair("/media", "post", {
        summary: "Upload draw images / a draw PDF",
        description: "Puts the category into `MEDIA` mode — the scanned-draw workflow, as opposed to the interactive bracket.",
        requestBody: jsonBody(
            obj({
                ...categoryLabelField,
                files: {
                    type: "array",
                    description: "`data:` image URLs.",
                    items: obj({ url: { type: "string" }, name: { type: "string" }, roundName: { type: "string" } }),
                },
                pdfFile: { type: "string", nullable: true, description: "`data:application/pdf;base64,...`" },
            })
        ),
        responses: {
            ...okEnvelope("Media stored.", { draw: s("Bracket"), message: { type: "string" }, modeCleared: { type: "boolean" } }),
            ...errors(400, 401, 403, 404, 500),
        },
    }),

    ...pair(
        "/media/{mediaId}",
        "delete",
        {
            summary: "Delete one uploaded draw media item",
            description: "Removing the last item clears `MEDIA` mode — the response reports that as `modeCleared: true`.",
            responses: {
                ...okEnvelope("Deleted.", { draw: s("Bracket"), modeCleared: { type: "boolean" } }),
                ...errors(400, 401, 403, 404, 500),
            },
        },
        [{ name: "mediaId", in: "path", required: true, description: "Entry id within `event_brackets.media_urls`.", schema: { type: "string" } }]
    ),

    ...pair("/bracket/notify-promotions", "post", {
        summary: "Notify players promoted to the next round",
        description: "Idempotent per (category, round, player) — a repeat call reports the extras as `duplicates` rather than double-messaging.",
        requestBody: jsonBody(
            obj({
                ...categoryLabelField,
                completedRoundName: { type: "string", example: "Round 1" },
                nextRoundName: { type: "string", example: "Quarter Final" },
                promotions: {
                    type: "array",
                    items: obj({ playerId: { type: "string" }, name: { type: "string" }, mobile: { type: "string" } }),
                },
            })
        ),
        responses: {
            ...okEnvelope("Notifications dispatched.", { notified: { type: "integer" }, duplicates: { type: "integer" } }),
            ...errors(400, 401, 403, 404, 500),
        },
    }),

    /* ── leagues ─────────────────────────────────────────────────────────── */

    "/api/admin/events/{id}/categories/{categoryId}/league": {
        get: {
            tags: ["Admin · Leagues"],
            summary: "Read the league blueprint for a category",
            description:
                "Scores never live here — they stay in `matches`. An unconfigured category returns an empty participant list with the default 3/1/0 rules rather than a 404. `format` comes back as `HEAT` for heat-style configs.",
            security: auth,
            parameters: [p("EventIdPath"), p("CategoryIdPath")],
            responses: {
                ...okEnvelope("League blueprint.", {
                    league: obj({
                        format: { type: "string", enum: ["LEAGUE", "HEAT"] },
                        participants: arrayOf("LeagueParticipant"),
                        rules: { type: "object", additionalProperties: true },
                    }),
                }),
                ...errors(401, 403, 404, 500),
            },
        },
        post: {
            tags: ["Admin · Leagues"],
            summary: "Create or replace the league blueprint",
            security: auth,
            parameters: [p("EventIdPath"), p("CategoryIdPath")],
            requestBody: jsonBody(
                obj({
                    ...categoryLabelField,
                    participants: arrayOf("LeagueParticipant"),
                    rules: obj({
                        pointsWin: { type: "integer", default: 3 },
                        pointsDraw: { type: "integer", default: 1 },
                        pointsLoss: { type: "integer", default: 0 },
                    }),
                })
            ),
            responses: { ...okEnvelope("Saved.", { league: s("League") }), ...errors(400, 401, 403, 404, 500) },
        },
        delete: {
            tags: ["Admin · Leagues"],
            summary: "Delete the league configuration",
            description: "Matches are preserved unless the handler is told otherwise; the response message says which happened.",
            security: auth,
            parameters: [p("EventIdPath"), p("CategoryIdPath")],
            responses: {
                ...okEnvelope("Deleted.", { message: { type: "string" }, deletedLeagueId: { type: "string", format: "uuid" } }),
                ...errors(401, 403, 404, 500),
            },
        },
    },

    "/api/admin/events/{id}/categories/{categoryId}/league/notify-promotions": {
        post: {
            tags: ["Admin · Leagues"],
            summary: "Notify players promoted out of the league stage",
            description: "Same idempotency guarantee as the bracket version — repeats count as `duplicates`.",
            security: auth,
            parameters: [p("EventIdPath"), p("CategoryIdPath")],
            requestBody: jsonBody(
                obj({
                    ...categoryLabelField,
                    completedRoundName: { type: "string", default: "League Stage" },
                    nextRoundName: { type: "string", example: "Semi Final" },
                    promotionType: { type: "string", example: "TOP_N" },
                    promotions: { type: "array", items: { type: "object", additionalProperties: true } },
                })
            ),
            responses: {
                ...okEnvelope("Dispatched.", { notified: { type: "integer" }, duplicates: { type: "integer" } }),
                ...errors(400, 401, 403, 404, 500),
            },
        },
    },

    /* ── matches ─────────────────────────────────────────────────────────── */

    "/api/admin/matches/{eventId}": {
        get: {
            tags: ["Admin · Matches"],
            summary: "Matches for an event",
            description: "The admin scoreboard read. The public equivalent is `GET /api/events/{id}/matches`.",
            security: auth,
            parameters: [
                { name: "eventId", in: "path", required: true, schema: { type: "string", example: "13" } },
                ...matchFilterQuery,
                { name: "bracketId", in: "query", schema: { type: "string" } },
            ],
            responses: { ...okEnvelope("Matches.", { matches: arrayOf("Match") }), ...errors(401, 403, 500) },
        },
    },

    "/api/admin/matches/generate/{eventId}/{categoryId}": {
        post: {
            tags: ["Admin · Matches"],
            summary: "Generate match rows from an existing bracket",
            description: "Idempotent — re-running will not duplicate matches.",
            security: auth,
            parameters: [
                { name: "eventId", in: "path", required: true, schema: { type: "string", example: "13" } },
                { name: "categoryId", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: { ...okEnvelope("Matches generated.", { matches: arrayOf("Match"), created: { type: "integer" } }), ...errors(400, 401, 403, 404, 500) },
        },
    },

    "/api/admin/matches/generate-league/{eventId}/{categoryId}": {
        post: {
            tags: ["Admin · Matches"],
            summary: "Generate round-robin matches from the league blueprint",
            description: "Idempotent.",
            security: auth,
            parameters: [
                { name: "eventId", in: "path", required: true, schema: { type: "string", example: "13" } },
                { name: "categoryId", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: { ...okEnvelope("Matches generated.", { matches: arrayOf("Match"), created: { type: "integer" } }), ...errors(400, 401, 403, 404, 500) },
        },
    },

    "/api/admin/matches": {
        post: {
            tags: ["Admin · Matches"],
            summary: "Create one match manually",
            description: "Note the snake_case body — this endpoint takes column names, unlike the bracket routes.",
            security: auth,
            requestBody: jsonBody(
                obj(
                    {
                        event_id: { type: "string", example: "13" },
                        category_id: { type: "string" },
                        category_name: { type: "string", description: "Alternative to `category_id`." },
                        round_name: { type: "string", example: "Quarter Final" },
                        player_a: s("BracketPlayer"),
                        player_b: s("BracketPlayer"),
                        bracket_id: { type: "string", nullable: true, description: "Resolved from the event + category when omitted." },
                    },
                    ["event_id", "round_name"]
                )
            ),
            responses: { ...okEnvelope("Created.", { match: s("Match") }), ...errors(400, 401, 403, 500) },
        },
    },

    "/api/admin/matches/bulk": {
        post: {
            tags: ["Admin · Matches"],
            summary: "Create many matches in one request",
            security: auth,
            requestBody: jsonBody(obj({ matches: { type: "array", minItems: 1, items: { type: "object", additionalProperties: true, description: "Same shape as `POST /api/admin/matches`." } } }, ["matches"])),
            responses: { ...okEnvelope("Created.", { matches: arrayOf("Match"), created: { type: "integer" } }), ...errors(400, 401, 403, 500) },
        },
    },

    "/api/admin/matches/{matchId}/score": {
        put: {
            tags: ["Admin · Matches"],
            summary: "Update a match score and status",
            security: auth,
            parameters: [{ name: "matchId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
            requestBody: jsonBody(
                obj({
                    score: { type: "object", additionalProperties: true, example: { sets: [{ a: 21, b: 18 }, { a: 19, b: 21 }, { a: 15, b: 12 }] } },
                    status: { type: "string", enum: ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] },
                    winner: { oneOf: [s("BracketPlayer"), { type: "null" }] },
                })
            ),
            responses: { ...okEnvelope("Updated.", { match: s("Match") }), ...errors(400, 401, 403, 404, 500) },
        },
    },

    "/api/admin/matches/{matchId}": {
        delete: {
            tags: ["Admin · Matches"],
            summary: "Delete one match",
            security: auth,
            parameters: [{ name: "matchId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
            responses: { ...okEnvelope("Deleted."), ...errors(401, 403, 404, 500) },
        },
    },

    "/api/admin/matches/{eventId}/finalize": {
        post: {
            tags: ["Admin · Matches"],
            summary: "Finalise every match in a round",
            description: "Computes winners from the submitted scores and flips the matches to `COMPLETED`.",
            security: auth,
            parameters: [{ name: "eventId", in: "path", required: true, schema: { type: "string", example: "13" } }],
            requestBody: jsonBody(
                obj(
                    {
                        categoryId: { type: "string" },
                        categoryName: { type: "string", description: "Alternative to `categoryId`." },
                        roundName: { type: "string", example: "Round 1" },
                        matches: {
                            type: "array",
                            minItems: 1,
                            items: obj({ matchId: { type: "string", format: "uuid" }, score: { type: "object", additionalProperties: true } }, ["matchId"]),
                        },
                        winnerMode: { type: "string", description: "How a winner is derived from the score, e.g. `SETS` or `POINTS`." },
                    },
                    ["roundName", "matches"]
                )
            ),
            responses: { ...okEnvelope("Round finalised.", { matches: arrayOf("Match") }), ...errors(400, 401, 403, 404, 500) },
        },
    },

    "/api/admin/matches/round-sets/update": {
        post: {
            tags: ["Admin · Matches"],
            summary: "Set the Best-of-N sets for a round",
            security: auth,
            requestBody: jsonBody(
                obj(
                    {
                        eventId: { type: "string", example: "13" },
                        categoryId: { type: "string" },
                        categoryName: { type: "string" },
                        roundName: { type: "string" },
                        selectedSets: { type: "integer", example: 3, description: "Best of N." },
                        winnerMode: { type: "string" },
                    },
                    ["eventId", "roundName", "selectedSets"]
                )
            ),
            responses: { ...okEnvelope("Updated."), ...errors(400, 401, 403, 404, 500) },
        },
    },

    "/api/admin/matches/category/{eventId}/scores": {
        delete: {
            tags: ["Admin · Matches"],
            summary: "Clear scores for a category, keeping the fixtures",
            description: "Resets results without deleting the matches themselves.",
            security: auth,
            parameters: [{ name: "eventId", in: "path", required: true, schema: { type: "string", example: "13" } }, ...matchFilterQuery],
            responses: { ...okEnvelope("Scores cleared.", { cleared: { type: "integer" } }), ...errors(400, 401, 403, 404, 500) },
        },
    },

    "/api/admin/matches/category/{eventId}": {
        delete: {
            tags: ["Admin · Matches"],
            summary: "Delete every match for a category",
            description: "Destructive. Narrow with `roundName` to delete a single round.",
            security: auth,
            parameters: [{ name: "eventId", in: "path", required: true, schema: { type: "string", example: "13" } }, ...matchFilterQuery],
            responses: { ...okEnvelope("Matches deleted.", { deleted: { type: "integer" } }), ...errors(400, 401, 403, 404, 500) },
        },
    },
};
