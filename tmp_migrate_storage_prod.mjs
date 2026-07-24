// PROD storage migration: Supabase (akavbpikcamxgvuckqao) → Railway prod bucket
// Mirrors to migration-backups/prod/storage-mirror + sha256 manifest.
// Idempotent: skips objects already present in target with matching size.
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const SUPABASE_URL = "https://akavbpikcamxgvuckqao.supabase.co";
const SERVICE_KEY = process.env.SUPA_PROD_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const s3 = new S3Client({
  endpoint: "https://t3.storageapi.dev",
  region: "auto",
  credentials: {
    accessKeyId: process.env.PROD_BUCKET_KEY,
    secretAccessKey: process.env.PROD_BUCKET_SECRET,
  },
});
const TARGET_BUCKET = "allocated-cabinet-kcr-gxv";

const BUCKETS = ["admin-assets", "event-assets", "event-documents", "player-photos", "player_uploads"];
const MIRROR = "C:/Spotmies/Sports paramount/migration-backups/prod/storage-mirror";
const manifest = [];

async function listAll(bucket, prefix = "") {
  const out = [];
  let offset = 0;
  const limit = 100;
  for (;;) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
    for (const item of data) {
      const full = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null) {
        out.push(...(await listAll(bucket, full)));
      } else {
        out.push({ path: full, size: item.metadata?.size ?? null, mime: item.metadata?.mimetype ?? "application/octet-stream" });
      }
    }
    if (data.length < limit) break;
    offset += limit;
  }
  return out;
}

async function targetHas(key, size) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: TARGET_BUCKET, Key: key }));
    return head.ContentLength === size;
  } catch {
    return false;
  }
}

let total = 0, ok = 0, skipped = 0, failed = 0;
for (const bucket of BUCKETS) {
  let files;
  try {
    files = await listAll(bucket);
  } catch (e) {
    console.error(`❌ Cannot list bucket ${bucket}: ${e.message}`);
    continue;
  }
  console.log(`\n📦 ${bucket}: ${files.length} files`);
  for (const f of files) {
    total++;
    const key = `${bucket}/${f.path}`;
    try {
      if (f.size !== null && (await targetHas(key, f.size))) {
        skipped++;
        continue; // already migrated (delta-sync support for cutover re-run)
      }
      const { data, error } = await supabase.storage.from(bucket).download(f.path);
      if (error) throw new Error(error.message);
      const buf = Buffer.from(await data.arrayBuffer());
      const sha = crypto.createHash("sha256").update(buf).digest("hex");
      const localPath = path.join(MIRROR, bucket, f.path);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, buf);
      await s3.send(new PutObjectCommand({ Bucket: TARGET_BUCKET, Key: key, Body: buf, ContentType: f.mime }));
      const head = await s3.send(new HeadObjectCommand({ Bucket: TARGET_BUCKET, Key: key }));
      if (head.ContentLength !== buf.length) throw new Error(`size mismatch ${head.ContentLength} != ${buf.length}`);
      manifest.push(`${bucket}|${f.path}|${buf.length}|${sha}`);
      ok++;
      if (ok % 25 === 0) console.log(`  ...${ok} uploaded`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${key}: ${e.message}`);
    }
  }
}

fs.mkdirSync("C:/Spotmies/Sports paramount/migration-backups/prod", { recursive: true });
fs.writeFileSync("C:/Spotmies/Sports paramount/migration-backups/prod/storage_manifest.csv",
  "bucket|path|bytes|sha256\n" + manifest.join("\n") + "\n");
console.log(`\n=== DONE: total=${total} uploaded=${ok} skipped=${skipped} failed=${failed} ===`);
