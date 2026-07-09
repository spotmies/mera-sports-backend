import bcrypt from "bcryptjs";
import crypto from "crypto";
import * as xlsx from "xlsx";
import { supabaseAdmin } from "../config/supabaseClient.js";

// 1. POST /api/institute/request-bulk-approval
export const updateInstituteProfile = async (req, res) => {
    try {
        const { id: institute_id } = req.user;
        const { instituteName, email, contactNumber, website, address } = req.body;

        if (!instituteName || !email || !contactNumber) {
            return res.status(400).json({ success: false, message: "Institute Name, Email, and Contact Number are required." });
        }

        const { data, error } = await supabaseAdmin
            .from("users")
            .update({
                name: instituteName,
                institute_name: instituteName,
                email: email,
                mobile: contactNumber,
                website: website || null,
                apartment: address || null
            })
            .eq("id", institute_id)
            .select("id, institute_name, name, email, role, verification")
            .single();

        if (error) {
            console.error("Supabase update error:", error);
            return res.status(500).json({ success: false, message: "Failed to update profile to database." });
        }

        res.json({
            success: true,
            message: "Profile updated successfully.",
            user: {
                id: data.id,
                instituteName: data.institute_name || data.name,
                email: data.email,
                role: data.role,
                status: data.verification
            }
        });
    } catch (err) {
        console.error("UPDATE INSTITUTE ERROR:", err);
        res.status(500).json({ success: false, message: "Internal server error while updating profile." });
    }
};

// 2. POST /api/institute/request-bulk-approval
export const requestBulkApproval = async (req, res) => {
    try {
        const { id: institute_id } = req.user;
        const { student_count } = req.body;

        if (!student_count || student_count <= 0) {
            return res.status(400).json({ success: false, message: "Valid student_count is required." });
        }

        // Fetch institute name
        const { data: institute, error: instError } = await supabaseAdmin
            .from("users")
            .select("name, institute_name")
            .eq("id", institute_id)
            .single();

        if (instError || !institute) {
            return res.status(404).json({ success: false, message: "Institute not found." });
        }

        const resolvedInstituteName = institute.institute_name || institute.name || "Unknown Institute";

        // Create approval request
        const { error: insertError } = await supabaseAdmin
            .from("institute_approvals")
            .insert({
                institute_id,
                institute_name: resolvedInstituteName,
                student_count,
                is_approved: false
            });

        if (insertError) throw insertError;

        res.json({ success: true, message: "Approval request submitted successfully." });
    } catch (err) {
        console.error("REQUEST APPROVAL ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to request approval" });
    }
};

// 2. GET /api/institute/approval-status
export const getApprovalStatus = async (req, res) => {
    try {
        const { id: institute_id } = req.user;

        const { data: approval, error } = await supabaseAdmin
            .from("institute_approvals")
            .select("is_approved")
            .eq("institute_id", institute_id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) throw error;

        // If no record exists (never requested or already finalized/deleted)
        if (!approval) {
            return res.json({ success: true, is_approved: null, message: "No pending requests found." });
        }

        res.json({ success: true, is_approved: approval.is_approved });
    } catch (err) {
        console.error("GET APPROVAL STATUS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to check approval status" });
    }
};

