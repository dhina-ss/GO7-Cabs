const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_9UXzhcyKJA8g@ep-plain-sunset-azdt3ba9.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
    res.setHeader('ngrok-skip-browser-warning', 'true');
    res.setHeader('bypass-tunnel-reminder', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

// Health / Ping Endpoint (Instant 200 OK for keep-alive bots & monitors)
app.get(['/ping', '/api/health'], (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime(), time: new Date().toISOString() });
});

app.use(express.static(path.join(__dirname)));

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Helper: Format Currency Numbers (safe with commas and formatted strings)
function formatAmount(val) {
    if (!val) return 0;
    if (typeof val === 'number') return val;
    const clean = String(val).replace(/,/g, '').replace(/[^0-9.-]/g, '');
    return parseFloat(clean) || 0;
}

// Ensure soft delete, timestamp, and driver_amounts columns exist
async function initDatabaseSchema() {
    try {
        await pool.query(`
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
            ALTER TABLE trips ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
            ALTER TABLE trips ADD COLUMN IF NOT EXISTS trip_code VARCHAR(50);
            ALTER TABLE trips ADD COLUMN IF NOT EXISTS driver_amounts JSONB;
            ALTER TABLE trips ADD COLUMN IF NOT EXISTS expense_details JSONB;
            CREATE TABLE IF NOT EXISTS expense_categories (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL,
                system_key VARCHAR(50),
                is_system BOOLEAN DEFAULT false,
                is_deleted BOOLEAN DEFAULT false,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS system_key VARCHAR(50);
        `);

        // Seed default expense categories if none exist
        const catRes = await pool.query("SELECT COUNT(*) FROM expense_categories WHERE COALESCE(is_deleted, false) = false");
        if (parseInt(catRes.rows[0].count, 10) === 0) {
            const defaults = [
                { name: 'Fuel', system_key: 'fuel' },
                { name: 'Tolls', system_key: 'tolls' },
                { name: 'Allowance', system_key: 'allowance' },
                { name: 'Maintenance', system_key: 'maintenance' },
                { name: 'Others', system_key: 'others' }
            ];
            for (const c of defaults) {
                await pool.query(
                    "INSERT INTO expense_categories (name, system_key, is_system) VALUES ($1, $2, true) ON CONFLICT (name) DO NOTHING",
                    [c.name, c.system_key]
                );
            }
            console.log('[OK] Seeded default expense categories');
        }

        // Backfill system_key on existing categories if missing
        await pool.query(`
            UPDATE expense_categories SET system_key = 'fuel' WHERE (system_key IS NULL OR system_key = '') AND LOWER(name) IN ('fuel', 'petrol', 'diesel');
            UPDATE expense_categories SET system_key = 'tolls' WHERE (system_key IS NULL OR system_key = '') AND LOWER(name) IN ('tolls', 'toll', 'toll gate');
            UPDATE expense_categories SET system_key = 'allowance' WHERE (system_key IS NULL OR system_key = '') AND LOWER(name) IN ('allowance', 'bata');
            UPDATE expense_categories SET system_key = 'maintenance' WHERE (system_key IS NULL OR system_key = '') AND LOWER(name) IN ('maintenance', 'service');
            UPDATE expense_categories SET system_key = 'others' WHERE (system_key IS NULL OR system_key = '') AND LOWER(name) IN ('others', 'other', 'misc');
        `);

        // Get current category names mapping
        const allCatsRes = await pool.query("SELECT name, system_key FROM expense_categories WHERE COALESCE(is_deleted, false) = false");
        let fuelName = 'Fuel', tollsName = 'Tolls', allowanceName = 'Allowance', othersName = 'Others';
        allCatsRes.rows.forEach(c => {
            if (c.system_key === 'fuel') fuelName = c.name;
            else if (c.system_key === 'tolls') tollsName = c.name;
            else if (c.system_key === 'allowance') allowanceName = c.name;
            else if (c.system_key === 'others') othersName = c.name;
        });

        // Backfill expense_details on trips where it is null
        const tripsWithoutDetails = await pool.query("SELECT id, fuel, tolls, allowance, others FROM trips WHERE expense_details IS NULL");
        for (const tr of tripsWithoutDetails.rows) {
            const f = formatAmount(tr.fuel);
            const tol = formatAmount(tr.tolls);
            const al = formatAmount(tr.allowance);
            const oth = formatAmount(tr.others);
            const details = {};
            if (f > 0) details[fuelName] = f;
            if (tol > 0) details[tollsName] = tol;
            if (al > 0) details[allowanceName] = al;
            if (oth > 0) details[othersName] = oth;
            await pool.query("UPDATE trips SET expense_details = $1 WHERE id = $2", [JSON.stringify(details), tr.id]);
        }

        // Backfill missing trip_code values if any exist
        const unassignedTrips = await pool.query('SELECT id FROM trips WHERE trip_code IS NULL ORDER BY id ASC');
        if (unassignedTrips.rows.length > 0) {
            const curYr = new Date().getFullYear().toString().slice(-2);
            for (let i = 0; i < unassignedTrips.rows.length; i++) {
                const code = `GO7C${curYr}${String(i + 1).padStart(3, '0')}`;
                await pool.query('UPDATE trips SET trip_code = $1 WHERE id = $2', [code, unassignedTrips.rows[i].id]);
            }
            console.log(`[OK] Backfilled ${unassignedTrips.rows.length} trips with GO7C{YY}{INCREMENT} trip_code`);
        }
        await syncAllDriverStats();
        console.log('[OK] Database schema verified & driver earnings recalculated with live split expense deduction');
    } catch (err) {
        console.warn('DB schema init warning:', err.message);
    }
}

