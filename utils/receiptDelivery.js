import { supabaseAdmin } from "../config/supabaseClient.js";
import { getSignedFileUrl } from "./railwayStorage.js";
import { generateReceiptPdf, receiptFilename } from "./receiptPdf.js";

/**
 * Publish a registration receipt PDF to the bucket and return a URL Meta can
 * fetch when sending it as a WhatsApp document.
 *
 * The bucket is private, and the public `/api/files/...` route answers with a
 * 302 to a signed URL. Meta's media fetcher is not reliable about following
 * redirects, so the signed URL is handed over directly instead.
 *
 * Returns null on any failure — the caller falls back to the text-only
 * confirmation rather than dropping the message entirely.
 */

const RECEIPT_BUCKET = "event-documents";
const RECEIPT_FOLDER = "receipts";
// WhatsApp downloads the document during the send call and caches it after
// delivery, so the link only has to survive that request. An hour is generous.
const SIGNED_URL_TTL_SECONDS = 3600;

export const publishReceiptPdf = async (details) => {
    const { registrationNo } = details;
    if (!registrationNo) return null;

    try {
        const pdf = await generateReceiptPdf(details);
        const filename = receiptFilename(registrationNo);
        const path = `${RECEIPT_FOLDER}/${registrationNo}.pdf`;

        const { error } = await supabaseAdmin.storage
            .from(RECEIPT_BUCKET)
            .upload(path, pdf, { contentType: "application/pdf", upsert: true });

        if (error) {
            console.error("Receipt upload failed:", error.message);
            return null;
        }

        const documentUrl = await getSignedFileUrl(`${RECEIPT_BUCKET}/${path}`, SIGNED_URL_TTL_SECONDS);
        return { documentUrl, filename };
    } catch (err) {
        console.error("Receipt publish failed:", err.message);
        return null;
    }
};
