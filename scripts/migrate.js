require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Copy .env.example to .env first.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function migrate() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_initial.sql'), 'utf8'));
  console.log('Database migration complete.');
  await pool.end();
}
migrate().catch((error) => { console.error(error); process.exit(1); });
