import { join } from 'node:path';
import type { Clock } from '../../core/src/ports.js';
import type { ImplementationPlan, TestReport } from '../../schemas/src/index.js';
import type { CommandRunner } from './command-runner.js';

// Absolute path, not a relative "./gradlew" -- avoids depending on whether the spawned
// process's relative-path resolution happens before or after `cwd` is applied.
const gradlewCommand = (workspace: string) => join(workspace, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');

// Real Kotlin/JVM projects run their full test suite through one `test` task rather than
// Node's one-file-per-suite-type convention, so every required suite type is attributed to a
// real Gradle command's real exit code -- never fabricated -- with INTEGRATION additionally
// backed by an `integrationTest` task only when the target project actually defines one.
export class GradleTestEngine {
  constructor(private commands: CommandRunner, private clock: Clock) {}

  async run(workspace: string, taskId: string, plan: ImplementationPlan): Promise<TestReport> {
    const gradlew = gradlewCommand(workspace);
    const testRun = await this.commands.run({ command: gradlew, args: ['test', '--no-daemon', '--console=plain'], cwd: workspace, taskId, allowed: ['TEST'] });
    let integrationRun: Awaited<ReturnType<CommandRunner['run']>> | undefined;
    if (plan.testsRequired.includes('INTEGRATION') && (await this.hasTask(workspace, taskId, 'integrationTest'))) {
      integrationRun = await this.commands.run({ command: gradlew, args: ['integrationTest', '--no-daemon', '--console=plain'], cwd: workspace, taskId, allowed: ['TEST'] });
    }
    const buildRun = await this.commands.run({ command: gradlew, args: ['build', '--no-daemon', '--console=plain'], cwd: workspace, taskId, allowed: ['BUILD'] });

    const suites: TestReport['suites'] = plan.testsRequired.map(type => {
      if (type === 'UNIT') return { type, command: testRun.record.command, passed: testRun.record.exitCode === 0, exitCode: testRun.record.exitCode };
      if (type === 'INTEGRATION' && integrationRun) return { type, command: integrationRun.record.command, passed: integrationRun.record.exitCode === 0, exitCode: integrationRun.record.exitCode };
      return { type, command: buildRun.record.command, passed: buildRun.record.exitCode === 0, exitCode: buildRun.record.exitCode };
    });
    return { passed: suites.length === plan.testsRequired.length && suites.every(s => s.passed), suites, finishedAt: this.clock.now() };
  }

  private async hasTask(workspace: string, taskId: string, taskName: string): Promise<boolean> {
    try {
      const gradlew = gradlewCommand(workspace);
      const listing = await this.commands.run({ command: gradlew, args: ['tasks', '--all', '--no-daemon', '--console=plain'], cwd: workspace, taskId, allowed: ['BUILD'] });
      return listing.record.exitCode === 0 && new RegExp(`^${taskName}\\b`, 'm').test(listing.stdout);
    } catch {
      return false;
    }
  }
}
