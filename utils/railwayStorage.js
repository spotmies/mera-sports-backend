import { S3Client, PutObjectCommand, DeleteObjectsCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

/**
 * ============================================================
 * Railway Bucket (Tigris, S3-compatible) storage layer
 * ============================================================
 * One physical bucket (BUCKET_NAME); legacy Supabase bucket names
 * become key prefixes: <legacy-bucket>/<original-path>.
 *
 * The bucket is PRIVATE — public delivery goes through the API:
 *   GET /api/files/<legacy-bucket>/<path>  → 302 to a signed URL
 * So getPublicUrl() returns `${FILE_BASE_URL}/api/files/...`, keeping
 * DB-stored URLs stable no matter what storage backend sits behind.
 */

const BUCKET_ENDPOINT = process.env.BUCKET_ENDPOINT; // https://t3.storageapi.dev
const BUCKET_NAME = process.env.BUCKET_NAME;
// Public base for file URLs (the backend's own public URL, no trailing slash)
const FILE_BASE_URL = (process.env.FILE_BASE_URL || "").replace(/\/+$/, "");

export const LEGACY_BUCKETS = [
    "admin-assets",
    "event-assets",
    "event-documents",
    "player-photos",
    "player_uploads",
];

let s3 = null;
export function getS3() {
    if (!s3) {
        s3 = new S3Client({
            endpoint: BUCKET_ENDPOINT,
            region: process.env.BUCKET_REGION || "auto",
            credentials: {
                accessKeyId: process.env.BUCKET_ACCESS_KEY,
                secretAccessKey: process.env.BUCKET_SECRET_KEY,
            },
        });
    }
    return s3;
}

/** Signed GET URL for a private object (default 1 hour). */
export async function getSignedFileUrl(key, expiresIn = 3600) {
    return getSignedUrl(
        getS3(),
        new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }),
        { expiresIn }
    );
}

/**
 * Drop-in replacement for supabaseAdmin.storage — implements exactly the
 * surface the codebase uses: .from(bucket).upload/.remove/.getPublicUrl
 * with Supabase-style { data, error } returns.
 */
export const railwayStorage = {
    from(bucket) {
        return {
            async upload(path, body, options = {}) {
                try {
                    await getS3().send(new PutObjectCommand({
                        Bucket: BUCKET_NAME,
                        Key: `${bucket}/${path}`,
                        Body: body,
                        ContentType: options.contentType || "application/octet-stream",
                    }));
                    return { data: { path }, error: null };
                } catch (err) {
                    return { data: null, error: { message: err.message } };
                }
            },
            async remove(paths) {
                try {
                    await getS3().send(new DeleteObjectsCommand({
                        Bucket: BUCKET_NAME,
                        Delete: { Objects: paths.map((p) => ({ Key: `${bucket}/${p}` })) },
                    }));
                    return { data: paths, error: null };
                } catch (err) {
                    return { data: null, error: { message: err.message } };
                }
            },
            getPublicUrl(path) {
                return { data: { publicUrl: `${FILE_BASE_URL}/api/files/${bucket}/${path}` } };
            },
        };
    },
};
