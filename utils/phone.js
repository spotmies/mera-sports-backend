/**
 * Indian mobile numbers — one rule for the whole API.
 *
 * Numbers are STORED as the bare 10 digits (users.mobile, family matching and
 * the OTP/WhatsApp helpers all rely on that). People TYPE them many ways:
 * "+91 98765 43210", "91-9876543210", "09876543210", "(98765) 43210".
 *
 * A prefix (+91 / 91 / 0) is only removed when exactly 10 digits remain, so a
 * genuine number that happens to start "91" is never truncated.
 * A valid number starts with 6, 7, 8 or 9.
 */

export const INDIAN_MOBILE_MESSAGE = "Enter a valid 10-digit Indian mobile number (starting with 6, 7, 8 or 9).";

const VALID_MOBILE = /^[6-9]\d{9}$/;

/** Strip formatting and an India prefix. Returns digits only (maybe not valid). */
export const cleanMobileDigits = (raw) => {
    const digits = String(raw ?? "").replace(/\D/g, "");
    if (digits.length === 10) return digits;
    if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
    if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
    return digits;
};

/** The canonical 10 digits, or null when the input is not a valid Indian mobile. */
export const normalizeIndianMobile = (raw) => {
    const digits = cleanMobileDigits(raw);
    return VALID_MOBILE.test(digits) ? digits : null;
};

export const isValidIndianMobile = (raw) => normalizeIndianMobile(raw) !== null;

/** "9876543210" -> "+91 98765 43210" (returns the input unchanged if not valid). */
export const formatIndianMobile = (raw) => {
    const n = normalizeIndianMobile(raw);
    return n ? `+91 ${n.slice(0, 5)} ${n.slice(5)}` : String(raw ?? "");
};
