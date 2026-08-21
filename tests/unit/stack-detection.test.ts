import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { detectStack } from '../../packages/execution-engine/src/stack-detection.js';

describe('detectStack', () => {
  it('defaults to NODE when no Gradle markers are present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stack-node-'));
    await writeFile(join(dir, 'package.json'), '{}');
    expect(await detectStack(dir)).toBe('NODE');
  });
  it('detects KOTLIN_GRADLE from a gradlew wrapper script', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stack-gradle-'));
    await writeFile(join(dir, 'gradlew'), '#!/bin/sh\n');
    expect(await detectStack(dir)).toBe('KOTLIN_GRADLE');
  });
  it('detects KOTLIN_GRADLE from build.gradle.kts alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stack-gradle-kts-'));
    await writeFile(join(dir, 'build.gradle.kts'), '');
    expect(await detectStack(dir)).toBe('KOTLIN_GRADLE');
  });
});
