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

app.use(express.static(path.join(__dirname)));

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Helper: Format Currency Numbers
function formatAmount(val) {
    return parseFloat(val || 0);
}

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// 1. Dashboard Bento Stats
app.get('/api/stats', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                COUNT(*) as total_trips,
                COALESCE(SUM(income), 0) as total_income,
                COALESCE(SUM(fuel + tolls + allowance + others), 0) as total_expense,
                COALESCE(SUM(net_profit), 0) as net_profit
            FROM trips
        `);

        const row = result.rows[0];
        res.json({
            success: true,
            data: {
                total_trips: parseInt(row.total_trips, 10),
                total_income: parseFloat(row.total_income),
                total_expense: parseFloat(row.total_expense),
                net_profit: parseFloat(row.net_profit)
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

// 2. Get All Drivers
app.get('/api/drivers', async (req, res) => {
    try {
        const { search } = req.query;
        let query = 'SELECT * FROM drivers';
        let params = [];

        if (search) {
            query += ' WHERE LOWER(name) LIKE $1 OR LOWER(id) LIKE $1';
            params.push(`%${search.toLowerCase()}%`);
        }

        query += ' ORDER BY created_at DESC';

        const result = await pool.query(query, params);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('API /api/drivers Error:', err.message);
        res.json({ success: true, data: [] });
    }
});

// 3. Get Single Driver Details
app.get('/api/drivers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const driverRes = await pool.query('SELECT * FROM drivers WHERE id = $1', [id]);

        if (driverRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Driver not found' });
        }

        const tripsRes = await pool.query('SELECT * FROM trips WHERE driver_id = $1 ORDER BY trip_date DESC', [id]);

        res.json({
            success: true,
            data: {
                driver: driverRes.rows[0],
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

        // Generate ID in format DR{YY}{INCREMENT} (e.g. DR26001)
        const currentYear = new Date().getFullYear().toString().slice(-2); // "26"
        const prefix = `DR${currentYear}`;

        const maxRes = await pool.query(
            `SELECT id FROM drivers WHERE id LIKE $1 ORDER BY id DESC LIMIT 1`,
            [`${prefix}%`]
        );

        let increment = 1;
        if (maxRes.rows.length > 0) {
            const lastId = maxRes.rows[0].id;
            const numPart = parseInt(lastId.replace(prefix, ''), 10);
            if (!isNaN(numPart)) {
                increment = numPart + 1;
            }
        } else {
            const countRes = await pool.query('SELECT COUNT(*) FROM drivers');
            increment = parseInt(countRes.rows[0].count, 10) + 1;
        }

        const newId = `${prefix}${String(increment).padStart(3, '0')}`;

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
            'UPDATE drivers SET name = COALESCE($1, name), phone = COALESCE($2, phone) WHERE id = $3 RETURNING *',
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
        let query = 'SELECT * FROM trips WHERE 1=1';
        let params = [];
        let pCount = 1;

        if (search) {
            query += ` AND (LOWER(driver_name) LIKE $${pCount} OR LOWER(from_location) LIKE $${pCount} OR LOWER(to_location) LIKE $${pCount} OR LOWER(trip_type) LIKE $${pCount})`;
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
        const f = formatAmount(fuel);
        const t = formatAmount(tolls);
        const a = formatAmount(allowance);
        const o = formatAmount(others);
        const net = inc - (f + t + a + o);

        // Find driver_id for all drivers in driver_name (e.g. "Suresh Patel, Rahul Sharma")
        const driverNames = String(driver_name).split(',').map(s => s.trim()).filter(Boolean);
        const driverRes = await pool.query('SELECT id, name FROM drivers WHERE name = ANY($1)', [driverNames]);

        const insertRes = await pool.query(
            `INSERT INTO trips (
                driver_id, driver_name, trip_date, trip_type, 
                from_location, to_location, income, fuel, tolls, allowance, others, net_profit, remarks
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
            [
                driverRes.rows.length > 0 ? driverRes.rows[0].id : null,
                driver_name,
                trip_date,
                trip_type || '1',
                from_location || '',
                to_location || '',
                inc, f, t, a, o, net, remarks || ''
            ]
        );

        // Update driver stats for all selected drivers (using individual assigned driver_amounts if provided)
        if (driverRes.rows.length > 0) {
            for (const dRow of driverRes.rows) {
                const specificAmt = (driver_amounts && driver_amounts[dRow.name] !== undefined)
                    ? formatAmount(driver_amounts[dRow.name])
                    : (inc / (driverRes.rows.length || 1));

                await pool.query(
                    `UPDATE drivers SET 
                        trips_count = trips_count + 1, 
                        total_earnings = total_earnings + $1 
                    WHERE id = $2`,
                    [specificAmt, dRow.id]
                );
            }
        }

        res.status(201).json({ success: true, data: insertRes.rows[0] });
    } catch (err) {
        console.error('API POST /api/trips Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 8. Live Charts Data from Neon DB
app.get('/api/charts', async (req, res) => {
    try {
        const expenseRes = await pool.query(`
            SELECT 
                COALESCE(SUM(fuel), 0) as fuel,
                COALESCE(SUM(tolls), 0) as tolls,
                COALESCE(SUM(allowance), 0) as allowance,
                COALESCE(SUM(others), 0) as others
            FROM trips
        `);

        const trendRes = await pool.query(`
            SELECT 
                TO_CHAR(trip_date, 'Dy') as day_name,
                trip_date,
                COALESCE(SUM(income), 0) as earnings,
                COALESCE(SUM(fuel + tolls + allowance + others), 0) as expenses
            FROM trips
            GROUP BY trip_date
            ORDER BY trip_date ASC
            LIMIT 7
        `);

        const expRow = expenseRes.rows[0];
        const fuel = parseFloat(expRow.fuel);
        const tolls = parseFloat(expRow.tolls);
        const allowance = parseFloat(expRow.allowance);
        const others = parseFloat(expRow.others);

        // Last 6 months trip count
        const monthlyRes = await pool.query(`
            SELECT 
                TO_CHAR(month_series, 'Mon') as month_name,
                COALESCE(COUNT(t.id), 0) as trip_count
            FROM GENERATE_SERIES(
                DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months',
                DATE_TRUNC('month', CURRENT_DATE),
                INTERVAL '1 month'
            ) as month_series
            LEFT JOIN trips t ON DATE_TRUNC('month', t.trip_date) = month_series
            GROUP BY month_series
            ORDER BY month_series ASC
        `);

        res.json({
            success: true,
            data: {
                expenseBreakdown: { fuel, tolls, allowance, others },
                trend: trendRes.rows.map(r => ({
                    day: r.day_name || 'Day',
                    earnings: parseFloat(r.earnings),
                    expenses: parseFloat(r.expenses)
                })),
                monthlyTrend: monthlyRes.rows.map(r => ({
                    month: r.month_name,
                    count: parseInt(r.trip_count, 10)
                }))
            }
        });
    } catch (err) {
        console.error('API /api/charts Error:', err.message);
        res.json({
            success: true,
            data: {
                expenseBreakdown: { fuel: 0, tolls: 0, allowance: 0, others: 0 },
                trend: [],
                monthlyTrend: []
            }
        });
    }
});

// 9. Delete Driver
app.delete('/api/drivers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM trips WHERE driver_id = $1', [id]);
        const delRes = await pool.query('DELETE FROM drivers WHERE id = $1 RETURNING *', [id]);

        if (delRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Driver not found' });
        }

        res.json({ success: true, message: 'Driver deleted successfully' });
    } catch (err) {
        console.error('API DELETE /api/drivers/:id Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 10. Delete Trip
app.delete('/api/trips/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const tripRes = await pool.query('DELETE FROM trips WHERE id = $1 RETURNING *', [id]);

        if (tripRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Trip record not found' });
        }

        const t = tripRes.rows[0];
        if (t.driver_id) {
            const inc = parseFloat(t.income || 0);
            await pool.query(
                `UPDATE drivers SET 
                    trips_count = GREATEST(0, trips_count - 1), 
                    total_earnings = GREATEST(0, total_earnings - $1) 
                WHERE id = $2`,
                [inc, t.driver_id]
            );
        }

        res.json({ success: true, message: 'Trip deleted successfully' });
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
        const oldTrip = oldTripRes.rows[0];

        if (oldTrip.driver_id) {
            const oldInc = parseFloat(oldTrip.income || 0);
            await pool.query(
                `UPDATE drivers SET 
                    trips_count = GREATEST(0, trips_count - 1), 
                    total_earnings = GREATEST(0, total_earnings - $1) 
                WHERE id = $2`,
                [oldInc, oldTrip.driver_id]
            );
        }

        const inc = formatAmount(income);
        const f = formatAmount(fuel);
        const t = formatAmount(tolls);
        const a = formatAmount(allowance);
        const o = formatAmount(others);
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
                remarks = $13 
            WHERE id = $14 RETURNING *`,
            [
                driverRes.rows.length > 0 ? driverRes.rows[0].id : null,
                driver_name,
                trip_date,
                trip_type || '1',
                from_location || '',
                to_location || '',
                inc, f, t, a, o, net, remarks || '',
                id
            ]
        );

        if (driverRes.rows.length > 0) {
            for (const dRow of driverRes.rows) {
                const specificAmt = (driver_amounts && driver_amounts[dRow.name] !== undefined)
                    ? formatAmount(driver_amounts[dRow.name])
                    : (inc / (driverRes.rows.length || 1));

                await pool.query(
                    `UPDATE drivers SET 
                        trips_count = trips_count + 1, 
                        total_earnings = total_earnings + $1 
                    WHERE id = $2`,
                    [specificAmt, dRow.id]
                );
            }
        }

        res.json({ success: true, data: updateRes.rows[0] });
    } catch (err) {
        console.error('API PUT /api/trips/:id Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Fallback to home.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'home.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Go 7 Server connected to Neon DB & running on http://localhost:${PORT}`);
});
