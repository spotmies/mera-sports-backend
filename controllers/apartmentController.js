import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import XLSX from "xlsx";
import { supabaseAdmin } from "../config/supabaseClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Adjust path since we are in controllers/ now, not routes/
const EXCEL_FILE = path.join(__dirname, "../data/List of Pre -Listed Apartment ( 25.12.25).xlsx");

const readApartmentsFromExcel = () => {
    if (!fs.existsSync(EXCEL_FILE)) return [];
    try {
        const workbook = XLSX.readFile(EXCEL_FILE);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rawData = XLSX.utils.sheet_to_json(sheet);
        return rawData.map(row => {
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
        }).filter(item => item.name);
    } catch (error) { console.error("Excel Read Error:", error); return []; }
};

export const migrateApartments = async (req, res) => {
    try {
        const rawApartments = readApartmentsFromExcel();
        if (rawApartments.length === 0) return res.json({ success: false, message: "No data found." });

        const uniqueApartments = [];
        const seenNames = new Set();
        for (const apt of rawApartments) {
            const normalized = apt.name.toLowerCase().trim();
            if (!seenNames.has(normalized)) { seenNames.add(normalized); uniqueApartments.push(apt); }
        }

        const { error } = await supabaseAdmin.from("apartments").upsert(uniqueApartments.map(apt => ({
            name: apt.name, pincode: apt.pincode, locality: apt.locality, zone: apt.zone
        })), { onConflict: 'name' });

        if (error) throw error;
        res.json({ success: true, message: `Migrated ${uniqueApartments.length} apartments.`, count: uniqueApartments.length });
    } catch (err) { res.status(500).json({ success: false, message: "Migration failed: " + err.message }); }
};

export const getApartments = async (req, res) => {
    try {
        const { page, limit, search } = req.query;
        let query = supabaseAdmin.from("apartments").select("*", { count: 'exact' }).order('created_at', { ascending: false });

        if (search) {
            query = query.or(`name.ilike.%${search}%,locality.ilike.%${search}%,zone.ilike.%${search}%`);
        }

        if (page && limit) {
            const pageNum = parseInt(page, 10);
            const limitNum = parseInt(limit, 10);
            const from = (pageNum - 1) * limitNum;
            const to = from + limitNum - 1;
            query = query.range(from, to);
        }

        const { data, count, error } = await query;
        if (error) throw error;
        res.json({ success: true, apartments: data || [], total_count: count });
    } catch (error) { res.status(500).json({ success: false, message: "Failed to fetch apartments" }); }
};

export const addApartment = async (req, res) => {
    try {
        const { name, pincode, locality, zone } = req.body;
        if (!name || typeof name !== "string") return res.status(400).json({ success: false, message: "Invalid name" });

        const trimmedName = name.trim();
        const { data: existing } = await supabaseAdmin.from("apartments").select("id").ilike("name", trimmedName).maybeSingle();
        if (existing) return res.json({ success: false, message: "Apartment already exists" });

        const { data, error } = await supabaseAdmin.from("apartments").insert({ name: trimmedName, pincode: pincode || "", locality: locality || "", zone: zone || "" }).select().maybeSingle();
        if (error) throw error;
        res.json({ success: true, message: "Apartment added", apartment: data });
    } catch (error) { res.status(500).json({ success: false, message: "Failed to add apartment" }); }
};

export const updateApartment = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, pincode, locality, zone } = req.body;
        const updateData = {};
        if (name) updateData.name = name.trim();
        if (pincode !== undefined) updateData.pincode = pincode;
        if (locality !== undefined) updateData.locality = locality;
        if (zone !== undefined) updateData.zone = zone;

        const { data, error } = await supabaseAdmin.from("apartments").update(updateData).eq("id", id).select().maybeSingle();
        if (error) throw error;
        res.json({ success: true, message: "Apartment updated", apartment: data });
    } catch (error) { res.status(500).json({ success: false, message: "Failed to update" }); }
};

export const deleteApartment = async (req, res) => {
    try {
        const { error } = await supabaseAdmin.from("apartments").delete().eq("id", req.params.id);
        if (error) throw error;
        res.json({ success: true, message: "Apartment deleted" });
    } catch (error) { res.status(500).json({ success: false, message: "Failed to delete" }); }
};
