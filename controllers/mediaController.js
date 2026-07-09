import crypto from "crypto";
import { supabaseAdmin } from "../config/supabaseClient.js";

// Per-type limits
const MAX_VIDEO_SIZE = 6 * 1024 * 1024;   // 6 MB per video
const MAX_IMAGE_SIZE = 4 * 1024 * 1024;   // 4 MB per image
// 10 MB total storage cap per user
const MAX_STORAGE_PER_USER = 10 * 1024 * 1024; // 10 MB in bytes

// ────────────────────────────────────────────────────────────
// POST /api/player/upload-media
// ────────────────────────────────────────────────────────────
export const uploadMedia = async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, message: "No file provided" });
    }

    const playerId = req.user.id;
    const fileType = file.mimetype.startsWith("video/") ? "video" : "image";

    // Per-type size validation
    const maxForType = fileType === "video" ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;
    const limitLabel = fileType === "video" ? "6 MB" : "4 MB";
    if (file.size > maxForType) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
      return res.status(400).json({
        success: false,
        message: `${fileType === "video" ? "Video" : "Image"} too large (${sizeMB} MB). Maximum allowed is ${limitLabel}.`,
        code: "FILE_TOO_LARGE",
      });
    }

    // Check total storage used by this player
    const { data: usageRows, error: usageErr } = await supabaseAdmin
      .from("player_uploads")
      .select("file_size")
      .eq("player_id", playerId);

    if (usageErr) {
      console.error("USAGE CHECK ERROR:", usageErr);
      return res.status(500).json({ success: false, message: "Failed to check storage usage" });
    }

    const totalUsed = (usageRows || []).reduce((sum, r) => sum + (r.file_size || 0), 0);
    if (totalUsed + file.size > MAX_STORAGE_PER_USER) {
      const remainingMB = ((MAX_STORAGE_PER_USER - totalUsed) / (1024 * 1024)).toFixed(2);
      return res.status(400).json({
        success: false,
        message: `Storage limit reached. You have ${remainingMB} MB remaining out of 10 MB. Delete some files to free up space.`,
      });
    }

    // Build a unique storage path: <playerId>/<uuid>-<originalName>
    const storagePath = `${playerId}/${crypto.randomUUID()}-${file.originalname}`;

    // 1. Upload to Supabase Storage bucket "player_uploads"
    const { error: uploadErr } = await supabaseAdmin.storage
      .from("player_uploads")
      .upload(storagePath, file.buffer, { contentType: file.mimetype });

    if (uploadErr) {
      console.error("STORAGE UPLOAD ERROR:", uploadErr);
      return res.status(500).json({ success: false, message: "Failed to upload file to storage" });
    }

    // 2. Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from("player_uploads")
      .getPublicUrl(storagePath);

    // 3. Insert metadata row into player_uploads table
    const { data: row, error: dbErr } = await supabaseAdmin
      .from("player_uploads")
      .insert({
        player_id: playerId,
        file_name: file.originalname,
        file_url: urlData.publicUrl,
        file_type: fileType,
        mime_type: file.mimetype,
        file_size: file.size,
      })
      .select()
      .single();

    if (dbErr) {
      console.error("DB INSERT ERROR:", dbErr);
      // Best-effort: remove the orphaned storage object
      await supabaseAdmin.storage.from("player_uploads").remove([storagePath]);
      return res.status(500).json({ success: false, message: "Failed to save upload record" });
    }

    res.json({
      success: true,
      media: {
        id: row.id,
        url: row.file_url,
        name: row.file_name,
        type: row.file_type,
        size: row.file_size,
      },
    });
  } catch (err) {
    console.error("UPLOAD MEDIA ERROR:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ────────────────────────────────────────────────────────────
// GET /api/player/media
// ────────────────────────────────────────────────────────────
export const getMedia = async (req, res) => {
  try {
    const playerId = req.user.id;

    const { data, error } = await supabaseAdmin
      .from("player_uploads")
      .select("id, file_name, file_url, file_type, created_at")
      .eq("player_id", playerId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("GET MEDIA ERROR:", error);
      return res.status(500).json({ success: false, message: "Failed to fetch media" });
    }

    res.json({
      success: true,
      media: (data || []).map((m) => ({
        id: m.id,
        url: m.file_url,
        name: m.file_name,
        type: m.file_type,
        size: m.file_size,
      })),
    });
  } catch (err) {
    console.error("GET MEDIA ERROR:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ────────────────────────────────────────────────────────────
// DELETE /api/player/delete-media/:id
// ────────────────────────────────────────────────────────────
export const deleteMedia = async (req, res) => {
  try {
    const playerId = req.user.id;
    const mediaId = req.params.id;

    // 1. Fetch the row (ensure it belongs to this player)
    const { data: row, error: fetchErr } = await supabaseAdmin
      .from("player_uploads")
      .select("file_url")
      .eq("id", mediaId)
      .eq("player_id", playerId)
      .single();

    if (fetchErr || !row) {
      return res.status(404).json({ success: false, message: "Media not found" });
    }

    // 2. Extract storage path from public URL and delete from bucket
    const parts = row.file_url.split("/player_uploads/");
    if (parts.length > 1) {
      const storagePath = decodeURIComponent(parts[parts.length - 1]);
      const { error: removeErr } = await supabaseAdmin.storage
        .from("player_uploads")
        .remove([storagePath]);

      if (removeErr) {
        console.warn("STORAGE DELETE WARNING:", removeErr.message);
      }
    }

    // 3. Delete DB row
    const { error: deleteErr } = await supabaseAdmin
      .from("player_uploads")
      .delete()
      .eq("id", mediaId)
      .eq("player_id", playerId);

    if (deleteErr) {
      console.error("DB DELETE ERROR:", deleteErr);
      return res.status(500).json({ success: false, message: "Failed to delete media record" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE MEDIA ERROR:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};
