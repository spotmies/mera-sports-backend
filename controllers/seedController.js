
import { v4 as uuidv4 } from 'uuid';
import { supabaseAdmin } from "../config/supabaseClient.js"; // Reuse existing client config

export const seedTestEvent = async (req, res) => {
    try {
        console.log("🚀 Starting Event Seeding via API...");
        const responseLog = [];
        const log = (msg) => {
            console.log(msg);
            responseLog.push(msg);
        };

        // 1. Get or Create Super Admin (for created_by)
        const { data: { users }, error: userError } = await supabaseAdmin.auth.admin.listUsers();
        let superAdmin = users.find(u => u.email.includes('admin') || u.user_metadata?.role === 'superadmin');

        if (!superAdmin) {
            log("No Super Admin found. Creating one...");
            const { data: newAdmin, error } = await supabaseAdmin.auth.admin.createUser({
                email: `superadmin_${Date.now()}@merasports.com`,
                password: "password123",
                user_metadata: { role: 'superadmin', name: "Super Admin" },
                email_confirm: true
            });
            if (error) throw error;
            superAdmin = newAdmin.user;

            await supabaseAdmin.from("users").upsert({
                id: superAdmin.id,
                email: superAdmin.email,
                name: "Super Admin",
                role: "superadmin",
                verification: "verified"
            });
        }
        log(`Using Admin: ${superAdmin.email} (${superAdmin.id})`);

        // 2. Create Dummy Players
        log("Creating Dummy Players...");
        const players = [];
        for (let i = 1; i <= 32; i++) {
            const email = `player${i}_${Date.now()}@test.com`;
            const firstName = "Player";
            const lastName = `${i}`;
            const name = `${firstName} ${lastName}`;

            let { data: authUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
                email,
                password: "password123",
                user_metadata: { role: 'player', name },
                email_confirm: true
            });

            if (createError) {
                log(`⚠️ Failed to create player ${i}: ${createError.message}`);
                // Try to find if exists
                // For now just skip if error
                continue;
            }

            await supabaseAdmin.from("users").upsert({
                id: authUser.user.id,
                email,
                name,
                first_name: firstName,
                last_name: lastName,
                role: "player",
                verification: "verified",
                player_id: `P${1000 + i}`,
                mobile: `9${String(i).padStart(9, '0')}`,
                gender: i % 2 === 0 ? "Male" : "Female"
            });

            players.push({ id: authUser.user.id, name });
        }
        log(`✅ Created/Found ${players.length} players`);

        // 3. Define Categories
        const categories = [
            { id: uuidv4(), category: "Men's Singles", gender: "Male", type: "Singles", fee: 500 },
            { id: uuidv4(), category: "Women's Singles", gender: "Female", type: "Singles", fee: 500 },
            { id: uuidv4(), category: "Men's Doubles", gender: "Male", type: "Doubles", fee: 1000 },
            { id: uuidv4(), category: "Women's Doubles", gender: "Female", type: "Doubles", fee: 1000 },
            { id: uuidv4(), category: "Mixed Doubles", gender: "Mixed", type: "Doubles", fee: 1000 },
            { id: uuidv4(), category: "U-19 Boys Singles", gender: "Male", type: "Singles", fee: 400 }
        ];

        // 4. Create Event
        log("Creating Event...");
        const eventData = {
            name: "Mera Sports Championship 2026 API",
            sport: "Badminton",
            start_date: new Date(Date.now() + 86400000).toISOString().split('T')[0],
            end_date: new Date(Date.now() + 86400000 * 3).toISOString().split('T')[0],
            start_time: "09:00:00",
            location: "Mera Sports Arena",
            venue: "Arena 1",
            created_by: superAdmin.id,
            status: "upcoming",
            categories: categories,
            description: "A test event seeded via API.",
            poster_url: "https://placehold.co/600x400?text=Tournament+Banner"
        };

        const { data: event, error: eventError } = await supabaseAdmin.from("events").insert(eventData).select().single();

        if (eventError) throw eventError;
        log(`✅ Event Created: ${event.name} (ID: ${event.id})`);

        // 5. Register Players (Men's Singles)
        const msCategory = categories.find(c => c.category === "Men's Singles");
        const singlePlayers = players.slice(0, 16);
        
        const msRegistrations = singlePlayers.map(p => ({
            event_id: event.id,
            player_id: p.id,
            categories: [msCategory],
            status: "verified",
            amount_paid: msCategory.fee,
            registration_no: `REG-MS-${p.id.slice(0, 4)}`
        }));
        const { error: msRegError, count: registeredCount } = await supabaseAdmin.from("event_registrations").insert(msRegistrations).select('*', { count: 'exact' });
        if (msRegError) {
            log(`⚠️ Failed to register players: ${msRegError.message}`);
        }
        log(`✅ Registered ${registeredCount || msRegistrations.length}/${singlePlayers.length} players for Men's Singles`);

        // 6. Register Teams (Men's Doubles)
        const mdCategory = categories.find(c => c.category === "Men's Doubles");
        const doublePlayers = players.slice(16, 32);
        const teamsToCreate = [];
        for (let i = 0; i < doublePlayers.length; i += 2) {
            const p1 = doublePlayers[i];
            const p2 = doublePlayers[i + 1];
            if (p1 && p2) {
                teamsToCreate.push({
                    team_name: `${p1.name} & ${p2.name} Duo`,
                    sport: "Badminton",
                    captain_id: p1.id,
                    captain_name: p1.name,
                    members: [{ id: p2.id, name: p2.name, mobile: "9999999999" }],
                    status: "active"
                });
            }
        }

        const { data: createdTeams, error: teamsError } = await supabaseAdmin.from("player_teams").insert(teamsToCreate).select();
        if (teamsError) {
            log(`⚠️ Failed to create teams: ${teamsError.message}`);
        }

        let teamsRegistered = 0;
        if (createdTeams && createdTeams.length > 0) {
            const mdRegistrations = createdTeams.map(team => ({
                event_id: event.id,
                player_id: team.captain_id,
                team_id: team.id,
                categories: [mdCategory],
                status: "verified",
                amount_paid: mdCategory.fee,
                registration_no: `REG-MD-${team.id.slice(0, 4)}`
            }));
            const { error: mdRegError, count } = await supabaseAdmin.from("event_registrations").insert(mdRegistrations).select('*', { count: 'exact' });
            if (mdRegError) {
                log(`⚠️ Failed to register teams: ${mdRegError.message}`);
            } else {
                teamsRegistered = count || mdRegistrations.length;
            }
        }
        log(`✅ Registered ${teamsRegistered} teams for Men's Doubles`);

        res.json({ success: true, message: "Seeding Complete", log: responseLog, eventId: event.id });

    } catch (err) {
        console.error("Seeding Error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
};
