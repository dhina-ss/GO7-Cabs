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

        if (!driver_name || !trip_date || !from_location || !to_location) {
            return res.status(400).json({ success: false, message: 'Required fields missing' });
        }

        const inc = formatAmount(income);
        const f = formatAmount(fuel);
        const t = formatAmount(tolls);
        const a = formatAmount(allowance);
        const o = formatAmount(others);
        const net = inc - (f + t + a + o);

        // Find driver_id by driver_name if possible
        const driverRes = await pool.query('SELECT id FROM drivers WHERE name = $1 LIMIT 1', [driver_name]);
        const driverId = driverRes.rows.length > 0 ? driverRes.rows[0].id : null;

        const insertRes = await pool.query(
            `INSERT INTO trips (
                driver_id, driver_name, trip_date, trip_type, 
                from_location, to_location, income, fuel, tolls, allowance, others, net_profit, remarks
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
            [
                driverId, driver_name, trip_date, trip_type || '1',
                from_location, to_location, inc, f, t, a, o, net, remarks || ''
            ]
        );

        // Update driver stats if driver exists
        if (driverId) {
            await pool.query(
                `UPDATE drivers SET 
                    trips_count = trips_count + 1, 
                    total_earnings = total_earnings + $1 
                WHERE id = $2`,
                [inc, driverId]
            );
        }

        res.status(201).json({ success: true, data: insertRes.rows[0] });
    } catch (err) {
        console.error('API POST /api/trips Error:', err);
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
