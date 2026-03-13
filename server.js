require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// DB Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

pool.on('connect', () => {
    console.log('✅ Connected to Neon PostgreSQL');
});

// API Routes

// 1. Auth: Login
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM barbers WHERE email = $1', [email]);
        const user = result.rows[0];
        
        if (user && user.password === password) { // Simple check for MVP, should use bcrypt
            res.json({ success: true, user: { id: user.id, email: user.email, shop: user.shop_name } });
        } else {
            res.status(401).json({ success: false, message: 'Credenciais inválidas' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// 2. Auth: Register
app.post('/api/register', async (req, res) => {
    const { email, password, shop } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO barbers (email, password, shop_name) VALUES ($1, $2, $3) RETURNING id, email, shop_name',
            [email, password, shop]
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Erro ao registrar (email já existe?)' });
    }
});

// 3. Get Appointments
app.get('/api/appointments/:barberId', async (req, res) => {
    try {
        const { barberId } = req.params;
        const result = await pool.query(`
            SELECT a.*, s.name as service_name, s.price as service_price 
            FROM appointments a
            JOIN services s ON a.service_id = s.id
            WHERE a.barber_id = $1 AND a.status = 'pending'
            ORDER BY a.appointment_time ASC
        `, [barberId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// 4. Create Appointment
app.post('/api/appointments', async (req, res) => {
    const { barberId, serviceId, clientName, clientPhone, time } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO appointments (barber_id, service_id, client_name, client_phone, appointment_time) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [barberId, serviceId, clientName, clientPhone, time]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// 5. Complete/Cancel Service
app.patch('/api/appointments/:id', async (req, res) => {
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

// 6. Get Stats (Historical)
app.get('/api/stats/:barberId', async (req, res) => {
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

app.listen(port, () => {
    console.log(`🚀 Pentfino Server running on http://localhost:${port}`);
});
