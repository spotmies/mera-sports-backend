import { supabaseAdmin } from "../config/supabaseClient.js";

/**
 * Turns a user-supplied file name into something safe to embed in a storage key.
 * Returns "" when nothing usable survives, so callers fall back to a random key.
 */
function slugifyFileName(name) {
    if (!name || typeof name !== 'string') return '';
    return name
        .replace(/\.[^.]+$/, '')          // drop the extension — we derive it from the MIME type
        .normalize('NFKD')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
        .slice(0, 60);
}

/**
 * Uploads a Base64 string to Supabase Storage.
 * @param {string} base64Data - The Base64 string (must include data URI scheme data:type;base64,...)
 * @param {string} bucket - The Supabase Storage bucket name (e.g., 'event-assets', 'player-photos')
 * @param {string} folder - The folder path within the bucket (default: 'misc')
 * @param {string} [originalName] - Original file name; kept in the key so the UI can
 *   show a meaningful label (PDF attachments are displayed by file name, not thumbnail).
 * @returns {Promise<string|null>} - The public URL of the uploaded file, or null if failed.
 */
export async function uploadBase64(base64Data, bucket, folder = 'misc', originalName = '') {
    if (!base64Data || typeof base64Data !== 'string' || !base64Data.startsWith('data:')) {
        // If it's not base64, assume it's already a URL or return as is
        return base64Data;
    }

    try {
        // Match standard data URI format: data:[<mediatype>][;base64],<data>
        // Supports images and PDFs
        const matches = base64Data.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);

        if (!matches) {
            console.warn("Invalid base64 format.");
            return null;
        }

        const mimeType = matches[1];
        const rawData = matches[2];

        // Determine extension
        let ext = 'bin';
        if (mimeType === 'application/pdf') ext = 'pdf';
        else if (mimeType === 'image/jpeg') ext = 'jpg';
        else if (mimeType === 'image/png') ext = 'png';
        else if (mimeType === 'image/webp') ext = 'webp';
        else if (mimeType.startsWith('image/')) ext = mimeType.split('/')[1];

        const buffer = Buffer.from(rawData, 'base64');
        const slug = slugifyFileName(originalName);
        const unique = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const filename = `${folder}/${slug ? `${unique}_${slug}` : unique}.${ext}`;

        const { data, error } = await supabaseAdmin.storage
            .from(bucket)
            .upload(filename, buffer, { contentType: mimeType, upsert: true });

        if (error) {
            console.error(`Upload error for ${filename} in ${bucket}:`, error.message);
            throw error;
        }

        const { data: urlData } = supabaseAdmin.storage.from(bucket).getPublicUrl(filename);
        return urlData.publicUrl;

    } catch (err) {
        console.error("Upload Helper Failed:", err.message);
        return null; // Return null on failure so flow can decide valid behavior
    }
}
