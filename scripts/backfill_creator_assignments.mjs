// Creating an event no longer gives an admin access to it; only an assignment
// does (middleware/eventAccess.js). New events by an admin are assigned at
// creation, but events created before that change have no assignment row.
//
// This lists the events whose current admin creator would lose access, and with
// --apply gives each creator an explicit assignment so nothing disappears.
//
//   node scripts/backfill_creator_assignments.mjs                       dry run
//   node scripts/backfill_creator_assignments.mjs --skip <userId>,...   leave those creators out
//   node scripts/backfill_creator_assignments.mjs --apply [--skip ...]  write the rows
//
// Skip a former super admin: whoever was demoted should NOT keep the events they
// created, and the script cannot tell them apart from a regular admin.
import { supabaseAdmin } from "../config/supabaseClient.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const skipArg = args.indexOf("--skip");
const skip = new Set(skipArg >= 0 ? String(args[skipArg + 1] || "").split(",").filter(Boolean) : []);

const { data: events, error } = await supabaseAdmin.from("events").select("id, name, created_by, assigned_to").not("created_by", "is", null);
if (error) throw error;
const { data: assignments, error: aErr } = await supabaseAdmin.from("event_admin_assignments").select("event_id, admin_id");
if (aErr) throw aErr;
const { data: admins, error: uErr } = await supabaseAdmin.from("users").select("id, name, email").eq("role", "admin");
if (uErr) throw uErr;

const adminById = new Map(admins.map((a) => [String(a.id), a]));
const assigned = new Set(assignments.map((a) => `${a.event_id}:${a.admin_id}`));

const rows = events
    .filter((e) => adminById.has(String(e.created_by)))
    .filter((e) => String(e.assigned_to) !== String(e.created_by) && !assigned.has(`${e.id}:${e.created_by}`))
    .map((e) => ({ event: e, admin: adminById.get(String(e.created_by)), skipped: skip.has(String(e.created_by)) }));

for (const { event, admin, skipped } of rows) {
    console.log(`${skipped ? "SKIP " : apply ? "ADD  " : "WOULD"}  event ${event.id} "${event.name}"  ->  ${admin.name} <${admin.email}> (${admin.id})`);
}
const toWrite = rows.filter((r) => !r.skipped).map((r) => ({ event_id: r.event.id, admin_id: r.admin.id, assigned_by: r.admin.id }));
console.log(`\n${rows.length} event(s) affected, ${toWrite.length} to assign${apply ? "" : " (dry run — nothing written)"}.`);

if (apply && toWrite.length) {
    const { error: iErr } = await supabaseAdmin.from("event_admin_assignments").upsert(toWrite, { onConflict: "event_id,admin_id", ignoreDuplicates: true });
    if (iErr) throw iErr;
    console.log("Assignments written.");
}
process.exit(0);
