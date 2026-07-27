import { jsPDF } from "jspdf";
import QRCode from "qrcode";

/**
 * Server-side registration receipt PDF.
 *
 * The player app already renders a receipt in the browser (html2canvas), but
 * that only exists if the player reaches the success screen. Registrations
 * created by the payment.captured webhook or the reconcile endpoint never touch
 * the browser at all, so the receipt has to be generated here to be attachable
 * to the confirmation email.
 *
 * Returns a Buffer so the same output can be attached to mail or uploaded to the
 * bucket for a WhatsApp document-header template later.
 */

const INDIGO = [79, 70, 229];   // #4F46E5 — matches the email header
const SLATE = [71, 85, 105];
const MUTED = [107, 114, 128];

const formatCategories = (category) => {
    if (!Array.isArray(category)) return String(category ?? "-");
    return category
        .map((c) => {
            if (typeof c === "object" && c !== null) {
                return `${c.name}${c.gender ? ` (${c.gender})` : ""}${c.matchType ? ` - ${c.matchType}` : ""}`;
            }
            return String(c);
        })
        .join(", ") || "-";
};

const formatDate = (date) => {
    const d = date ? new Date(date) : new Date();
    return Number.isNaN(d.getTime()) ? new Date().toLocaleString("en-IN") : d.toLocaleString("en-IN");
};

/**
 * @param {object} details - { playerName, eventName, registrationNo, amount,
 *   category, date, status, paymentId, paymentMode }
 * @returns {Promise<Buffer>} PDF bytes
 */
export const generateReceiptPdf = async (details) => {
    const {
        playerName, eventName, registrationNo, amount, category, date, status,
        paymentId, paymentMode,
    } = details;

    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 48;
    const contentWidth = pageWidth - margin * 2;

    // ── Header band ──────────────────────────────────────────────────────────
    doc.setFillColor(...INDIGO);
    doc.rect(0, 0, pageWidth, 96, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(22);
    doc.text("SPORTS PARAMOUNT", margin, 46);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.text("Event Registration Receipt", margin, 68);

    // ── Registration number ──────────────────────────────────────────────────
    let y = 140;
    doc.setTextColor(...MUTED);
    doc.setFontSize(9);
    doc.text("REGISTRATION NUMBER", margin, y);
    doc.setTextColor(...INDIGO);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(String(registrationNo || "-"), margin, y + 24);

    // QR of the registration number for venue check-in
    try {
        const qr = await QRCode.toDataURL(String(registrationNo || ""), { margin: 0, width: 240 });
        doc.addImage(qr, "PNG", pageWidth - margin - 96, y - 18, 96, 96);
    } catch (qrErr) {
        console.warn("Receipt QR generation failed:", qrErr.message);
    }

    // ── Detail rows ──────────────────────────────────────────────────────────
    y += 76;
    doc.setDrawColor(226, 232, 240);
    doc.line(margin, y, margin + contentWidth, y);
    y += 28;

    const rows = [
        ["Player", playerName || "-"],
        ["Event", eventName || "-"],
        ["Categories", formatCategories(category)],
        ["Amount Paid", `Rs. ${amount ?? 0}`],
        ["Payment Mode", paymentMode === "razorpay" ? "Online (Razorpay)" : paymentMode === "manual" ? "Manual / UPI Transfer" : "-"],
        ["Payment ID", paymentId || "-"],
        ["Date", formatDate(date)],
        ["Status", String(status || "Confirmed")],
    ];

    const labelWidth = 130;
    for (const [label, value] of rows) {
        if (value === "-" && (label === "Payment ID" || label === "Payment Mode")) continue;

        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        doc.setTextColor(...MUTED);
        doc.text(label, margin, y);

        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        doc.setTextColor(...SLATE);
        // Long category lists must wrap rather than run off the page.
        const lines = doc.splitTextToSize(String(value), contentWidth - labelWidth);
        doc.text(lines, margin + labelWidth, y);

        y += Math.max(26, lines.length * 15 + 11);
    }

    // ── Footer ───────────────────────────────────────────────────────────────
    y += 8;
    doc.setDrawColor(226, 232, 240);
    doc.line(margin, y, margin + contentWidth, y);
    y += 24;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(...SLATE);
    doc.text("Please carry a valid photo ID (Aadhaar) to the venue for verification.", margin, y);

    y += 18;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text("This receipt is computer generated and valid for entry.", margin, y);

    doc.setFontSize(8);
    doc.text(
        `(c) ${new Date().getFullYear()} Sports Paramount`,
        margin,
        doc.internal.pageSize.getHeight() - 36
    );

    return Buffer.from(doc.output("arraybuffer"));
};

/** Consistent filename across mail attachments and bucket uploads. */
export const receiptFilename = (registrationNo) => `Receipt_${registrationNo || "registration"}.pdf`;
