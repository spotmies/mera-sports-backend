// How an event takes entry fees, stored in events.payment_gateway (plain text):
//   "manual"   — player pays to the event's QR/UPI and uploads a screenshot
//   "razorpay" — player pays online, registration is confirmed instantly
//   "both"     — the player picks one of the two at checkout
// NULL or anything unrecognised is treated as "manual", the column default.
export const PAYMENT_GATEWAYS = ["manual", "razorpay", "both"];

export const normalizePaymentGateway = (value) =>
    PAYMENT_GATEWAYS.includes(value) ? value : "manual";

export const acceptsRazorpay = (value) => {
    const gateway = normalizePaymentGateway(value);
    return gateway === "razorpay" || gateway === "both";
};

export const acceptsManual = (value) => {
    const gateway = normalizePaymentGateway(value);
    return gateway === "manual" || gateway === "both";
};

// Fields that make up an event's payment settings. Fixed at creation; after
// that only a superadmin may change them.
export const PAYMENT_SETTING_FIELDS = ["payment_gateway", "payment_qr_image", "upi_id"];
