import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import XLSX from "xlsx";
import { supabaseAdmin } from "../config/supabaseClient.js"; // Import Supabase Client

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXCEL_FILE = path.join(__dirname, "../data/List of Pre -Listed Apartment ( 25.12.25).xlsx");

// Helper to read data from Excel (Legacy / Migration Source)
const readApartmentsFromExcel = () => {
    if (!fs.existsSync(EXCEL_FILE)) {
        console.warn("Excel file not found:", EXCEL_FILE);
        return [];
    }
    try {
        const workbook = XLSX.readFile(EXCEL_FILE);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];

        // Read raw data
        const rawData = XLSX.utils.sheet_to_json(sheet);

        // Map to standardized format
        // Identifying columns by verifying content keys from first row if possible, 
        // but assuming standard names based on user request: "Apartment Name", "Pin", "Locality", "Zone"
        return rawData.map(row => {
            // Find keys dynamically to be robust against casing or slight variations
            const keys = Object.keys(row);
            const nameKey = keys.find(k => /name|apartment/i.test(k)) || "Apartment Name";
            const pinKey = keys.find(k => /pin/i.test(k)) || "Pin";
            const localityKey = keys.find(k => /locality/i.test(k)) || "Locality";
            const zoneKey = keys.find(k => /zone/i.test(k)) || "Zone";

            return {
                name: row[nameKey] ? String(row[nameKey]).trim() : "",
                pincode: row[pinKey] ? String(row[pinKey]).trim() : "",
                locality: row[localityKey] ? String(row[localityKey]).trim() : "",
                zone: row[zoneKey] ? String(row[zoneKey]).trim() : "",
            };
        }).filter(item => item.name); // Filter out empty rows
    } catch (error) {
        console.error("Error reading Excel file:", error);
        return [];
    }
};

// MIGRATION ENDPOINT: Reads Excel and Upserts to DB
router.post("/migrate", async (req, res) => {
    try {
        console.log("Starting Migration from Excel...");
        const rawApartments = readApartmentsFromExcel();

        if (rawApartments.length === 0) {
            return res.json({ success: false, message: "No data found in Excel or file missing." });
        }

        // Deduplicate based on name
        const uniqueApartments = [];
        const seenNames = new Set();

        for (const apt of rawApartments) {
            const normalized = apt.name.toLowerCase().trim();
            if (!seenNames.has(normalized)) {
                seenNames.add(normalized);
                uniqueApartments.push(apt);
            }
        }

        console.log(`Found ${rawApartments.length} rows. Deduplicated to ${uniqueApartments.length} unique apartments. Uploading...`);

        // Upsert to Supabase
        const { data, error } = await supabaseAdmin
            .from("apartments")
            .upsert(uniqueApartments.map(apt => ({
                name: apt.name,
                pincode: apt.pincode,
                locality: apt.locality,
                zone: apt.zone
            })), { onConflict: 'name' }); // Assumes 'name' is unique constraint in DB

        if (error) {
            console.error("Supabase Upsert Error:", error);
            throw error;
        }

        res.json({
            success: true,
            message: `Successfully migrated ${uniqueApartments.length} unique apartments to Database.`,
            count: uniqueApartments.length
        });

    } catch (err) {
        console.error("MIGRATION ERROR:", err);
        res.status(500).json({ success: false, message: "Migration failed: " + err.message });
    }
});

// GET all apartments (NOW FROM DB)
router.get("/", async (req, res) => {
    try {
        // Fetch from Database
        const { data: apartments, error } = await supabaseAdmin
            .from("apartments")
            .select("*")
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Fallback: If DB is empty, maybe auto-migrate? 
        // For now, just return what we have (or empty list)

        res.json({ success: true, apartments: apartments || [] });
    } catch (error) {
        console.error("READ APARTMENTS ERROR:", error);
        res.status(500).json({ success: false, message: "Failed to fetch apartments" });
    }
});

// POST add new apartment (DB)
router.post("/", async (req, res) => {
    try {
        const { name, pincode, locality, zone } = req.body;
        if (!name || typeof name !== "string") {
            return res.status(400).json({ success: false, message: "Invalid name" });
        }

        const trimmedName = name.trim();

        // Check for duplicates in DB
        const { data: existing } = await supabaseAdmin
            .from("apartments")
            .select("id")
            .ilike("name", trimmedName)
            .maybeSingle();

        if (existing) {
            return res.json({ success: true, message: "Apartment already exists" });
        }

        // Add to DB
        const { data, error } = await supabaseAdmin
            .from("apartments")
            .insert({
                name: trimmedName,
                pincode: pincode || "",
                locality: locality || "",
                zone: zone || ""
            })
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, message: "Apartment added successfully", apartment: data });

    } catch (error) {
        console.error("ADD APARTMENT ERROR:", error);
        res.status(500).json({ success: false, message: "Failed to add apartment" });
    }
});

// PUT update apartment (DB)
router.put("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { name, pincode, locality, zone } = req.body;

        if (!id) {
            return res.status(400).json({ success: false, message: "Apartment ID is required" });
        }

        const updateData = {};
        if (name) updateData.name = name.trim();
        if (pincode !== undefined) updateData.pincode = pincode;
        if (locality !== undefined) updateData.locality = locality;
        if (zone !== undefined) updateData.zone = zone;

        const { data, error } = await supabaseAdmin
            .from("apartments")
            .update(updateData)
            .eq("id", id)
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, message: "Apartment updated successfully", apartment: data });

    } catch (error) {
        console.error("UPDATE APARTMENT ERROR:", error);
        res.status(500).json({ success: false, message: "Failed to update apartment" });
    }
});

// DELETE apartment (DB)
router.delete("/:id", async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return res.status(400).json({ success: false, message: "Apartment ID is required" });
        }

        const { error } = await supabaseAdmin
            .from("apartments")
            .delete()
            .eq("id", id);

        if (error) throw error;

        res.json({ success: true, message: "Apartment deleted successfully" });

    } catch (error) {
        console.error("DELETE APARTMENT ERROR:", error);
        res.status(500).json({ success: false, message: "Failed to delete apartment" });
    }
});

export default router;
