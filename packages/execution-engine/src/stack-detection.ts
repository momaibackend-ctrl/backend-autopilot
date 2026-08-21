import { access } from 'node:fs/promises';
import { join } from 'node:path';

export type ExecutionStack = 'NODE' | 'KOTLIN_GRADLE';

const gradleMarkers = ['gradlew', 'build.gradle.kts', 'build.gradle', 'settings.gradle.kts', 'settings.gradle'];

export async function detectStack(workspace: string): Promise<ExecutionStack> {
  for (const marker of gradleMarkers) {
    try {
      await access(join(workspace, marker));
      return 'KOTLIN_GRADLE';
    } catch {
      // marker absent, keep checking
    }
  }
  return 'NODE';
}
