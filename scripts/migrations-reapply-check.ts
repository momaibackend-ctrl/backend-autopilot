import 'dotenv/config';
// CI check against a real, disposable PostgreSQL: every deploy re-applies every migration, so the
// migrations must survive being applied again over a database that already holds rows of every
// kind the latest schema admits. This reproduces the deploy that failed once the first HTTP_E2E
// job existed (0005 recreated execution_jobs_kind_check without HTTP_E2E) and must now pass.
//
//   DATABASE_URL=postgres://... tsx scripts/migrations-reapply-check.ts
// Run only against a throwaway database: it inserts fixture rows.
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';

const url = process.env['DATABASE_URL'];
if (!url || !/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) throw new Error('DATABASE_URL must point at a local, disposable PostgreSQL');
const migrate = () => execFileSync('pnpm', ['db:migrate'], { stdio: 'inherit', shell: false, env: process.env });

migrate();
migrate();
const pool = new Pool({ connectionString: url });
try {
  const now = new Date().toISOString();
  const project = crypto.randomUUID(), task = crypto.randomUUID(), resource = crypto.randomUUID();
  await pool.query('insert into projects(id,slug,data,created_at) values($1,$2,$3,$4)', [project, `reapply-${project}`, {}, now]);
  await pool.query('insert into tasks(id,project_id,external_key,data,created_at) values($1,$2,$3,$4,$5)', [task, project, 'REAPPLY-1', {}, now]);
  await pool.query('insert into resources(id,project_id,provider,external_reference,data,created_at) values($1,$2,$3,$4,$5,$6)', [resource, project, 'github', `acme/reapply-${project}`, {}, now]);
  // One job of every kind, including the newest: each later re-application must still admit them.
  for (const kind of ['IMPLEMENTATION', 'TEST', 'VALIDATION', 'REPAIR', 'RECONCILIATION', 'REBASE', 'HTTP_E2E'])
    await pool.query("insert into execution_jobs(id,project_id,task_id,resource_id,operation_id,kind,status,data,created_at,updated_at) values($1,$2,$3,$4,$5,$6,'SUCCEEDED',$7,$8,$8)", [crypto.randomUUID(), project, task, resource, `reapply-${kind}`, kind, {}, now]);
  migrate();
  const constraint = await pool.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conrelid='execution_jobs'::regclass and conname='execution_jobs_kind_check'");
  const definition = constraint.rows[0]?.def ?? '';
  if (!definition.includes("'HTTP_E2E'")) throw new Error(`execution_jobs_kind_check was narrowed: ${definition || '(missing)'}`);
  const rows = await pool.query<{ count: string }>('select count(*) from execution_jobs where project_id=$1', [project]);
  if (rows.rows[0]?.count !== '7') throw new Error(`expected 7 fixture jobs, found ${rows.rows[0]?.count}`);
  console.log(JSON.stringify({ level: 'info', event: 'migrations.reapply_check.passed', constraint: definition }));
} finally {
  await pool.end();
}