// Compute live driver statistics dynamically from active trips
async function syncAllDriverStats() {
    try {
        const driversRes = await pool.query("SELECT * FROM drivers WHERE COALESCE(is_deleted, false) = false AND status != 'Deleted'");
        const tripsRes = await pool.query("SELECT * FROM trips WHERE COALESCE(is_deleted, false) = false");
        const allTrips = tripsRes.rows;

        const liveStats = {};

        for (const drv of driversRes.rows) {
            let count = 0;
            let netEarningsSum = 0;
            let totalIncome = 0;
            let totalExpense = 0;
            const drvNameLower = String(drv.name || '').trim().toLowerCase();

            allTrips.forEach(t => {
                const names = String(t.driver_name || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                const isAssigned = names.includes(drvNameLower) || t.driver_id === drv.id;

                if (isAssigned) {
                    count++;
                    const numDrivers = names.length || 1;
                    const inc = formatAmount(t.income);
                    const f = formatAmount(t.fuel);
                    const tol = formatAmount(t.tolls);
                    const al = formatAmount(t.allowance);
                    const oth = formatAmount(t.others);
                    const totalExp = f + tol + al + oth;

                    const expPerDriver = totalExp / numDrivers;
                    let incPerDriver = inc / numDrivers;

                    // For multi-driver trips, check for custom driver_amounts (with comma-safe parsing)
                    if (numDrivers > 1 && t.driver_amounts) {
                        let dAmts = t.driver_amounts;
                        if (typeof dAmts === 'string') {
                            try { dAmts = JSON.parse(dAmts); } catch (e) {}
                        }
                        if (dAmts && typeof dAmts === 'object') {
                            for (let k in dAmts) {
                                if (k.trim().toLowerCase() === drvNameLower) {
                                    const parsedVal = formatAmount(dAmts[k]);
                                    if (parsedVal > 0) {
                                        incPerDriver = parsedVal;
                                        break;
                                    }
                                }
                            }
                        }
                    } else if (numDrivers === 1) {
                        incPerDriver = inc;
                    }

                    const netEarningsForTrip = incPerDriver - expPerDriver;
                    totalIncome += incPerDriver;
                    totalExpense += expPerDriver;
                    netEarningsSum += netEarningsForTrip;
                }
            });

            liveStats[drv.id] = {
                trips_count: count,
                total_earnings: Math.round(netEarningsSum * 100) / 100,
                total_income: Math.round(totalIncome * 100) / 100,
                total_expense: Math.round(totalExpense * 100) / 100
            };

            await pool.query(
                `UPDATE drivers SET trips_count = $1, total_earnings = $2 WHERE id = $3`,
                [count, Math.round(netEarningsSum * 100) / 100, drv.id]
            );
        }
        return liveStats;
    } catch (err) {
        console.warn('Sync driver stats warning:', err.message);
        return {};
    }
}

initDatabaseSchema();

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// 1. Dashboard Bento Stats
app.get('/api/stats', async (req, res) => {
    try {
        const { month } = req.query; // 'YYYY-MM' or 'all'
        let query = `
            SELECT 
                COUNT(*) as total_trips,
                COALESCE(SUM(income), 0) as total_income,
                COALESCE(SUM(fuel + tolls + allowance + others), 0) as total_expense,
                COALESCE(SUM(net_profit), 0) as net_profit
            FROM trips
            WHERE COALESCE(is_deleted, false) = false
        `;
        const params = [];
        if (month && month !== 'all') {
            query += ' AND TO_CHAR(trip_date, \'YYYY-MM\') = $1';
            params.push(month);
        }

        const result = await pool.query(query, params);
        const row = result.rows[0];
        res.json({
            success: true,
            data: {
                total_trips: parseInt(row.total_trips, 10),
                total_income: parseFloat(row.total_income),
                total_expense: parseFloat(row.total_expense),
                net_profit: parseFloat(row.net_profit),
                selectedMonth: month || 'all'
            }
        });
    } catch (err) {
        console.error('API /api/stats Error:', err.message);
        res.json({
            success: true,
            data: { total_trips: 0, total_income: 0, total_expense: 0, net_profit: 0 }
        });
    }
});

// 2. Get All Drivers (with LIVE calculated statistics from trips)
app.get('/api/drivers', async (req, res) => {
    try {
        const liveStats = await syncAllDriverStats();
        const { search } = req.query;
        let query = "SELECT * FROM drivers WHERE COALESCE(is_deleted, false) = false AND status != 'Deleted'";
        let params = [];

        if (search) {
            query += ' AND (LOWER(name) LIKE $1 OR LOWER(id) LIKE $1)';
            params.push(`%${search.toLowerCase()}%`);
        }

        query += ' ORDER BY created_at DESC';

        const result = await pool.query(query, params);
        
        // Merge LIVE calculated values so client never displays stale/zero DB columns
        const driversWithLiveStats = result.rows.map(drv => {
            const live = liveStats[drv.id] || {};
            return {
                ...drv,
                trips_count: live.trips_count !== undefined ? live.trips_count : parseInt(drv.trips_count || 0, 10),
                total_earnings: live.total_earnings !== undefined ? live.total_earnings : parseFloat(drv.total_earnings || 0),
                total_income: live.total_income || 0,
                total_expense: live.total_expense || 0
            };
        });

        res.json({ success: true, data: driversWithLiveStats });
    } catch (err) {
        console.error('API /api/drivers Error:', err.message);
        res.json({ success: true, data: [] });
    }
});

// 3. Get Single Driver Details (with LIVE calculated statistics)
app.get('/api/drivers/:id', async (req, res) => {
    try {
        const liveStats = await syncAllDriverStats();
        const { id } = req.params;
        const driverRes = await pool.query('SELECT * FROM drivers WHERE id = $1 AND COALESCE(is_deleted, false) = false', [id]);

        if (driverRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Driver not found' });
        }

        const drv = driverRes.rows[0];
        const drvNameLower = String(drv.name || '').trim().toLowerCase();

        // Match trips assigned by driver_id or matching driver_name
        const tripsRes = await pool.query(
            `SELECT * FROM trips 
             WHERE (driver_id = $1 OR LOWER(driver_name) LIKE $2) 
               AND COALESCE(is_deleted, false) = false 
             ORDER BY trip_date DESC, created_at DESC`,
            [id, `%${drvNameLower}%`]
        );

        const live = liveStats[drv.id] || {};

        res.json({
            success: true,
            data: {
                driver: {
                    ...drv,
                    trips_count: live.trips_count !== undefined ? live.trips_count : tripsRes.rows.length,
                    total_earnings: live.total_earnings !== undefined ? live.total_earnings : parseFloat(drv.total_earnings || 0),
                    total_income: live.total_income || 0,
                    total_expense: live.total_expense || 0
                },
                trips: tripsRes.rows
            }
        });
    } catch (err) {
        console.error('API /api/drivers/:id Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Create New Driver
app.post('/api/drivers', async (req, res) => {
    try {
        const { name, phone } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, message: 'Driver name is required' });
        }

        // Generate ID in format DR{YY}{INCREMENT} (e.g. DR26001) - Never reuse deleted IDs
        const currentYear = new Date().getFullYear().toString().slice(-2); // "26"
        const prefix = `DR${currentYear}`;

        const maxRes = await pool.query(`
            SELECT COALESCE(MAX(
                CAST(SUBSTRING(id FROM ${prefix.length + 1}) AS INTEGER)
            ), 0) as max_seq 
            FROM drivers 
            WHERE id LIKE $1
        `, [`${prefix}%`]);

        const nextSeq = parseInt(maxRes.rows[0].max_seq, 10) + 1;
        const newId = `${prefix}${String(nextSeq).padStart(3, '0')}`;

        const insertRes = await pool.query(
            'INSERT INTO drivers (id, name, phone, status) VALUES ($1, $2, $3, $4) RETURNING *',
            [newId, name, phone || '', 'Active']
        );

        res.status(201).json({ success: true, data: insertRes.rows[0] });
    } catch (err) {
        console.error('API POST /api/drivers Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. Update Driver
app.put('/api/drivers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, phone } = req.body;

        const updateRes = await pool.query(
            'UPDATE drivers SET name = COALESCE($1, name), phone = COALESCE($2, phone), updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
            [name, phone, id]
        );

        if (updateRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Driver not found' });
        }

        res.json({ success: true, data: updateRes.rows[0] });
    } catch (err) {
        console.error('API PUT /api/drivers/:id Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 6. Get All Trips
app.get('/api/trips', async (req, res) => {
    try {
        const { search, startDate, endDate } = req.query;
        let query = 'SELECT * FROM trips WHERE COALESCE(is_deleted, false) = false';
        let params = [];
        let pCount = 1;

        if (search) {
            query += ` AND (LOWER(driver_name) LIKE $${pCount} OR LOWER(from_location) LIKE $${pCount} OR LOWER(to_location) LIKE $${pCount} OR LOWER(trip_type) LIKE $${pCount} OR LOWER(trip_code) LIKE $${pCount})`;
            params.push(`%${search.toLowerCase()}%`);
            pCount++;
        }

        if (startDate && endDate) {
            query += ` AND trip_date BETWEEN $${pCount} AND $${pCount + 1}`;
            params.push(startDate, endDate);
            pCount += 2;
        }

        query += ' ORDER BY trip_date DESC, created_at DESC';

        const result = await pool.query(query, params);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('API /api/trips Error:', err.message);
        res.json({ success: true, data: [] });
    }
});

// 7. Create New Trip
app.post('/api/trips', async (req, res) => {
    try {
        const {
            driver_name,
            driver_amounts,
            expense_details,
            trip_date,
            trip_type,
            from_location,
            to_location,
            income,
            fuel,
            tolls,
            allowance,
            others,
            remarks
        } = req.body;

        if (!driver_name || !trip_date) {
            return res.status(400).json({ success: false, message: 'Driver name and trip date are required' });
        }

        const inc = formatAmount(income);
        let f = formatAmount(fuel);
        let t = formatAmount(tolls);
        let a = formatAmount(allowance);
        let o = formatAmount(others);

        // If expense_details provided, synchronize f, t, a, o with current category definitions
        if (expense_details && typeof expense_details === 'object' && Object.keys(expense_details).length > 0) {
            const allCats = await pool.query("SELECT name, system_key FROM expense_categories WHERE COALESCE(is_deleted, false) = false");
            let sumF = 0, sumT = 0, sumA = 0, sumO = 0;
            for (const [k, v] of Object.entries(expense_details)) {
                const amt = formatAmount(v);
                if (amt > 0) {
                    const matched = allCats.rows.find(c => c.name.toLowerCase() === k.trim().toLowerCase() || (c.system_key && c.system_key.toLowerCase() === k.trim().toLowerCase()));
                    const sk = matched ? matched.system_key : null;
                    if (sk === 'fuel') sumF += amt;
                    else if (sk === 'tolls') sumT += amt;
                    else if (sk === 'allowance') sumA += amt;
                    else sumO += amt;
                }
            }
            if ((sumF + sumT + sumA + sumO) > 0) {
                f = sumF;
                t = sumT;
                a = sumA;
                o = sumO;
            }
        }
        const net = inc - (f + t + a + o);

        // Generate Trip ID in format GO7C{YY}{INCREMENT} (e.g. GO7C26001) - Never reuse deleted IDs
        const currentYear = new Date().getFullYear().toString().slice(-2); // "26"
        const prefix = `GO7C${currentYear}`;

        const maxRes = await pool.query(`
            SELECT COALESCE(MAX(
                CAST(SUBSTRING(trip_code FROM ${prefix.length + 1}) AS INTEGER)
            ), 0) as max_seq 
            FROM trips 
            WHERE trip_code LIKE $1
        `, [`${prefix}%`]);

        const nextSeq = parseInt(maxRes.rows[0].max_seq, 10) + 1;
        const trip_code = `${prefix}${String(nextSeq).padStart(3, '0')}`;

        // Find driver_id for all drivers in driver_name (e.g. "Suresh Patel, Rahul Sharma")
        const driverNames = String(driver_name).split(',').map(s => s.trim()).filter(Boolean);
        const driverRes = await pool.query('SELECT id, name FROM drivers WHERE name = ANY($1)', [driverNames]);

        const insertRes = await pool.query(
            `INSERT INTO trips (
                trip_code, driver_id, driver_name, trip_date, trip_type, 
                from_location, to_location, income, fuel, tolls, allowance, others, net_profit, remarks, driver_amounts, expense_details
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
            [
                trip_code,
                driverRes.rows.length > 0 ? driverRes.rows[0].id : null,
                driver_name,
                trip_date,
                trip_type || '1',
                from_location || '',
                to_location || '',
                inc, f, t, a, o, net, remarks || '',
                JSON.stringify(driver_amounts || {}),
                JSON.stringify(expense_details || {})
            ]
        );

        // Recalculate driver stats for all drivers (subtracting split expenses per driver)
        await syncAllDriverStats();

        res.status(201).json({ success: true, data: insertRes.rows[0] });
    } catch (err) {
        console.error('API POST /api/trips Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 8. Live Charts Data from Neon DB
app.get('/api/charts', async (req, res) => {
    try {
        const { month } = req.query; // 'YYYY-MM' or 'all'

        let expenseQuery = `
            SELECT 
                COALESCE(SUM(fuel), 0) as fuel,
                COALESCE(SUM(tolls), 0) as tolls,
                COALESCE(SUM(allowance), 0) as allowance,
                COALESCE(SUM(others), 0) as others
            FROM trips
            WHERE COALESCE(is_deleted, false) = false
        `;
        const expenseParams = [];
        if (month && month !== 'all') {
            expenseQuery += ' AND TO_CHAR(trip_date, \'YYYY-MM\') = $1';
            expenseParams.push(month);
        }
        const expenseRes = await pool.query(expenseQuery, expenseParams);

        let trendQuery = '';
        let trendParams = [];
        if (month && month !== 'all') {
            trendQuery = `
                SELECT 
                    TO_CHAR(trip_date, 'DD Mon') as day_name,
                    trip_date,
                    COALESCE(SUM(income), 0) as earnings,
                    COALESCE(SUM(fuel + tolls + allowance + others), 0) as expenses
                FROM trips
                WHERE COALESCE(is_deleted, false) = false
                  AND TO_CHAR(trip_date, 'YYYY-MM') = $1
                GROUP BY trip_date
                ORDER BY trip_date ASC
            `;
            trendParams.push(month);
        } else {
            trendQuery = `
                SELECT 
                    TO_CHAR(trip_date, 'DD Mon') as day_name,
                    trip_date,
                    COALESCE(SUM(income), 0) as earnings,
                    COALESCE(SUM(fuel + tolls + allowance + others), 0) as expenses
                FROM trips
                WHERE COALESCE(is_deleted, false) = false
                GROUP BY trip_date
                ORDER BY trip_date DESC
                LIMIT 10
            `;
        }
        const trendRes = await pool.query(trendQuery, trendParams);
        const sortedTrend = (month && month !== 'all') 
            ? trendRes.rows 
            : [...trendRes.rows].reverse();

        // Monthly trip count (6 months window)
        let monthlyQuery = '';
        let monthlyParams = [];
        if (month && month !== 'all') {
            monthlyQuery = `
                SELECT 
                    TO_CHAR(month_series, 'Mon YY') as month_name,
                    TO_CHAR(month_series, 'YYYY-MM') as month_key,
                    COALESCE(COUNT(t.id), 0) as trip_count
                FROM GENERATE_SERIES(
                    DATE_TRUNC('month', TO_DATE($1 || '-01', 'YYYY-MM-DD')) - INTERVAL '5 months',
                    DATE_TRUNC('month', TO_DATE($1 || '-01', 'YYYY-MM-DD')),
                    INTERVAL '1 month'
                ) as month_series
                LEFT JOIN trips t ON DATE_TRUNC('month', t.trip_date) = month_series AND COALESCE(t.is_deleted, false) = false
                GROUP BY month_series
                ORDER BY month_series ASC
            `;
            monthlyParams.push(month);
        } else {
            monthlyQuery = `
                SELECT 
                    TO_CHAR(month_series, 'Mon YY') as month_name,
                    TO_CHAR(month_series, 'YYYY-MM') as month_key,
                    COALESCE(COUNT(t.id), 0) as trip_count
                FROM GENERATE_SERIES(
                    DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months',
                    DATE_TRUNC('month', CURRENT_DATE),
                    INTERVAL '1 month'
                ) as month_series
                LEFT JOIN trips t ON DATE_TRUNC('month', t.trip_date) = month_series AND COALESCE(t.is_deleted, false) = false
                GROUP BY month_series
                ORDER BY month_series ASC
            `;
        }
        const monthlyRes = await pool.query(monthlyQuery, monthlyParams);

        // Fetch distinct available months from trips in DB (formatted like 'Sep - 2026')
        const availableMonthsRes = await pool.query(`
            SELECT DISTINCT TO_CHAR(trip_date, 'YYYY-MM') as ym,
                   TO_CHAR(trip_date, 'Mon - YYYY') as display_name
            FROM trips
            WHERE COALESCE(is_deleted, false) = false
            ORDER BY ym DESC
        `);

        const expRow = expenseRes.rows[0] || {};
        const fuel = parseFloat(expRow.fuel || 0);
        const tolls = parseFloat(expRow.tolls || 0);
        const allowance = parseFloat(expRow.allowance || 0);
        const others = parseFloat(expRow.others || 0);

        // Fetch current active category names for system categories
        const catMapRes = await pool.query("SELECT id, name, system_key, is_system FROM expense_categories WHERE COALESCE(is_deleted, false) = false ORDER BY is_system DESC, id ASC");
        const categoryLabels = {
            fuel: 'Fuel',
            tolls: 'Tolls',
            allowance: 'Allowance',
            others: 'Others'
        };
        catMapRes.rows.forEach(c => {
            if (c.system_key && categoryLabels[c.system_key] !== undefined) {
                categoryLabels[c.system_key] = c.name;
            }
        });

        // Compute dynamic category totals from expense_details
        let expTripsQuery = "SELECT fuel, tolls, allowance, others, expense_details FROM trips WHERE COALESCE(is_deleted, false) = false";
        const expTripsParams = [];
        if (month && month !== 'all') {
            expTripsQuery += " AND TO_CHAR(trip_date, 'YYYY-MM') = $1";
            expTripsParams.push(month);
        }
        const expTripsRes = await pool.query(expTripsQuery, expTripsParams);

        const categoryTotals = {};
        catMapRes.rows.forEach(c => {
            categoryTotals[c.name] = 0;
        });

        expTripsRes.rows.forEach(t => {
            let details = t.expense_details;
            if (typeof details === 'string') {
                try { details = JSON.parse(details); } catch(e) {}
            }
            if (details && typeof details === 'object' && Object.keys(details).length > 0) {
                for (const [k, v] of Object.entries(details)) {
                    const amt = formatAmount(v);
                    if (amt > 0) {
                        const matchedCat = catMapRes.rows.find(c => c.name.toLowerCase() === k.trim().toLowerCase() || (c.system_key && c.system_key.toLowerCase() === k.trim().toLowerCase()));
                        const targetName = matchedCat ? matchedCat.name : k;
                        categoryTotals[targetName] = (categoryTotals[targetName] || 0) + amt;
                    }
                }
            } else {
                const f = formatAmount(t.fuel);
                const tol = formatAmount(t.tolls);
                const al = formatAmount(t.allowance);
                const oth = formatAmount(t.others);
                if (f > 0) categoryTotals[categoryLabels.fuel] = (categoryTotals[categoryLabels.fuel] || 0) + f;
                if (tol > 0) categoryTotals[categoryLabels.tolls] = (categoryTotals[categoryLabels.tolls] || 0) + tol;
                if (al > 0) categoryTotals[categoryLabels.allowance] = (categoryTotals[categoryLabels.allowance] || 0) + al;
                if (oth > 0) categoryTotals[categoryLabels.others] = (categoryTotals[categoryLabels.others] || 0) + oth;
            }
        });

        const categoryBreakdown = Object.entries(categoryTotals)
            .map(([name, amount]) => ({ name, amount: Math.round(amount * 100) / 100 }))
            .filter(item => item.amount > 0);

        res.json({
            success: true,
            data: {
                selectedMonth: month || 'all',
                expenseBreakdown: { fuel, tolls, allowance, others },
                categoryBreakdown,
                categoryLabels,
                trend: sortedTrend.map(r => ({
                    day: r.day_name || 'Day',
                    tripDate: r.trip_date,
                    earnings: parseFloat(r.earnings || 0),
                    expenses: parseFloat(r.expenses || 0)
                })),
                monthlyTrend: monthlyRes.rows.map(r => ({
                    month: r.month_name,
                    monthKey: r.month_key,
                    count: parseInt(r.trip_count, 10)
                })),
                availableMonths: availableMonthsRes.rows.map(r => ({
                    key: r.ym,
                    name: r.display_name
                }))
            }
        });
    } catch (err) {
        console.error('API /api/charts Error:', err.message);
        res.json({
            success: true,
            data: {
                selectedMonth: req.query.month || 'all',
                expenseBreakdown: { fuel: 0, tolls: 0, allowance: 0, others: 0 },
                trend: [],
                monthlyTrend: [],
                availableMonths: []
            }
        });
    }
});

// 9. Soft Delete Driver
app.delete('/api/drivers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('UPDATE trips SET is_deleted = true WHERE driver_id = $1', [id]);
        const delRes = await pool.query("UPDATE drivers SET is_deleted = true, status = 'Deleted' WHERE id = $1 RETURNING *", [id]);

        if (delRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Driver not found' });
        }

        res.json({ success: true, message: 'Driver soft-deleted successfully' });
    } catch (err) {
        console.error('API DELETE /api/drivers/:id Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 10. Soft Delete Trip
app.delete('/api/trips/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const tripRes = await pool.query('UPDATE trips SET is_deleted = true WHERE id = $1 RETURNING *', [id]);

        if (tripRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Trip record not found' });
        }

        await syncAllDriverStats();

        res.json({ success: true, message: 'Trip soft-deleted successfully' });
    } catch (err) {
        console.error('API DELETE /api/trips/:id Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 11. Edit / Update Trip
app.put('/api/trips/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const {
            driver_name,
            driver_amounts,
            expense_details,
            trip_date,
            trip_type,
            from_location,
            to_location,
            income,
            fuel,
            tolls,
            allowance,
            others,
            remarks
        } = req.body;

        const oldTripRes = await pool.query('SELECT * FROM trips WHERE id = $1', [id]);
        if (oldTripRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Trip not found' });
        }

        const inc = formatAmount(income);
        let f = formatAmount(fuel);
        let t = formatAmount(tolls);
        let a = formatAmount(allowance);
        let o = formatAmount(others);

        // If expense_details provided, synchronize f, t, a, o with current category definitions
        if (expense_details && typeof expense_details === 'object' && Object.keys(expense_details).length > 0) {
            const allCats = await pool.query("SELECT name, system_key FROM expense_categories WHERE COALESCE(is_deleted, false) = false");
            let sumF = 0, sumT = 0, sumA = 0, sumO = 0;
            for (const [k, v] of Object.entries(expense_details)) {
                const amt = formatAmount(v);
                if (amt > 0) {
                    const matched = allCats.rows.find(c => c.name.toLowerCase() === k.trim().toLowerCase() || (c.system_key && c.system_key.toLowerCase() === k.trim().toLowerCase()));
                    const sk = matched ? matched.system_key : null;
                    if (sk === 'fuel') sumF += amt;
                    else if (sk === 'tolls') sumT += amt;
                    else if (sk === 'allowance') sumA += amt;
                    else sumO += amt;
                }
            }
            if ((sumF + sumT + sumA + sumO) > 0) {
                f = sumF;
                t = sumT;
                a = sumA;
                o = sumO;
            }
        }
        const net = inc - (f + t + a + o);

        const driverNames = String(driver_name).split(',').map(s => s.trim()).filter(Boolean);
        const driverRes = await pool.query('SELECT id, name FROM drivers WHERE name = ANY($1)', [driverNames]);

        const updateRes = await pool.query(
            `UPDATE trips SET 
                driver_id = $1, 
                driver_name = $2, 
                trip_date = $3, 
                trip_type = $4, 
                from_location = $5, 
                to_location = $6, 
                income = $7, 
                fuel = $8, 
                tolls = $9, 
                allowance = $10, 
                others = $11, 
                net_profit = $12, 
                remarks = $13,
                driver_amounts = $14,
                expense_details = $15
            WHERE id = $16 RETURNING *`,
            [
                driverRes.rows.length > 0 ? driverRes.rows[0].id : null,
                driver_name,
                trip_date,
                trip_type || '1',
                from_location || '',
                to_location || '',
                inc, f, t, a, o, net, remarks || '',
                JSON.stringify(driver_amounts || {}),
                JSON.stringify(expense_details || {}),
                id
            ]
        );

        await syncAllDriverStats();

        res.json({ success: true, data: updateRes.rows[0] });
    } catch (err) {
        console.error('API PUT /api/trips/:id Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// EXPENSE CATEGORIES ENDPOINTS
// ==========================================

// 1. Get All Active Expense Categories
app.get('/api/expense-categories', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM expense_categories 
            WHERE COALESCE(is_deleted, false) = false 
            ORDER BY is_system DESC, id ASC
        `);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('API GET /api/expense-categories Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. Add New Expense Category
app.post('/api/expense-categories', async (req, res) => {
    try {
        const { name } = req.body;
        const cleanName = String(name || '').trim();

        if (!cleanName) {
            return res.status(400).json({ success: false, message: 'Category name is required' });
        }

        // Check if category already exists (case-insensitive)
        const existing = await pool.query(
            'SELECT * FROM expense_categories WHERE LOWER(name) = LOWER($1)',
            [cleanName]
        );

        if (existing.rows.length > 0) {
            const cat = existing.rows[0];
            if (!cat.is_deleted) {
                return res.status(400).json({ success: false, message: `Category "${cleanName}" already exists` });
            }
            // If soft-deleted, reactivate it
            const reactivateRes = await pool.query(
                'UPDATE expense_categories SET is_deleted = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
                [cat.id]
            );
            return res.status(201).json({ success: true, data: reactivateRes.rows[0] });
        }

        const insertRes = await pool.query(
            'INSERT INTO expense_categories (name, is_system) VALUES ($1, false) RETURNING *',
            [cleanName]
        );

        res.status(201).json({ success: true, data: insertRes.rows[0] });
    } catch (err) {
        console.error('API POST /api/expense-categories Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Update Existing Expense Category
app.put('/api/expense-categories/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name } = req.body;
        const cleanName = String(name || '').trim();

        if (!cleanName) {
            return res.status(400).json({ success: false, message: 'Category name is required' });
        }

        // Check if name conflict with another category
        const conflict = await pool.query(
            'SELECT * FROM expense_categories WHERE LOWER(name) = LOWER($1) AND id != $2 AND COALESCE(is_deleted, false) = false',
            [cleanName, id]
        );

        if (conflict.rows.length > 0) {
            return res.status(400).json({ success: false, message: `Category name "${cleanName}" is already in use` });
        }

        const catRes = await pool.query('SELECT * FROM expense_categories WHERE id = $1', [id]);
        if (catRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Category not found' });
        }
        const oldCat = catRes.rows[0];
        const oldName = oldCat.name;

        const updateRes = await pool.query(
            'UPDATE expense_categories SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND COALESCE(is_deleted, false) = false RETURNING *',
            [cleanName, id]
        );

        if (updateRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Category not found' });
        }

        // Apply rename across ALL trips in expense_details JSONB
        if (oldName.trim().toLowerCase() !== cleanName.trim().toLowerCase()) {
            const allTripsWithExp = await pool.query(
                "SELECT id, fuel, tolls, allowance, others, expense_details FROM trips WHERE COALESCE(is_deleted, false) = false"
            );
            const oldLower = oldName.trim().toLowerCase();
            const sysKeyLower = oldCat.system_key ? oldCat.system_key.trim().toLowerCase() : null;

            let updatedCount = 0;
            for (const t of allTripsWithExp.rows) {
                let details = t.expense_details;
                if (typeof details === 'string') {
                    try { details = JSON.parse(details); } catch(e) {}
                }
                if (!details || typeof details !== 'object') {
                    details = {};
                }

                let changed = false;
                const newDetails = {};
                for (const k in details) {
                    const kLower = k.trim().toLowerCase();
                    if (kLower === oldLower || (sysKeyLower && kLower === sysKeyLower)) {
                        newDetails[cleanName] = details[k];
                        changed = true;
                    } else {
                        newDetails[k] = details[k];
                    }
                }

                // If this is a system category and was not in expense_details but had a non-zero column value
                if (sysKeyLower && !newDetails[cleanName]) {
                    const colVal = formatAmount(t[sysKeyLower]);
                    if (colVal > 0) {
                        newDetails[cleanName] = colVal;
                        changed = true;
                    }
                }

                if (changed) {
                    await pool.query(
                        "UPDATE trips SET expense_details = $1 WHERE id = $2",
                        [JSON.stringify(newDetails), t.id]
                    );
                    updatedCount++;
                }
            }
            console.log(`[OK] Renamed category "${oldName}" -> "${cleanName}" across ${updatedCount} trips`);
        }

        res.json({ success: true, data: updateRes.rows[0] });
    } catch (err) {
        console.error('API PUT /api/expense-categories/:id Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Delete Expense Category (Soft delete)
app.delete('/api/expense-categories/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const checkRes = await pool.query('SELECT * FROM expense_categories WHERE id = $1', [id]);
        if (checkRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Category not found' });
        }

        const cat = checkRes.rows[0];
        if (cat.is_system) {
            return res.status(400).json({ success: false, message: 'Default system category cannot be deleted' });
        }

        await pool.query(
            'UPDATE expense_categories SET is_deleted = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
            [id]
        );

        res.json({ success: true, message: 'Category deleted successfully' });
    } catch (err) {
        console.error('API DELETE /api/expense-categories/:id Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// HTML Page Routes
app.get(['/settings', '/settings.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'settings.html'));
});

app.get(['/trip', '/trip.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'trip.html'));
});

app.get(['/driver', '/driver.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'driver.html'));
});

app.get(['/driver_details', '/driver_details.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'driver_details.html'));
});

app.get(['/', '/home', '/home.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'home.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Go 7 Server connected to Neon DB & running on http://localhost:${PORT}`);

    // Self keep-alive for Render (pings own public URL every 12 mins to prevent free-tier inactivity sleep)
    const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_APP_URL;
    if (externalUrl) {
        const pingUrl = `${externalUrl.replace(/\/$/, '')}/ping`;
        setInterval(() => {
            const client = pingUrl.startsWith('https') ? require('https') : require('http');
            client.get(pingUrl, (res) => {
                console.log(`[Keep-Alive] Pinged ${pingUrl} - Status: ${res.statusCode}`);
            }).on('error', (err) => {
                console.warn('[Keep-Alive] Ping warning:', err.message);
            });
        }, 12 * 60 * 1000); // Every 12 minutes
        console.log(`[OK] Render keep-alive active for ${pingUrl} (every 12 mins)`);
    }
});
