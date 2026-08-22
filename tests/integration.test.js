import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Kotlin dependency preparation exits before package preparation', async () => {
  const source = await readFile(new URL('../scripts/run-execution-job.ts', import.meta.url), 'utf8');
  const start = source.indexOf('async function installTargetDependencies');
  const end = source.indexOf('async function commitProvisionedGradleWrapper');
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  const kotlinSkip = body.indexOf("if(stack==='KOTLIN_GRADLE')return;");
  const packagePreparation = body.indexOf("access(join(workspace,'package.json'))");
  assert.ok(kotlinSkip >= 0);
  assert.ok(packagePreparation > kotlinSkip);
});