// 3. POST /api/institute/bulk-import-finalize
export const finalizeBulkImport = async (req, res) => {
    try {
        const { id: institute_id } = req.user;
        const { excelBase64 } = req.body;

        if (!excelBase64) {
            return res.status(400).json({ success: false, message: "No excel file provided for import." });
        }

        // CRITICAL SECURITY CHECK: Verify if this institute is approved
        const { data: approval, error: checkError } = await supabaseAdmin
            .from("institute_approvals")
            .select("id, is_approved, institute_name")
            .eq("institute_id", institute_id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (checkError) throw checkError;

        if (!approval) {
            return res.status(403).json({ success: false, message: "No approval request found for this institute." });
        }
        if (!approval.is_approved) {
            return res.status(403).json({ success: false, message: "Your bulk import request has not been approved yet." });
        }

        const resolvedInstituteName = approval.institute_name;

        // Decode Base64 and Parse Excel
        const base64Data = excelBase64.replace(/^data:.*,/, "");
        const buffer = Buffer.from(base64Data, "base64");
        const workbook = xlsx.read(buffer, { type: "buffer", cellDates: true });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const rawStudents = xlsx.utils.sheet_to_json(worksheet, { defval: "" });

        if (!rawStudents || rawStudents.length === 0) {
            return res.status(400).json({ success: false, message: "The uploaded Excel sheet is empty." });
        }

        const successful = [];
        const failed = [];

        // ── PHASE 1: Parse every row (DOB + field extraction) ─────────────────
        // Fast synchronous pass — no I/O, no hashing yet.
        // Rows that fail DOB parsing go straight to failed[].
        const parsedStudents = [];

        for (const row of rawStudents) {
            const fName = String(row.first_name || row.FirstName || row["First Name"] || "").trim();
            const lName = String(row.last_name || row.LastName || row["Last Name"] || "").trim();

            // ── Parse Date of Birth ──────────────────────────────────────────
            let parsedDob = row.dob || row.DoB || row["Date of Birth (DD-MM-YYYY)"] || row["Date of Birth"] || null;

            if (parsedDob instanceof Date) {
                parsedDob = parsedDob.toISOString().split("T")[0];               // JS Date → YYYY-MM-DD
            } else if (typeof parsedDob === "number") {
                // Excel serial date fallback
                const excelEpoch = new Date(Date.UTC(1899, 11, 30));
                parsedDob = new Date(excelEpoch.getTime() + parsedDob * 86400000).toISOString().split("T")[0];
            } else if (typeof parsedDob === "string" && parsedDob.trim() !== "") {
                // Handle DD-MM-YYYY string
                const ddmmyyyy = parsedDob.trim().match(/^(\d{2})[-\/](\d{2})[-\/](\d{4})$/);
                if (ddmmyyyy) {
                    parsedDob = `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;  // → YYYY-MM-DD
                } else {
                    const d = new Date(parsedDob);
                    parsedDob = !isNaN(d.getTime()) ? d.toISOString().split("T")[0] : null;
                }
            } else {
                parsedDob = null;
            }

            if (!parsedDob) {
                failed.push({
                    row,
                    errorField: "dob",
                    reason: "Date of Birth is required to generate password or date format is invalid."
                });
                continue;
            }

            // Plain-text DDMMYYYY password (same convention as manual registration)
            const [dobYear, dobMonth, dobDay] = parsedDob.split("-");
            const plainPassword = `${dobDay}${dobMonth}${dobYear}`;

            parsedStudents.push({ row, fName, lName, parsedDob, plainPassword });
        }

        // ── PHASE 2: Throttled bcrypt hashing in batches of 2 ──────────────────
        // INTENTIONALLY CONSERVATIVE — protects concurrent individual registrations.
        //
        // With UV_THREADPOOL_SIZE=16 (set in server.js), the thread pool has 16 slots.
        // We only consume 2 at a time, leaving 14 free for any simultaneous:
        //   • Individual player registrations
        //   • Admin logins / OTP requests
        //   • Any other bcrypt operations
        //
        // A 50ms delay between batches also gives Supabase connection pool breathing
        // room so concurrent DB inserts from other requests are never blocked.
        //
        // Example — 200 students with HASH_BATCH=2:
        //   100 batches × ~80ms per batch + 100 × 50ms delay = ~13 seconds total
        //   This is acceptable since the frontend shows a loader during import.
        const BCRYPT_COST = 10;
        const HASH_BATCH = 2;  // Conservative: only 2 concurrent bcrypt ops at a time
        const BATCH_DELAY_MS = 50; // Breathing room between batches for other requests
        const hashedStudents = [];

        for (let i = 0; i < parsedStudents.length; i += HASH_BATCH) {
            const batch = parsedStudents.slice(i, i + HASH_BATCH);

            const batchResults = await Promise.all(
                batch.map(async (student) => {
                    try {
                        const hashedPassword = await bcrypt.hash(student.plainPassword, BCRYPT_COST);
                        return { ...student, hashedPassword, hashError: null };
                    } catch (hashErr) {
                        return { ...student, hashedPassword: null, hashError: hashErr.message };
                    }
                })
            );

            for (const result of batchResults) {
                if (result.hashError) {
                    console.error("Bcrypt hash error:", result.hashError);
                    failed.push({ row: result.row, errorField: null, reason: "Failed to hash password." });
                } else {
                    hashedStudents.push(result);
                }
            }

            // Breathing delay: yield to event loop so other incoming requests
            // (individual registrations, logins) are processed between batches.
            if (i + HASH_BATCH < parsedStudents.length) {
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
            }
        }

        // ── PHASE 3: Sequential player_id generation + DB insert ──────────────
        // Player ID generation is deliberately kept sequential to guarantee
        // the DB sequence (P1001, P1002 …) is assigned without gaps or races.
        // A 30ms yield between inserts prevents Supabase connection pool saturation
        // and ensures concurrent individual registrations always find a free slot.
        for (const { row, fName, lName, parsedDob, hashedPassword } of hashedStudents) {
            const { data: newPlayerId, error: pidError } = await supabaseAdmin.rpc("get_next_player_id");
            if (pidError || !newPlayerId) {
                console.error("Failed to generate player_id:", pidError);
                failed.push({ row, errorField: null, reason: "Failed to generate a Player ID for system registration." });
                continue;
            }

            const student = {
                id: crypto.randomUUID(),
                player_id: newPlayerId,
                first_name: fName || null,
                last_name: lName || null,
                name: `${fName} ${lName}`.trim() || null,
                email: row.email || row.Email || null,
                mobile: row.mobile ? String(row.mobile).replace(/\D/g, "") : null,
                aadhaar: (row.aadhaar || row.Aadhaar || row["Aadhaar Number"])
                    ? String(row.aadhaar || row.Aadhaar || row["Aadhaar Number"]).replace(/\D/g, "")
                    : null,
                dob: parsedDob,
                gender: row.gender || row.Gender || null,
                apartment: row.apartment || row.Apartment || null,
                city: row.city || row.City || null,
                state: row.state || row.State || null,
                pincode: row.pincode ? String(row.pincode) : null,
                country: row.country || row.Country || null,
                password: hashedPassword,
                role: "player",
                verification: "verified",
                institute_name: resolvedInstituteName
            };

            const { error: insertError } = await supabaseAdmin.from("users").insert(student);

            // 30ms yield after each insert — lets other pending DB requests (individual
            // player registrations) acquire Supabase connection pool slots between inserts.
            await new Promise(resolve => setTimeout(resolve, 30));

            if (insertError) {
                let reason = insertError.message;
                let errorField = null;
                const msg = insertError.message?.toLowerCase() || "";

                if (msg.includes("duplicate key value") || insertError.code === "23505") {
                    if (msg.includes("email")) { reason = "Email already exists in the users table."; errorField = "email"; }
                    else if (msg.includes("mobile")) { reason = "Mobile number already exists in the users table."; errorField = "mobile"; }
                    else if (msg.includes("aadhaar")) { reason = "Aadhaar number already exists in the users table."; errorField = "aadhaar"; }
                    else { reason = "Duplicate unique field already exists."; }
                }

                failed.push({ row, errorField, reason });
            } else {
                successful.push({ first_name: student.first_name, email: student.email });
            }
        }

        // DELETE the approval record so it cannot be reused
        await supabaseAdmin.from("institute_approvals").delete().eq("id", approval.id);

        return res.status(200).json({
            success: true,
            message: failed.length > 0
                ? "Import finished. Some records require correction."
                : "Import finished successfully.",
            results: { successful, failed }
        });

    } catch (err) {
        console.error("FINALIZE BULK IMPORT ERROR:", err);
        return res.status(500).json({ success: false, message: "Failed to finalize bulk import: " + err.message });
    }
};

// 4. GET /api/institute/approved-players
export const getApprovedPlayers = async (req, res) => {
    try {
        const { id: institute_id } = req.user;

        // Fetch institute name
        const { data: institute, error: instError } = await supabaseAdmin
            .from("users")
            .select("name, institute_name")
            .eq("id", institute_id)
            .single();

        if (instError || !institute) {
            return res.status(404).json({ success: false, message: "Institute not found." });
        }

        const resolvedInstituteName = institute.institute_name || institute.name || "Unknown Institute";

        // Query the database to find all players belonging to this institute_name
        const { data: players, error } = await supabaseAdmin
            .from("users")
            .select("first_name, last_name, dob, gender, mobile, email, aadhaar, created_at")
            .eq("institute_name", resolvedInstituteName)
            .eq("role", "player")
            .order("created_at", { ascending: false });

        if (error) throw error;

        return res.status(200).json({
            success: true,
            players: players || []
        });

    } catch (err) {
        console.error("GET APPROVED PLAYERS ERROR:", err);
        return res.status(500).json({ success: false, message: "Failed to retrieve approved players" });
    }
};
