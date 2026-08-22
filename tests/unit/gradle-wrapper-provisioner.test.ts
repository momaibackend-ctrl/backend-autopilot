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

  // Second MOMNA-990 regression: the runtime call sequence must validate/snapshot through
  // execution.execute() before wrapper normalization. Separately, Kotlin dependency preparation
  // must return before package-manager preparation so it cannot mutate gradlew pre-snapshot.
  it('keeps Gradle wrapper normalization after semantic execution and skips pre-execution Kotlin preparation', async () => {
    const source = await readFile(join(process.cwd(), 'scripts', 'run-execution-job.ts'), 'utf8');
    const dependencyPreparation = source.indexOf('await installTargetDependencies(workspace,current,commands,stack)');
    const semanticExecution = source.indexOf('const result=await execution.execute');
    const wrapperNormalization = source.indexOf('const provisionedWrapperSha=await commitProvisionedGradleWrapper');

    expect(dependencyPreparation).toBeGreaterThan(-1);
    expect(semanticExecution).toBeGreaterThan(dependencyPreparation);
    expect(wrapperNormalization).toBeGreaterThan(semanticExecution);

    const installStart = source.indexOf('async function installTargetDependencies');
    const installEnd = source.indexOf('async function commitProvisionedGradleWrapper');
    const installBody = source.slice(installStart, installEnd);
    const kotlinSkip = installBody.indexOf("if(stack==='KOTLIN_GRADLE')return;");
    const packagePreparation = installBody.indexOf("access(join(workspace,'package.json'))");
    expect(kotlinSkip).toBeGreaterThan(-1);
    expect(packagePreparation).toBeGreaterThan(kotlinSkip);
  });

  it('is a no-op when no Gradle project marker is present in the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'gradle-wrapper-none-'));
    await writeFile(join(workspace, 'package.json'), '{}');
    expect(await provisionGradleWrapper(workspace, pinnedTemplateDir)).toBe(false);
  });
});
