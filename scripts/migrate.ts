import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const connectionString=process.env['DATABASE_URL'];
if(!connectionString) throw new Error('DATABASE_URL is required. Copy .env.example to .env.');
const pool=new Pool({connectionString});
try {
  const directory=join(dirname(fileURLToPath(import.meta.url)),'../packages/project-registry/migrations');
  const migrations=(await readdir(directory)).filter(name=>/^\d+_.+\.sql$/.test(name)).sort();
  for(const migration of migrations){
    const sql=await readFile(join(directory,migration),'utf8');
    await pool.query(sql);
    console.log(JSON.stringify({level:'info',event:'migration.complete',migration:migration.replace(/\.sql$/,'')}));
  }
} finally { await pool.end(); }
