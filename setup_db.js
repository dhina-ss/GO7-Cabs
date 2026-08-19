const { Client } = require('pg');

const DATABASE_URL = 'postgresql://neondb_owner:npg_9UXzhcyKJA8g@ep-plain-sunset-azdt3ba9.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';

async function initDB() {
    const client = new Client({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await client.connect();
        console.log('✅ Connected to Neon PostgreSQL database.');

        // Create Drivers Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS drivers (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(250) NOT NULL,
                phone VARCHAR(50),
                trips_count INT DEFAULT 0,
                total_earnings NUMERIC(12, 2) DEFAULT 0.00,
                status VARCHAR(50) DEFAULT 'Active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Drivers table created/verified.');

        // Create Trips Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS trips (
                id SERIAL PRIMARY KEY,
                driver_id VARCHAR(50) REFERENCES drivers(id) ON DELETE SET NULL,
                driver_name VARCHAR(250) NOT NULL,
                trip_date DATE NOT NULL,
                trip_type VARCHAR(50) NOT NULL,
                from_location VARCHAR(250) NOT NULL,
                to_location VARCHAR(250) NOT NULL,
                income NUMERIC(12, 2) DEFAULT 0.00,
                fuel NUMERIC(12, 2) DEFAULT 0.00,
                tolls NUMERIC(12, 2) DEFAULT 0.00,
                allowance NUMERIC(12, 2) DEFAULT 0.00,
                others NUMERIC(12, 2) DEFAULT 0.00,
                net_profit NUMERIC(12, 2) DEFAULT 0.00,
                remarks TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Trips table created/verified.');

        // Check if initial drivers exist, seed if empty
        const driverCheck = await client.query('SELECT COUNT(*) FROM drivers');
        if (parseInt(driverCheck.rows[0].count, 10) === 0) {
            console.log('Seeding initial drivers...');
            await client.query(`
                INSERT INTO drivers (id, name, phone, trips_count, total_earnings, status) VALUES
                ('DR26001', 'Suresh Patel', '+91 98765 43210', 156, 24500.00, 'Active'),
                ('DR26002', 'Rahul Sharma', '+91 98765 43211', 342, 48200.00, 'Active'),
                ('DR26003', 'Amit Kumar', '+91 98765 43212', 89, 12800.00, 'Active');
            `);
            console.log('✅ Initial drivers seeded.');
        }

        // Check if initial trips exist, seed if empty
        const tripCheck = await client.query('SELECT COUNT(*) FROM trips');
        if (parseInt(tripCheck.rows[0].count, 10) === 0) {
            console.log('Seeding initial trips...');
            await client.query(`
                INSERT INTO trips (driver_id, driver_name, trip_date, trip_type, from_location, to_location, income, fuel, tolls, allowance, others, net_profit, remarks) VALUES
                ('DR26001', 'Suresh Patel', '2023-10-24', 'Out', 'Chennai', 'Bangalore', 8500.00, 2500.00, 400.00, 600.00, 0.00, 5000.00, 'Regular outstation trip'),
                ('DR26002', 'Rahul Sharma', '2023-10-23', '1', 'Coimbatore', 'Chennai', 6200.00, 1800.00, 300.00, 400.00, 0.00, 3700.00, 'Local round trip'),
                ('DR26003', 'Amit Kumar', '2023-10-22', '2', 'Madurai', 'Trichy', 4500.00, 1200.00, 0.00, 300.00, 0.00, 3000.00, 'Express pickup');
            `);
            console.log('✅ Initial trips seeded.');
        }

        console.log('🎉 Database initialization complete!');
    } catch (err) {
        console.error('❌ Database initialization error:', err);
    } finally {
        await client.end();
    }
}

initDB();
