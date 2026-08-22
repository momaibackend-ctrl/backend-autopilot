import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('clean-working-tree guard remains enforced', async () => {
  const source = await readFile(new URL('../packages/adapters/git/src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /status','--porcelain/);
  assert.match(source, /Target repository must have a clean working tree/);
  assert.match(source, /async snapshot\([^)]*\).*?await this\.ensureClean\(/s);
});
