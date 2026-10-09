/**
 * Date formatting for anything the server writes for people to read (emails,
 * PDF receipts). Matches the apps: DD/MM/YYYY, 12-hour clock.
 *
 * Always formatted in India time. The server runs in UTC, so the bare
 * `toLocaleDateString()` it used before could show the previous day for a
 * registration made after midnight IST, and in US order (M/D/YYYY).
 */
const IST = "Asia/Kolkata";

const toDate = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
};

const parts = (date) => {
    const out = {};
    for (const p of new Intl.DateTimeFormat("en-GB", {
        timeZone: IST,
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    }).formatToParts(date)) {
        out[p.type] = p.value;
    }
    return out;
};

/** "15/09/2026". Returns `fallback` for a missing or invalid value. */
export const formatDateIST = (value, fallback = "-") => {
    const date = toDate(value);
    if (!date) return fallback;
    const p = parts(date);
    return `${p.day}/${p.month}/${p.year}`;
};

/** "15/09/2026, 2:30 PM". Returns `fallback` for a missing or invalid value. */
export const formatDateTimeIST = (value, fallback = "-") => {
    const date = toDate(value);
    if (!date) return fallback;
    const p = parts(date);
    return `${p.day}/${p.month}/${p.year}, ${p.hour}:${p.minute} ${String(p.dayPeriod || "").toUpperCase()}`;
};
