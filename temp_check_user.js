require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

async function checkUser() {
    try {
        const email = 'brasil.hyuri@gmail.com';
        const res = await pool.query('SELECT * FROM barbers WHERE email = $1', [email]);
        console.log('User found:', res.rows.length > 0);
        if (res.rows.length > 0) {
            console.log('Email:', res.rows[0].email);
            console.log('Password in DB matches:', res.rows[0].password === '135790');
        }
    } catch (err) {
        console.error('Error querying DB:', err);
    } finally {
        await pool.end();
    }
}

checkUser();
