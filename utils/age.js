/**
 * Age handling.
 *
 * `users.age` is a stored integer written once at signup and again on profile
 * edit. It is never recomputed, so it silently goes stale on every birthday —
 * a player registered at 8 still reads as 8 years later. That drove real
 * decisions (category eligibility, the `age <= 15` shared-mobile rule), so
 * `dob` is treated as the source of truth wherever it exists and the stored
 * column is only a fallback for accounts that have no date of birth.
 *
 * Postgres cannot express this as a generated column — GENERATED ALWAYS AS
 * requires an immutable expression and today's date is not immutable — so it is
 * derived at read time instead.
 */

/**
 * The minor/adult boundary. It limits NOTHING about joining: sharing a mobile
 * number, signing up without an email, and being added or edited in the
 * Family tab are open to every age. It only decides what a family head may do
 * to a member (isHeadManaged) and the relation guessed for a child.
 *
 * This single constant governs registration, the login profile chooser and the
 * dashboard family CRUD. It used to be the literal `15`/`16` scattered across
 * three controllers, which is how the register and login paths drifted apart.
 */
export const MINOR_AGE_LIMIT = 15;

/** Exact age in completed years, accounting for whether the birthday has passed. */
export const calculateAge = (dob) => {
    if (!dob) return null;
    const birth = new Date(dob);
    if (Number.isNaN(birth.getTime())) return null;

    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) age--;
    return age >= 0 ? age : null;
};

/**
 * The age to trust for a user row: derived from `dob` when present, otherwise
 * the stored column.
 * @param {{dob?: string|Date|null, age?: number|string|null}} user
 * @returns {number|null}
 */
export const resolveAge = (user) => {
    const derived = calculateAge(user?.dob);
    if (derived !== null) return derived;
    const stored = Number(user?.age);
    return Number.isFinite(stored) && stored > 0 ? stored : null;
};

/** Over MINOR_AGE_LIMIT. An unknown age counts as adult — the stricter reading. */
export const isAdultUser = (user) => {
    const age = resolveAge(user);
    return age === null || age > MINOR_AGE_LIMIT;
};

/**
 * Whether a family head manages this member: opens them from login, edits and
 * removes them. True for children, and for anyone without an email of their
 * own — a child the head added who has since grown up has no other way in.
 * Adults who joined by signing up on the family's number (email is required
 * for them) manage their own accounts. Rows need age, dob, email.
 */
export const isHeadManaged = (member) => !isAdultUser(member) || !member?.email;

/**
 * Return a copy of a user row with `age` corrected from `dob`.
 * Use before sending a profile to a client so nobody downstream sees a stale value.
 */
export const withResolvedAge = (user) => {
    if (!user) return user;
    const age = resolveAge(user);
    return age === null ? user : { ...user, age };
};
