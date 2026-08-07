/**
 * When is a category open for registration?
 *
 * Two things can close a category:
 *
 *   1. Its date passing — `lastDateToRegister` is inclusive, so the category
 *      stays open until the END of that day.
 *   2. An admin closing it by hand — `registrationClosed: true` on the category,
 *      set from the Categories & Openings card on the admin event page. This is
 *      the "close early on the final day" switch: the deadline is today but the
 *      organiser wants entries to stop at 2pm rather than at midnight.
 *
 * Everything here works in IST. The deployment runs on UTC, so `new Date()` on
 * the server is up to 5.5 hours behind the organiser and the player: between
 * 00:00 and 05:30 IST a naive UTC comparison still reports yesterday's date,
 * which would keep a lapsed category open for another morning and would reject
 * a same-day toggle as "deadline already passed".
 */

const IST_OFFSET_MINUTES = 330; // UTC+05:30 — India has no DST

/**
 * The IST calendar day of an instant, as "YYYY-MM-DD".
 *
 * Deadlines are stored by the admin form as bare "YYYY-MM-DD" strings, so
 * comparing day keys as strings is exact — no Date parsing, no timezone
 * reinterpretation of a value that never had a time in the first place.
 */
export const istDayKey = (instant = new Date()) =>
    new Date(instant.getTime() + IST_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);

/**
 * The category's registration deadline as a day key, or null when it has none.
 *
 * Accepts both the camelCase key the admin form writes and the snake_case one
 * older rows carry. A full timestamp is truncated to its date part, which is
 * what the deadline has always meant.
 */
export const categoryDeadlineDayKey = (category, fallbackDate = null) => {
    if (!category || typeof category !== "object") {
        return fallbackDate ? String(fallbackDate).slice(0, 10) : null;
    }
    const raw = category.lastDateToRegister ?? category.last_date_to_register ?? fallbackDate;
    if (!raw) return null;
    const key = String(raw).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
};

/** True once the category's deadline day is behind us (IST). */
export const isCategoryDeadlinePassed = (category, fallbackDate = null, now = new Date()) => {
    const deadline = categoryDeadlineDayKey(category, fallbackDate);
    if (!deadline) return false; // no deadline recorded — never auto-closes
    return istDayKey(now) > deadline;
};

/** True when an admin has closed this category by hand. */
export const isCategoryManuallyClosed = (category) =>
    Boolean(category && typeof category === "object" && category.registrationClosed === true);

/**
 * Why this category cannot be entered right now, or null when it is open.
 * Returns a code so callers can phrase the message for their own audience.
 *
 * @returns {"MANUALLY_CLOSED" | "DEADLINE_PASSED" | null}
 */
export const categoryClosedReason = (category, fallbackDate = null, now = new Date()) => {
    if (isCategoryManuallyClosed(category)) return "MANUALLY_CLOSED";
    if (isCategoryDeadlinePassed(category, fallbackDate, now)) return "DEADLINE_PASSED";
    return null;
};
