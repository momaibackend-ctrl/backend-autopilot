import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { provisionGradleWrapper } from '../../packages/execution-engine/src/gradle-wrapper-provisioner.js';

const pinnedTemplateDir = fileURLToPath(new URL('../../examples/kotlin-sandbox-base/', import.meta.url));
const properties = join('gradle', 'wrapper', 'gradle-wrapper.properties');
const jar = join('gradle', 'wrapper', 'gradle-wrapper.jar');
const gradle91 = 'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.1.0-bin.zip\n';

/** A project that carries its own complete wrapper, pinned to Gradle 9.1.0. */
async function projectWithOwnWrapper() {
  const workspace = await mkdtemp(join(tmpdir(), 'gradle-wrapper-own-'));
  await writeFile(join(workspace, 'settings.gradle.kts'), 'rootProject.name = "java-port"\n');
  await mkdir(join(workspace, 'gradle', 'wrapper'), { recursive: true });
  for (const file of ['gradlew', 'gradlew.bat', jar]) await copyFile(join(pinnedTemplateDir, file), join(workspace, file));
  await writeFile(join(workspace, properties), gradle91);
  return workspace;
}

describe('provisionGradleWrapper', () => {
  // Regression for MOMNA-990: a caller can only submit gradlew as a plain-text file change,
  // which git/the filesystem may land as a non-executable 0644 file -- exactly what produced
  // "EACCES spawning gradlew" on the Linux GitHub Actions runner.
  it('replaces a non-executable stub gradlew and the missing wrapper files, and restores the exec bit', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'gradle-wrapper-'));
    await writeFile(join(workspace, 'build.gradle.kts'), '');
    await writeFile(join(workspace, 'gradlew'), '#!/bin/sh\necho fake\n', { mode: 0o644 });

    const replaced = await provisionGradleWrapper(workspace, pinnedTemplateDir);
    expect(replaced).toEqual(['gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar', 'gradle/wrapper/gradle-wrapper.properties']);

    const provisioned = await stat(join(workspace, 'gradlew'));
    if (process.platform !== 'win32') expect(provisioned.mode & 0o777).toBe(0o755);
    expect(provisioned.size).toBe((await stat(join(pinnedTemplateDir, 'gradlew'))).size);
  });

  // Regression for the Java port: overwriting every wrapper file downgraded a Gradle 9.1.0 project
  // to the template's 8.10.2 and broke its Java 25 build ("Unsupported class file major version 69").
  it("never touches a project's own working wrapper, and keeps its Gradle version", async () => {
    const workspace = await projectWithOwnWrapper();
    expect(await provisionGradleWrapper(workspace, pinnedTemplateDir)).toEqual([]);
    expect(await readFile(join(workspace, properties), 'utf8')).toBe(gradle91);
  });

  it('replaces only a jar that is not a jar, keeping the project version', async () => {
    const workspace = await projectWithOwnWrapper();
    await writeFile(join(workspace, jar), 'not a zip, written as text');
    expect(await provisionGradleWrapper(workspace, pinnedTemplateDir)).toEqual(['gradle/wrapper/gradle-wrapper.jar']);
    expect(await readFile(join(workspace, properties), 'utf8')).toBe(gradle91);
  });

  it('keeps a real wrapper script even when it lost its exec bit, and restores the bit', async () => {
    const workspace = await projectWithOwnWrapper();
    const script = await readFile(join(workspace, 'gradlew'));
    await writeFile(join(workspace, 'gradlew'), script, { mode: 0o644 });
    expect(await provisionGradleWrapper(workspace, pinnedTemplateDir)).toEqual([]);
    if (process.platform !== 'win32') expect((await stat(join(workspace, 'gradlew'))).mode & 0o777).toBe(0o755);
  });

  it('is a no-op when no Gradle project marker is present in the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'gradle-wrapper-none-'));
    await writeFile(join(workspace, 'package.json'), '{}');
    expect(await provisionGradleWrapper(workspace, pinnedTemplateDir)).toBe(false);
  });
});
