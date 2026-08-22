import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Gradle wrapper provisioning restores executable mode and uses pinned files', async () => {
  const source = await readFile(new URL('../packages/execution-engine/src/gradle-wrapper-provisioner.ts', import.meta.url), 'utf8');
  assert.match(source, /wrapperRelativePaths[\s\S]*gradlew[\s\S]*gradle-wrapper\.properties[\s\S]*gradle-wrapper\.jar/);
  assert.match(source, /copyFile\(join\(pinnedTemplateDir,\s*relative\),\s*join\(workspace,\s*relative\)\)/);
  assert.match(source, /chmod\(join\(workspace,\s*'gradlew'\),\s*0o755\)/);
});
