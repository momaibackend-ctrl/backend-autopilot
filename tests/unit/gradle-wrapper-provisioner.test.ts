import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
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

  // Second MOMNA-990 regression: wrapper normalization must remain strictly after the
  // ExecutionEngine snapshot/clean-tree guard. A previous retry chmod'ed gradlew during
  // dependency preparation, producing " M gradlew" before snapshot() and making the runtime
  // reject its own controlled preparation. Lock the runner ordering so that cannot regress.
  it('keeps Gradle wrapper normalization after clean-tree validation and semantic execution', async () => {
    const source = await readFile(join(process.cwd(), 'scripts', 'run-execution-job.ts'), 'utf8');
    const kotlinPreparationSkip = source.indexOf("if(stack==='KOTLIN_GRADLE')return;");
    const semanticExecution = source.indexOf('const result=await execution.execute');
    const wrapperNormalization = source.indexOf('const provisionedWrapperSha=await commitProvisionedGradleWrapper');

    expect(kotlinPreparationSkip).toBeGreaterThan(-1);
    expect(semanticExecution).toBeGreaterThan(kotlinPreparationSkip);
    expect(wrapperNormalization).toBeGreaterThan(semanticExecution);

    const beforeSemanticExecution = source.slice(kotlinPreparationSkip, semanticExecution);
    expect(beforeSemanticExecution).not.toContain('chmod');
    expect(beforeSemanticExecution).not.toContain('provisionGradleWrapper');
  });

  it('is a no-op when no Gradle project marker is present in the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'gradle-wrapper-none-'));
    await writeFile(join(workspace, 'package.json'), '{}');
    expect(await provisionGradleWrapper(workspace, pinnedTemplateDir)).toBe(false);
  });
});
