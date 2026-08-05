import { JWT } from "google-auth-library";
import dotenv from "dotenv";

import { cacheGet, cacheSet } from "../config/redisClient.js";

dotenv.config({ quiet: true });

/**
 * ============================================================
 * Google Analytics 4 — Data API reader
 * ============================================================
 * Reads the GA4 property behind sportsparamount.com so the admin panel can show
 * acquisition data (who arrived, from where, on what device) next to our own
 * first-party event funnels.
 *
 * No new dependency: the GA4 Data API is plain REST, and `google-auth-library`
 * (already here for admin Google sign-in) can mint the service-account access
 * token. Pulling in @google-analytics/data would add a gRPC stack to do the
 * same two HTTP calls.
 *
 * DESIGN RULE, same as Redis: this is an *accessory*, never a hard dependency.
 * Unconfigured, rate-limited or down, every function here returns a shaped
 * "not available" result and the admin page renders its first-party half
 * normally. GA must never be able to take the analytics page down.
 *
 * ---------------------------------------------------------------------------
 * SETUP (once):
 *   1. Google Cloud console → create a service account → create a JSON key.
 *   2. GA4 → Admin → Property access management → add the service account's
 *      email as a **Viewer**. Without this every call returns 403.
 *   3. GA4 → Admin → Property settings → copy the numeric **Property ID**.
 *      This is NOT the G-XXXXXXXXXX measurement id the website uses.
 *   4. Set on the backend (Railway):
 *        GA4_PROPERTY_ID=123456789
 *        GA4_SA_JSON=<the whole key file, base64 encoded>
 *      or, if you prefer discrete vars:
 *        GA4_SA_CLIENT_EMAIL=...@...iam.gserviceaccount.com
 *        GA4_SA_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n"
 * ---------------------------------------------------------------------------
 */

const GA_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const GA_DATA_HOST = "https://analyticsdata.googleapis.com/v1beta";

// GA4 reporting data is not real-time; re-querying it per page load spends
// quota to redraw identical numbers. Ten minutes is well inside GA's own
// processing latency, so the cache costs no freshness that actually exists.
const CACHE_TTL_SECONDS = 600;

const propertyId = () => (process.env.GA4_PROPERTY_ID || "").trim();

/**
 * Service-account credentials from either supported form.
 * Returns null when nothing is configured — the caller's cue to report
 * "not configured" rather than to fail.
 */
const readCredentials = () => {
    const rawJson = (process.env.GA4_SA_JSON || "").trim();
    if (rawJson) {
        try {
            // Accept both raw JSON and base64 — Railway's UI mangles multi-line
            // values, so base64 is what people actually end up pasting.
            const decoded = rawJson.startsWith("{")
                ? rawJson
                : Buffer.from(rawJson, "base64").toString("utf8");
            const parsed = JSON.parse(decoded);
            if (parsed.client_email && parsed.private_key) {
                return { clientEmail: parsed.client_email, privateKey: parsed.private_key };
            }
            console.warn("GA4: GA4_SA_JSON parsed but has no client_email/private_key.");
            return null;
        } catch (err) {
            console.warn("GA4: GA4_SA_JSON is not valid JSON or base64 JSON:", err.message);
            return null;
        }
    }

    const clientEmail = (process.env.GA4_SA_CLIENT_EMAIL || "").trim();
    const privateKey = process.env.GA4_SA_PRIVATE_KEY || "";
    if (!clientEmail || !privateKey) return null;

    // Env vars carry "\n" as two literal characters; the signer needs real
    // newlines or it rejects the key as malformed.
    return { clientEmail, privateKey: privateKey.replace(/\\n/g, "\n") };
};

export const isGoogleAnalyticsConfigured = () =>
    Boolean(propertyId()) && Boolean(readCredentials());

let cachedClient = null;

const getClient = () => {
    if (cachedClient) return cachedClient;
    const creds = readCredentials();
    if (!creds) return null;
    // The JWT client refreshes its own access token; building it once keeps a
    // valid token in memory instead of re-signing on every request.
    cachedClient = new JWT({
        email: creds.clientEmail,
        key: creds.privateKey,
        scopes: [GA_SCOPE],
    });
    return cachedClient;
};

/** GA4 wants plain YYYY-MM-DD, and interprets it in the property's timezone. */
const toGaDate = (date) => date.toISOString().slice(0, 10);

/**
 * The five reports the admin page needs, in one HTTP round trip.
 * batchRunReports allows up to five, which is exactly what fits.
 */
const buildBatchRequest = (from, to, prevFrom, prevTo) => ({
    requests: [
        // 0 — headline totals, current window vs the preceding one. Two
        // dateRanges in one request is what makes GA compute the comparison.
        {
            dateRanges: [
                { startDate: toGaDate(from), endDate: toGaDate(to), name: "current" },
                { startDate: toGaDate(prevFrom), endDate: toGaDate(prevTo), name: "previous" },
            ],
            metrics: [
                { name: "activeUsers" },
                { name: "sessions" },
                { name: "screenPageViews" },
                { name: "eventCount" },
                { name: "averageSessionDuration" },
                { name: "bounceRate" },
            ],
        },
        // 1 — daily trend
        {
            dateRanges: [{ startDate: toGaDate(from), endDate: toGaDate(to) }],
            dimensions: [{ name: "date" }],
            metrics: [
                { name: "activeUsers" },
                { name: "sessions" },
                { name: "screenPageViews" },
            ],
            orderBys: [{ dimension: { dimensionName: "date" } }],
            limit: 400,
        },
        // 2 — most-viewed pages
        {
            dateRanges: [{ startDate: toGaDate(from), endDate: toGaDate(to) }],
            dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
            metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
            orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
            limit: 20,
        },
        // 3 — where the traffic came from
        {
            dateRanges: [{ startDate: toGaDate(from), endDate: toGaDate(to) }],
            dimensions: [{ name: "sessionDefaultChannelGroup" }, { name: "sessionSource" }],
            metrics: [{ name: "sessions" }, { name: "activeUsers" }],
            orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
            limit: 15,
        },
        // 4 — device split
        {
            dateRanges: [{ startDate: toGaDate(from), endDate: toGaDate(to) }],
            dimensions: [{ name: "deviceCategory" }],
            metrics: [{ name: "sessions" }, { name: "activeUsers" }],
            orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
            limit: 10,
        },
    ],
});

