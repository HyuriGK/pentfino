require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'barberpoint_fallback_secret';

// Auth Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ success: false, message: 'Token não fornecido' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ success: false, message: 'Token inválido' });
        req.user = user;
        next();
    });
};

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// DB Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

pool.on('connect', () => {
    console.log('✅ Connected to Neon PostgreSQL');
    // Ensure commission column exists (one-off migration)
    pool.query('ALTER TABLE professionals ADD COLUMN IF NOT EXISTS commission DECIMAL(5,2) DEFAULT 0').catch(e => console.error('Migration error:', e));
    pool.query('ALTER TABLE inventory ADD COLUMN IF NOT EXISTS unit_price DECIMAL(10,2) DEFAULT 0').catch(e => console.error('Migration error:', e));
});

// API Routes
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM barbers WHERE email = $1', [email]);
        const user = result.rows[0];
        
        if (user && await bcrypt.compare(password, user.password)) {
            const token = jwt.sign(
                { id: user.id, email: user.email },
                JWT_SECRET,
                { expiresIn: '7d' }
            );
            res.json({ 
                success: true, 
                token, 
                user: { id: user.id, email: user.email, shop: user.shop_name } 
            });
        } else {
            res.status(401).json({ success: false, message: 'Credenciais inválidas' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/api/register', async (req, res) => {
    const { email, password, shop } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO barbers (email, password, shop_name) VALUES ($1, $2, $3) RETURNING id, email, shop_name',
            [email, hashedPassword, shop]
        );
        
        const user = result.rows[0];
        const token = jwt.sign(
            { id: user.id, email: user.email },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({ success: true, token, user });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Erro ao registrar' });
    }
});

