import { readFile } from 'node:fs/promises';
import { describe,expect,it } from 'vitest';
import { Pool } from 'pg';
import { PostgresStateStore } from '../../packages/project-registry/src/postgres-store.js';

// Only ever run against a database this test is allowed to write throwaway rows into. The live
// control plane accumulated seven orphaned "PG Test" projects because the row was never deleted and
// nothing stopped the suite pointing at it; both halves of that are fixed here.
const candidate=process.env['TEST_DATABASE_URL']??(process.env['CI']?process.env['DATABASE_URL']:undefined);
const disposable=candidate!==undefined&&/(localhost|127\.0\.0\.1|::1)/.test(candidate);
const url=disposable?candidate:undefined;
if(candidate&&!disposable)console.warn(JSON.stringify({level:'warn',event:'postgres_store_test.skipped_non_disposable_database',reason:'Refusing to create test projects in a database that is not local'}));
describe.skipIf(!url)('PostgreSQL persistence',()=>{it('applies the migration and persists project state',async()=>{const pool=new Pool({connectionString:url as string});const sql=await readFile('packages/project-registry/migrations/0001_initial.sql','utf8');await pool.query(sql);await pool.end();const store=new PostgresStateStore(url as string);const now=new Date().toISOString();const project={id:crypto.randomUUID(),name:'PG Test',slug:`pg-${crypto.randomUUID()}`,sourceType:'LOCAL',environment:'SANDBOX' as const,autonomyMode:'GUARDED' as const,status:'ACTIVE' as const,workspacePath:'/tmp/pg-test',createdAt:now,updatedAt:now};await store.createProject(project);expect(await store.getProject(project.id)).toEqual(project);await store.updateProject({...project,status:'ARCHIVED',deletedAt:new Date().toISOString()});await store.close();});});
