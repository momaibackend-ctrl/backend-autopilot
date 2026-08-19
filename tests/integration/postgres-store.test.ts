import { readFile } from 'node:fs/promises';
import { describe,expect,it } from 'vitest';
import { Pool } from 'pg';
import { PostgresStateStore } from '../../packages/project-registry/src/postgres-store.js';

const url=process.env['TEST_DATABASE_URL']??(process.env['CI']?process.env['DATABASE_URL']:undefined);
describe.skipIf(!url)('PostgreSQL persistence',()=>{it('applies the migration and persists project state',async()=>{const pool=new Pool({connectionString:url as string});const sql=await readFile('packages/project-registry/migrations/0001_initial.sql','utf8');await pool.query(sql);await pool.end();const store=new PostgresStateStore(url as string);const now=new Date().toISOString();const project={id:crypto.randomUUID(),name:'PG Test',slug:`pg-${crypto.randomUUID()}`,sourceType:'LOCAL',environment:'SANDBOX' as const,autonomyMode:'GUARDED' as const,status:'ACTIVE' as const,workspacePath:'/tmp/pg-test',createdAt:now,updatedAt:now};await store.createProject(project);expect(await store.getProject(project.id)).toEqual(project);await store.close();});});
