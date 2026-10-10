import { access, chmod, copyFile, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const gradleProjectMarkers = ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts', 'settings.gradle'];

export async function hasGradleProject(workspace: string): Promise<boolean> {
  const checks = await Promise.all(gradleProjectMarkers.map(name => access(join(workspace, name)).then(() => true).catch(() => false)));
  return checks.some(Boolean);
}

async function exists(path: string) {
  return access(path).then(() => true).catch(() => false);
}

/** A real wrapper script bootstraps GradleWrapperMain from gradle-wrapper.jar; a stub does not. */
async function isWrapperScript(path: string) {
  const text = await readFile(path, 'utf8').catch(() => '');
  return /GradleWrapperMain|gradle-wrapper\.jar/.test(text);
}

/** A jar is a zip archive; a text file submitted under that name is not. */
async function isJar(path: string) {
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) return false;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0);
    return bytesRead === 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
  } finally {
    await handle.close();
  }
}

// The project's wrapper is the source of truth -- above all gradle-wrapper.properties, which pins
// the Gradle version the project builds with. Only what is missing or demonstrably broken is
// replaced from the pinned template:
//
//   * gradlew that is not a wrapper script -- a caller (e.g. ChatGPT via MCP) can only submit
//     plain-text files, so a submitted gradlew can be a stub, and lands 0644 (MOMNA-990 EACCES);
//   * gradle-wrapper.jar that is missing or not a zip -- a text write can never produce one;
//   * gradlew.bat or gradle-wrapper.properties that are missing.
//
// An earlier version overwrote all four files in every Gradle project, which silently downgraded
// a Gradle 9.1 project to the template's 8.10.2 and broke its Java 25 build ("Unsupported class
// file major version 69"). The executable bit is always set on gradlew. Returns the files it
// replaced; the caller commits only when the working tree actually changed.
export async function provisionGradleWrapper(workspace: string, pinnedTemplateDir: string): Promise<string[] | false> {
  if (!(await hasGradleProject(workspace))) return false;
  await mkdir(join(workspace, 'gradle', 'wrapper'), { recursive: true });
  const replaced: string[] = [];
  const replace = async (relative: string) => {
    await copyFile(join(pinnedTemplateDir, relative), join(workspace, relative));
    replaced.push(relative.split('\\').join('/'));
  };
  if (!(await isWrapperScript(join(workspace, 'gradlew')))) await replace('gradlew');
  if (!(await exists(join(workspace, 'gradlew.bat')))) await replace('gradlew.bat');
  const jar = join('gradle', 'wrapper', 'gradle-wrapper.jar');
  if (!(await isJar(join(workspace, jar)))) await replace(jar);
  const properties = join('gradle', 'wrapper', 'gradle-wrapper.properties');
  if (!(await exists(join(workspace, properties)))) await replace(properties);
  await chmod(join(workspace, 'gradlew'), 0o755);
  return replaced;
}
