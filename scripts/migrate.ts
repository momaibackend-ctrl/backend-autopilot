import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';

const connectionString=process.env['DATABASE_URL'];
if(!connectionString) throw new Error('DATABASE_URL is required. Copy .env.example to .env.');
const pool=new Pool({connectionString});
try {
  const directory=join(dirname(fileURLToPath(import.meta.url)),'../packages/project-registry/migrations');
  const migrations=(await readdir(directory)).filter(name=>/^\d+_.+\.sql$/.test(name)).sort();
  for(const migration of migrations){
    const sql=await readFile(join(directory,migration),'utf8');
    await pool.query(sql);
    const key=`schema:${migration.replace(/\.sql$/,'')}`,checksum=createHash('sha256').update(sql).digest('hex');
    await pool.query('insert into migration_markers(key,checksum,data,created_at) values($1,$2,$3,now()) on conflict(key) do update set checksum=excluded.checksum,data=excluded.data',[key,checksum,{migration,platformVersion:'0.5.0'}]);
    console.log(JSON.stringify({level:'info',event:'migration.complete',migration:migration.replace(/\.sql$/,'')}));
  }
} finally { await pool.end(); }
