import { access, chmod, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const gradleProjectMarkers = ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts', 'settings.gradle'];
const wrapperRelativePaths = ['gradlew', 'gradlew.bat', join('gradle', 'wrapper', 'gradle-wrapper.properties'), join('gradle', 'wrapper', 'gradle-wrapper.jar')];

export async function hasGradleProject(workspace: string): Promise<boolean> {
  const checks = await Promise.all(gradleProjectMarkers.map(name => access(join(workspace, name)).then(() => true).catch(() => false)));
  return checks.some(Boolean);
}

// A caller (e.g. ChatGPT via MCP) can only submit plain-text file changes, so a submitted
// gradlew/gradle-wrapper.* is never a genuine, working wrapper (gradle-wrapper.jar is a binary
// distribution bootstrapper) and whatever file mode the change lands with -- 0644 is what a
// structured/text-only write produces -- is never guaranteed to be executable on the Linux
// runner (this is what made MOMNA-990 fail with EACCES). Whenever a Gradle project marker is
// present, this overwrites the wrapper with a pinned, known-good copy and force-sets the exec
// bit, regardless of what mode or content the caller's change actually had.
export async function provisionGradleWrapper(workspace: string, pinnedTemplateDir: string): Promise<boolean> {
  if (!(await hasGradleProject(workspace))) return false;
  await mkdir(join(workspace, 'gradle', 'wrapper'), { recursive: true });
  for (const relative of wrapperRelativePaths) {
    await copyFile(join(pinnedTemplateDir, relative), join(workspace, relative));
  }
  await chmod(join(workspace, 'gradlew'), 0o755);
  return true;
}
