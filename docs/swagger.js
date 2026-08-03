/**
 * Swagger UI — QA only.
 *
 * ── Why it is off unless you opt in ──────────────────────────────────────────
 * The spec is a complete map of the attack surface: every route, every body
 * field, every role boundary. That is exactly what the testing team needs and
 * exactly what production should not hand out. So the docs are **fail-closed**:
 * nothing mounts unless `ENABLE_SWAGGER=true` is explicitly set, and even then
 * two independent kill switches can veto it.
 *
 * ── The gates ────────────────────────────────────────────────────────────────
 *   1. `ENABLE_SWAGGER` must be exactly `"true"`. Absent ⇒ off. Production
 *      simply never sets it.
 *   2. A **live** Razorpay key (`rzp_live_…`) ⇒ off, whatever gate 1 says.
 *      The payment key cannot be wrong about which environment it is: prod runs
 *      live keys, QA runs test keys. This is the backstop for the one realistic
 *      accident — someone copying the QA env vars onto the prod service.
 *
 * ── Why NODE_ENV is deliberately not a gate ──────────────────────────────────
 * It looks like the obvious check and it is the wrong one here. Railway's
 * builder sets `NODE_ENV=production` on every Node service it deploys, QA
 * included, and nothing else in this codebase reads the variable. Gating on it
 * disabled the docs on QA — the exact environment they exist for — while adding
 * nothing on prod, which gate 1 already excludes and gate 2 backstops.
 *
 * ── Optional password ────────────────────────────────────────────────────────
 * QA is internet-facing. Set `SWAGGER_USER` and `SWAGGER_PASSWORD` to put HTTP
 * Basic auth in front of the docs. Leaving them unset serves the docs openly
 * and logs a warning at boot.
 */

import swaggerUi from "swagger-ui-express";
import { buildOpenApiSpec } from "./openapi/index.js";

const DOCS_PATH = "/api/docs";
const SPEC_PATH = "/api/docs.json";

/**
 * Decide whether the docs may be served, and say why not when they may not.
 * @returns {{ enabled: boolean, reason: string }}
 */
export function resolveSwaggerGate(env = process.env) {
    if (env.ENABLE_SWAGGER !== "true") {
        return { enabled: false, reason: `ENABLE_SWAGGER is ${env.ENABLE_SWAGGER === undefined ? "not set" : `"${env.ENABLE_SWAGGER}"`}, not "true"` };
    }
    if (String(env.RAZORPAY_KEY_ID || "").startsWith("rzp_live_")) {
        return { enabled: false, reason: "a live Razorpay key is configured — this looks like production" };
    }
    return { enabled: true, reason: "QA" };
}

/** HTTP Basic auth, applied only when both credentials are configured. */
function basicAuth(user, password) {
    return (req, res, next) => {
        const header = req.headers.authorization || "";
        if (header.startsWith("Basic ")) {
            const [suppliedUser, ...rest] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
            if (suppliedUser === user && rest.join(":") === password) return next();
        }
        res.setHeader("WWW-Authenticate", 'Basic realm="Sports Paramount API docs", charset="UTF-8"');
        return res.status(401).json({ success: false, message: "API docs require a username and password." });
    };
}

/**
 * Mount `/api/docs` (UI) and `/api/docs.json` (raw spec) when the gate allows.
 * Safe to call unconditionally — it is a no-op in production.
 *
 * @param {import('express').Express} app
 */
export function mountSwagger(app) {
    const { enabled, reason } = resolveSwaggerGate();

    if (!enabled) {
        console.log(`📕 API docs disabled (${reason}).`);
        return false;
    }

    const guards = [];
    const user = process.env.SWAGGER_USER;
    const password = process.env.SWAGGER_PASSWORD;
    if (user && password) {
        guards.push(basicAuth(user, password));
    } else {
        console.warn("⚠️  API docs are unauthenticated. Set SWAGGER_USER and SWAGGER_PASSWORD to require a login.");
    }

    // The spec is built per request so `servers` reflects the host the tester
    // actually reached — localhost, the Railway domain, a tunnel — which is
    // what makes "Try it out" fire at the right origin without any config.
    const specFor = (req) => buildOpenApiSpec({ serverUrl: `${req.protocol}://${req.get("host")}` });

    app.get(SPEC_PATH, ...guards, (req, res) => {
        res.json(specFor(req));
    });

    app.use(
        DOCS_PATH,
        ...guards,
        swaggerUi.serveFiles(undefined, {}),
        (req, res, next) => {
            swaggerUi.setup(specFor(req), {
                customSiteTitle: "Sports Paramount API — QA",
                swaggerOptions: {
                    persistAuthorization: true,   // survives a page refresh mid-session
                    displayRequestDuration: true,
                    docExpansion: "none",
                    filter: true,                 // search box over the tag list
                    tryItOutEnabled: true,
                },
            })(req, res, next);
        }
    );

    console.log(`📗 API docs on ${DOCS_PATH} (spec: ${SPEC_PATH})${guards.length ? " — password protected" : ""}`);
    return true;
}
