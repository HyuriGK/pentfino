require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

async function setup() {
    try {
        console.log('📖 Lendo schema.sql...');
        const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
        
        console.log('🚀 Executando migração no Neon...');
        await pool.query(sql);
        
        console.log('✅ Banco de dados configurado com sucesso!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Erro na migração:', err);
        process.exit(1);
    }
}

setup();
