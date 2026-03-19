
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function checkSchema() {
    try {
        const res = await pool.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'sales'
        `);
        console.log('--- SALES TABLE SCHEMA ---');
        console.table(res.rows);
        
        const invRes = await pool.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'inventory'
        `);
        console.log('--- INVENTORY TABLE SCHEMA ---');
        console.table(invRes.rows);
    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

checkSchema();
