import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { provisionGradleWrapper } from '../../packages/execution-engine/src/gradle-wrapper-provisioner.js';

const pinnedTemplateDir = fileURLToPath(new URL('../../examples/kotlin-sandbox-base/', import.meta.url));

describe('provisionGradleWrapper', () => {
  // Regression for MOMNA-990: a caller can only submit gradlew as a plain-text file change,
  // which git/the filesystem may land as a non-executable 0644 file -- exactly what produced
  // "EACCES spawning gradlew" on the Linux GitHub Actions runner.
  it('overwrites a non-executable, structured-change gradlew stub with the pinned wrapper and restores the exec bit', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'gradle-wrapper-'));
    await writeFile(join(workspace, 'build.gradle.kts'), '');
    await writeFile(join(workspace, 'gradlew'), '#!/bin/sh\necho fake\n', { mode: 0o644 });

    const changed = await provisionGradleWrapper(workspace, pinnedTemplateDir);
    expect(changed).toBe(true);

    const provisioned = await stat(join(workspace, 'gradlew'));
    if (process.platform !== 'win32') expect(provisioned.mode & 0o777).toBe(0o755);

    const pinned = await stat(join(pinnedTemplateDir, 'gradlew'));
    expect(provisioned.size).toBe(pinned.size);
  });

  it('is a no-op when no Gradle project marker is present in the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'gradle-wrapper-none-'));
    await writeFile(join(workspace, 'package.json'), '{}');
    expect(await provisionGradleWrapper(workspace, pinnedTemplateDir)).toBe(false);
  });
});
