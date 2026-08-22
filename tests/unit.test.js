import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('MOMNA-990 runtime orders wrapper normalization after semantic execution', async () => {
  const source = await readFile(new URL('../scripts/run-execution-job.ts', import.meta.url), 'utf8');
  const prepare = source.indexOf('await installTargetDependencies(workspace,current,commands,stack)');
  const execute = source.indexOf('const result=await execution.execute');
  const normalize = source.indexOf('const provisionedWrapperSha=await commitProvisionedGradleWrapper');
  assert.ok(prepare >= 0);
  assert.ok(execute > prepare);
  assert.ok(normalize > execute);
});