const num = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

/** Row shape from GA4 is positional arrays; name the positions once, here. */
const metricsOf = (row, names) => {
    const out = {};
    names.forEach((name, index) => {
        out[name] = num(row?.metricValues?.[index]?.value);
    });
    return out;
};

const dimsOf = (row, index) => row?.dimensionValues?.[index]?.value || "";

const TOTAL_METRICS = [
    "activeUsers",
    "sessions",
    "pageViews",
    "eventCount",
    "avgSessionDuration",
    "bounceRate",
];

const shapeTotals = (report) => {
    // With two dateRanges GA returns one row per range, tagged by a trailing
    // dimension value of the range name. With no data it returns no rows at
    // all, which must read as zeros rather than as an error.
    const rows = report?.rows || [];
    const pick = (rangeName) =>
        rows.find((row) => (row.dimensionValues || []).some((d) => d.value === rangeName)) ||
        (rows.length === 1 ? rows[0] : null);

    const zero = TOTAL_METRICS.reduce((acc, key) => ({ ...acc, [key]: 0 }), {});
    const current = pick("date_range_0") || pick("current");
    const previous = pick("date_range_1") || pick("previous");

    return {
        current: current ? metricsOf(current, TOTAL_METRICS) : zero,
        previous: previous ? metricsOf(previous, TOTAL_METRICS) : zero,
    };
};

const shapeTimeseries = (report) =>
    (report?.rows || []).map((row) => {
        const raw = dimsOf(row, 0); // GA gives YYYYMMDD with no separators
        const metrics = metricsOf(row, ["activeUsers", "sessions", "pageViews"]);
        return {
            day:
                raw.length === 8
                    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
                    : raw,
            ...metrics,
        };
    });

const shapeTopPages = (report) =>
    (report?.rows || []).map((row) => ({
        page_path: dimsOf(row, 0),
        page_title: dimsOf(row, 1),
        ...metricsOf(row, ["pageViews", "activeUsers"]),
    }));

const shapeChannels = (report) =>
    (report?.rows || []).map((row) => ({
        channel: dimsOf(row, 0) || "Unassigned",
        source: dimsOf(row, 1) || "(direct)",
        ...metricsOf(row, ["sessions", "activeUsers"]),
    }));

const shapeDevices = (report) =>
    (report?.rows || []).map((row) => ({
        device: dimsOf(row, 0) || "unknown",
        ...metricsOf(row, ["sessions", "activeUsers"]),
    }));

/**
 * Fetch the GA4 half of the admin analytics page.
 *
 * Never throws. Returns one of:
 *   { configured: false, reason }                  — nothing set up yet
 *   { configured: true, available: false, reason } — set up but the call failed
 *   { configured: true, available: true, ... }     — data
 */
export async function fetchGoogleAnalytics({ from, to, prevFrom, prevTo }) {
    const property = propertyId();
    const client = getClient();

    if (!property || !client) {
        return {
            configured: false,
            reason:
                "Google Analytics is not connected. Set GA4_PROPERTY_ID and a service-account key " +
                "(GA4_SA_JSON), and give that service account Viewer access to the GA4 property.",
        };
    }

    const cacheKey = `ga4:dash:${property}:${toGaDate(from)}:${toGaDate(to)}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    try {
        const response = await client.request({
            url: `${GA_DATA_HOST}/properties/${encodeURIComponent(property)}:batchRunReports`,
            method: "POST",
            data: buildBatchRequest(from, to, prevFrom, prevTo),
            // A slow GA must not hold an admin request open indefinitely.
            timeout: 15000,
        });

        const reports = response?.data?.reports || [];
        const totals = shapeTotals(reports[0]);

        const result = {
            configured: true,
            available: true,
            property_id: property,
            totals: totals.current,
            previous: totals.previous,
            timeseries: shapeTimeseries(reports[1]),
            top_pages: shapeTopPages(reports[2]),
            channels: shapeChannels(reports[3]),
            devices: shapeDevices(reports[4]),
        };

        await cacheSet(cacheKey, result, CACHE_TTL_SECONDS);
        return result;
    } catch (err) {
        // The two failures worth naming precisely, because the fix differs and
        // both otherwise surface as an opaque "request failed".
        const status = err?.response?.status;
        const detail = err?.response?.data?.error?.message || err.message;

        let reason = `Google Analytics request failed: ${detail}`;
        if (status === 403) {
            reason =
                "Google Analytics denied access. Add the service account email as a Viewer " +
                "under GA4 → Admin → Property access management.";
        } else if (status === 404) {
            reason = `No GA4 property with id ${property}. Check GA4_PROPERTY_ID — it is the numeric property id, not the G-XXXXXXXXXX measurement id.`;
        }

        console.warn("GA4 fetch failed:", status || "", detail);
        return { configured: true, available: false, reason };
    }
}
