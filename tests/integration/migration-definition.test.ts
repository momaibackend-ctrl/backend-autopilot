import { describe,expect,it } from 'vitest';import { readFile } from 'node:fs/promises';
describe('control-plane migration',()=>{it('defines durable workflow evidence and immutable audit',async()=>{const sql=await readFile('packages/project-registry/migrations/0001_initial.sql','utf8');for(const table of ['projects','resources','project_contexts','tasks','artifacts','runs','task_transitions','audit_events'])expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);expect(sql).toContain('prevent_audit_mutation');expect(sql).toContain('BEFORE UPDATE OR DELETE');});});
describe('superadmin migration',()=>{it('adds global roles and semantic configuration without weakening RLS',async()=>{const sql=await readFile('packages/project-registry/migrations/0003_superadmin_mcp.sql','utf8');for(const table of ['system_settings','console_screens','admin_operations'])expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);expect(sql).toContain("'SUPERADMIN'");expect(sql).toContain('ENABLE ROW LEVEL SECURITY');expect(sql).not.toContain('DISABLE ROW LEVEL SECURITY');});});
describe('migration runner bootstrap order',()=>{it('records checksums only after the marker table exists',async()=>{const source=await readFile('scripts/migrate.ts','utf8');expect(source).toContain("to_regclass('public.migration_markers')");expect(source).toContain('for(const item of applied)');});});
describe('http validation runner migration',()=>{it('is additive, idempotent and free of destructive statements',async()=>{const sql=await readFile('packages/project-registry/migrations/0004_http_validation_runner.sql','utf8');expect(sql).toContain('CREATE INDEX IF NOT EXISTS artifacts_project_kind_idx');expect(sql).toContain('IF NOT EXISTS');expect(/\b(DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN)\b/i.test(sql.replace(/^--.*$/gm,''))).toBe(false);});});
describe('http e2e job migration',()=>{it('widens the job kind constraint additively and keeps every earlier kind',async()=>{const sql=await readFile('packages/project-registry/migrations/0007_http_e2e_job.sql','utf8');expect(sql).toContain("'HTTP_E2E'");for(const kind of ['IMPLEMENTATION','TEST','VALIDATION','REPAIR','RECONCILIATION','REBASE'])expect(sql).toContain(`'${kind}'`);expect(/\b(TRUNCATE|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+COLUMN)\b/i.test(sql.replace(/^--.*$/gm,''))).toBe(false);});});
describe('re-applied migrations never narrow a constraint',()=>{
  // Every deploy re-applies every migration in order. A migration that unconditionally recreates a
  // CHECK constraint a later migration widens narrows it again on every deploy -- and fails the
  // deploy once a row of the newer value exists (execution_jobs_kind_check after the first HTTP_E2E
  // job). Any constraint added by more than one migration must be guarded in each of them.
  it('guards every constraint that more than one migration redefines',async()=>{
    const {readdir}=await import('node:fs/promises');
    const directory='packages/project-registry/migrations';
    const files=(await readdir(directory)).filter(name=>/^\d+_.+\.sql$/.test(name)).sort();
    const added=new Map<string,Array<{file:string;sql:string}>>();
    for(const file of files){
      const sql=await readFile(`${directory}/${file}`,'utf8');
      for(const match of sql.matchAll(/ADD CONSTRAINT\s+(\w+)/gi)){const name=match[1] as string;added.set(name,[...(added.get(name)??[]),{file,sql}]);}
    }
    const unguarded=[...added.entries()].filter(([,uses])=>uses.length>1).flatMap(([name,uses])=>uses.filter(use=>!/pg_get_constraintdef/.test(use.sql)).map(use=>`${name} in ${use.file}`));
    expect(unguarded).toEqual([]);
    expect(added.get('execution_jobs_kind_check')?.map(use=>use.file)).toEqual(['0005_task_rebase.sql','0007_http_e2e_job.sql']);
  });
  it('keeps the kind migrations conditional on the current definition',async()=>{
    const rebase=await readFile('packages/project-registry/migrations/0005_task_rebase.sql','utf8');
    const e2e=await readFile('packages/project-registry/migrations/0007_http_e2e_job.sql','utf8');
    expect(rebase).toMatch(/NOT LIKE '%''REBASE''%'/);
    expect(e2e).toMatch(/LIKE '%''HTTP_E2E''%'/);
    for(const kind of ['IMPLEMENTATION','TEST','VALIDATION','REPAIR','RECONCILIATION','REBASE'])expect(e2e).toContain(`'${kind}'`);
  });
});
