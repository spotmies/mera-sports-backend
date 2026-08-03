# API docs (Swagger) — QA only

Interactive OpenAPI 3.0 reference for the whole backend: **163 paths / 177 operations**, every one of them a route the server actually serves.

| | |
|---|---|
| UI | `GET /api/docs` |
| Raw spec | `GET /api/docs.json` |
| Local | http://localhost:5001/api/docs |

## Turning it on

Set **one** variable on the QA service:

```
ENABLE_SWAGGER=true
```

Optionally put a password in front of it (recommended — QA is internet-facing):

```
SWAGGER_USER=qa
SWAGGER_PASSWORD=<something>
```

## Why it can't leak to production

`mountSwagger()` is fail-closed and has three independent gates. All three must pass:

1. `ENABLE_SWAGGER === "true"`. Unset ⇒ off. Production simply never sets it.
2. `NODE_ENV !== "production"`.
3. **No live Razorpay key.** A `RAZORPAY_KEY_ID` starting with `rzp_live_` disables the docs regardless of the other two.

Gate 3 is the one that actually protects you. This codebase does not otherwise use `NODE_ENV`, so if someone ever copies the QA environment variables onto the prod service, gates 1 and 2 both pass and only the payment key knows the difference — prod runs live keys, QA runs test keys.

When the docs are blocked, the reason is printed at boot and `/api/docs` is a plain 404:

```
📕 API docs disabled (a live Razorpay key is configured — this looks like production).
```

## Using it (for the testing team)

1. **Auth → `POST /api/auth/login`** (player) or **`POST /api/auth/login-admin`** (admin).
2. Copy `token` from the response.
3. Click **Authorize** top-right, paste it, **Authorize**, **Close**.
4. Every 🔒 endpoint now sends `Authorization: Bearer <token>` on **Try it out**.

`persistAuthorization` is on, so the token survives a page refresh. A player token on an admin route returns **403**, not 401 — that is by design, not a bug.

The intro panel at the top of the page covers the cross-cutting gotchas: dual event ids (`13` or `evt_…`), the two ways to address a category, base64 image fields, Redis-cached reads, and which endpoints are destructive.

## Layout

```
docs/
  swagger.js               mount + the three gates + optional basic auth
  openapi/
    index.js               info, tags, server list, assembly
    components.js          security scheme, 29 entity schemas, shared params/errors
    paths/
      auth.js              /api/auth/*
      events.js            /api/events/*, /api/public/*, /api/files, health, webhooks
      player.js            player, teams, payments, notifications, institute, contact, apartments, ads
      admin.js             /api/admin/* except the tournament engine
      tournament.js        draws, leagues, matches
```

The spec is hand-written, not generated — the routes carry no annotations, and a document QA can read beats one that merely lists handlers. Entity schemas mirror the Railway Postgres tables (see `qa_schema.csv` at the repo root) plus the fields controllers graft on before responding.

`paths/tournament.js` generates the `/categories/{categoryId}/…` and `/categories/…?categoryLabel=` variants of each draw route from a single definition, so the two can never drift apart.

## Keeping it honest

Because it's hand-written, it can rot. It can't rot silently:

```
npm run docs:check
```

walks the real Express routers, walks the spec, and fails with both directions of the diff — routes with no documentation, and documented operations with no route. Run it whenever you add or rename a route.

```
Express operations: 177
Documented operations: 177

✅ OpenAPI docs cover every route, and every documented route exists.
```

If you add a route file, add it to `MOUNTS` in `scripts/check_openapi_coverage.mjs` too — it mirrors the `app.use(...)` list in `server.js`.