app.get('/api/appointments/:barberId', authenticateToken, async (req, res) => {
    try {
        const { barberId } = req.params;
        // Fetch all appointments for the calendar (pending, completed, canceled)
        const result = await pool.query(`
            SELECT a.*, s.name as service_name, s.price as service_price, p.name as professional_name
            FROM appointments a
            JOIN services s ON a.service_id = s.id
            LEFT JOIN professionals p ON a.professional_id = p.id
            WHERE a.barber_id = $1
            ORDER BY a.appointment_date ASC, a.appointment_time ASC
        `, [barberId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/api/appointments/booked/list', async (req, res) => {
    const { barberId, professionalId, date } = req.query;
    try {
        const result = await pool.query(`
            SELECT SUBSTRING(appointment_time::text, 1, 5) as time
            FROM appointments
            WHERE barber_id = $1 AND professional_id = $2 AND appointment_date = $3 AND status != 'canceled'
        `, [barberId, professionalId, date]);
        res.json(result.rows.map(r => r.time));
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/api/appointments', async (req, res) => {
    const { barberId, serviceId, professionalId, clientName, clientPhone, time, date } = req.body;
    try {
        // Use provided date or today if not provided
        const apptDate = date || new Date().toISOString().split('T')[0];

        // 0. Check for collision
        const collision = await pool.query(`
            SELECT id FROM appointments 
            WHERE barber_id = $1 AND professional_id = $2 AND appointment_date = $3 AND appointment_time = $4 AND status != 'canceled'
        `, [barberId, professionalId, apptDate, time]);

        if (collision.rows.length > 0) {
            return res.status(409).json({ success: false, message: 'Este horário já foi reservado para este profissional.' });
        }

        // 1. Insert the appointment
        const result = await pool.query(
            'INSERT INTO appointments (barber_id, service_id, professional_id, client_name, client_phone, appointment_time, appointment_date) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [barberId, serviceId, professionalId, clientName, clientPhone, time, apptDate]
        );

        // 2. Sync with CRM (clients table) - Always ensure client exists for this Name + Phone combo
        await pool.query(`
            INSERT INTO clients (barber_id, name, phone)
            VALUES ($1, $2, $3)
            ON CONFLICT (barber_id, name, phone) DO NOTHING
        `, [barberId, clientName, clientPhone]).catch(async (err) => {
            // Manual fallback if needed
            const check = await pool.query('SELECT id FROM clients WHERE barber_id = $1 AND name = $2 AND phone = $3', [barberId, clientName, clientPhone]);
            if (check.rows.length === 0) {
                await pool.query('INSERT INTO clients (barber_id, name, phone) VALUES ($1, $2, $3)', [barberId, clientName, clientPhone]);
            }
        });

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.patch('/api/appointments/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        await pool.query('UPDATE appointments SET status = $1 WHERE id = $2', [status, id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.delete('/api/appointments/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM appointments WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/api/stats/:barberId', authenticateToken, async (req, res) => {
    try {
        const { barberId } = req.params;
        const result = await pool.query(`
            SELECT SUM(s.price) as revenue, COUNT(*) as count 
            FROM appointments a
            JOIN services s ON a.service_id = s.id
            WHERE a.barber_id = $1 AND a.status = 'completed'
        `, [barberId]);
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// Clients API - Fixed last_service_date to use appointment_date for business logic
app.get('/api/clients/:barberId', authenticateToken, async (req, res) => {
    try {
        const { barberId } = req.params;
        const result = await pool.query(`
            SELECT c.*, 
                   MAX(a.appointment_date) as last_service_date,
                   (SELECT a2.appointment_time 
                    FROM appointments a2 
                    WHERE a2.client_name = c.name AND a2.client_phone = c.phone 
                    ORDER BY a2.appointment_date DESC, a2.appointment_time DESC LIMIT 1) as scheduled_time,
                   COUNT(a.id) as total_appointments
            FROM clients c
            LEFT JOIN appointments a ON c.name = a.client_name AND c.phone = a.client_phone
            WHERE c.barber_id = $1
            GROUP BY c.id
            ORDER BY last_service_date DESC, c.name ASC
        `, [barberId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/api/clients/:id/history', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const clientResult = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
        const client = clientResult.rows[0];

        if (!client) return res.status(404).send('Client not found');

        const appointmentsResult = await pool.query(`
            SELECT a.*, s.name as service_name, s.price as service_price, p.name as professional_name 
            FROM appointments a
            JOIN services s ON a.service_id = s.id
            LEFT JOIN professionals p ON a.professional_id = p.id
            WHERE a.client_name = $1 AND a.client_phone = $2
            ORDER BY a.appointment_date DESC, a.appointment_time DESC
        `, [client.name, client.phone]);

        const statsResult = await pool.query(`
            SELECT SUM(s.price) as total_spent, COUNT(a.id) as service_count
            FROM appointments a
            JOIN services s ON a.service_id = s.id
            WHERE a.client_name = $1 AND a.client_phone = $2 AND a.status = 'completed'
        `, [client.name, client.phone]);

        res.json({
            client,
            history: appointmentsResult.rows,
            stats: statsResult.rows[0]
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.delete('/api/clients/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        const clientRes = await pool.query('SELECT name, phone FROM clients WHERE id = $1', [id]);
        if (clientRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Cliente não encontrado' });
        
        const { name, phone } = clientRes.rows[0];
        
        // Delete associated appointments
        await pool.query('DELETE FROM appointments WHERE client_name = $1 AND client_phone = $2', [name, phone]);
        
        // Delete the client
        await pool.query('DELETE FROM clients WHERE id = $1', [id]);
        
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// Services API
app.get('/api/services/:barberId', authenticateToken, async (req, res) => {
    try {
        const { barberId } = req.params;
        const result = await pool.query('SELECT * FROM services WHERE barber_id = $1 ORDER BY name ASC', [barberId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/api/services', authenticateToken, async (req, res) => {
    const { barberId, name, price, duration } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO services (barber_id, name, price, duration) VALUES ($1, $2, $3, $4) RETURNING *',
            [barberId, name, price, duration]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.patch('/api/services/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { name, price, duration } = req.body;
    try {
        await pool.query(
            'UPDATE services SET name = $1, price = $2, duration = $3 WHERE id = $4',
            [name, price, duration, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.delete('/api/services/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM professional_services WHERE service_id = $1', [id]);
        await pool.query('DELETE FROM services WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// Professionals API
app.get('/api/professionals/:barberId', authenticateToken, async (req, res) => {
    try {
        const { barberId } = req.params;
        const result = await pool.query(`
            SELECT p.*, 
                   json_agg(json_build_object('id', s.id, 'name', s.name)) FILTER (WHERE s.id IS NOT NULL) as services
            FROM professionals p
            LEFT JOIN professional_services ps ON p.id = ps.professional_id
            LEFT JOIN services s ON ps.service_id = s.id
            WHERE p.barber_id = $1
            GROUP BY p.id
            ORDER BY p.name ASC
        `, [barberId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/api/professionals', authenticateToken, async (req, res) => {
    const { barberId, name, phone, photoUrl, commission } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO professionals (barber_id, name, phone, photo_url, commission) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [barberId, name, phone, photoUrl, commission || 0]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/api/professional-services/:profId', async (req, res) => {
    try {
        const { profId } = req.params;
        const result = await pool.query(`
            SELECT s.* FROM services s
            JOIN professional_services ps ON s.id = ps.service_id
            WHERE ps.professional_id = $1
        `, [profId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/api/professional-services', async (req, res) => {
    const { profId, serviceIds } = req.body;
    try {
        await pool.query('DELETE FROM professional_services WHERE professional_id = $1', [profId]);
        if (serviceIds && serviceIds.length > 0) {
            const values = serviceIds.map(sid => `(${profId}, ${sid})`).join(',');
            await pool.query(`INSERT INTO professional_services (professional_id, service_id) VALUES ${values}`);
        }
        res.send('Linked successfully');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.patch('/api/professionals/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, phone, photoUrl, commission } = req.body;
        await pool.query(
            'UPDATE professionals SET name = $1, phone = $2, photo_url = $3, commission = $4 WHERE id = $5',
            [name, phone, photoUrl, commission || 0, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.delete('/api/professionals/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM professional_services WHERE professional_id = $1', [id]);
        await pool.query('DELETE FROM professionals WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/api/clients', async (req, res) => {
    const { barberId, name, phone, notes } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO clients (barber_id, name, phone, notes) VALUES ($1, $2, $3, $4) RETURNING *',
            [barberId, name, phone, notes]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// Inventory API
app.get('/api/inventory/:barberId', authenticateToken, async (req, res) => {
    try {
        const { barberId } = req.params;
        const result = await pool.query('SELECT * FROM inventory WHERE barber_id = $1 ORDER BY item_name ASC', [barberId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/api/inventory', authenticateToken, async (req, res) => {
    const { barberId, itemName, quantity, unit, minQuantity, unitPrice } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO inventory (barber_id, item_name, quantity, unit, min_quantity, unit_price) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [barberId, itemName, quantity, unit, minQuantity, unitPrice || 0]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.patch('/api/inventory/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { quantity } = req.body;
    try {
        await pool.query('UPDATE inventory SET quantity = $1 WHERE id = $2', [quantity, id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.delete('/api/inventory/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM inventory WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

if (require.main === module) {
    app.listen(port, () => {
        console.log(`🚀 BarberPoint Server running on http://localhost:${port}`);
    });
}

module.exports = app;
