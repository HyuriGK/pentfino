
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function checkSchemaDetailed() {
    try {
        const res = await pool.query(`
            SELECT 
                column_name, 
                data_type, 
                is_nullable,
                column_default
            FROM information_schema.columns 
            WHERE table_name = 'sales'
            ORDER BY ordinal_position
        `);
        console.log('--- SALES TABLE DETAILED SCHEMA ---');
        console.table(res.rows);
        
        const constraints = await pool.query(`
            SELECT 
                tc.constraint_name, 
                tc.constraint_type, 
                kcu.column_name 
            FROM information_schema.table_constraints AS tc 
            JOIN information_schema.key_column_usage AS kcu
              ON tc.constraint_name = kcu.constraint_name
            WHERE tc.table_name = 'sales'
        `);
        console.log('--- SALES CONSTRAINTS ---');
        console.table(constraints.rows);

    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

checkSchemaDetailed();
