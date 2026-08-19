import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const connectionString=process.env['DATABASE_URL'];
if(!connectionString) throw new Error('DATABASE_URL is required. Copy .env.example to .env.');
const pool=new Pool({connectionString});
try {
  const sql=await readFile(new URL('../packages/project-registry/migrations/0001_initial.sql',import.meta.url),'utf8');
  await pool.query(sql); console.log(JSON.stringify({level:'info',event:'migration.complete',migration:'0001_initial'}));
} finally { await pool.end(); }
