import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Gradle wrapper provisioning restores executable mode and uses pinned files', async () => {
  const source = await readFile(new URL('../packages/execution-engine/src/gradle-wrapper-provisioner.ts', import.meta.url), 'utf8');
  assert.match(source, /copyFile\(join\(templateDir,'gradlew'\),gradlew\)/);
  assert.match(source, /chmod\(gradlew,0o755\)/);
  assert.match(source, /gradle-wrapper\.jar/);
  assert.match(source, /gradle-wrapper\.properties/);
});
