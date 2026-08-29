import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '../../core/src/ports.js';
import type { ImplementationPlan, TestReport } from '../../schemas/src/index.js';
import type { CommandRunner } from './command-runner.js';
import { buildPropertyBasedReport, parsePropertyReportFile, parsePropertyRunnerOutput, type ParsedPropertyRun } from './property-based-report.js';

// Absolute path, not a relative "./gradlew" -- avoids depending on whether the spawned
// process's relative-path resolution happens before or after `cwd` is applied.
const gradlewCommand = (workspace: string) => join(workspace, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');

// Where a JVM project may hand the gate its own generative summary when the runner is silent.
const propertyReportPaths = ['build/reports/property-based-report.json', 'reports/property-based-report.json'];

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

    // jqwik reports itself on stdout of whichever task carried the properties. `--console=plain`
    // above is what keeps that transcript parseable rather than overwritten by a progress bar.
    const propertyRequired = plan.testsRequired.includes('PROPERTY');
    const transcript = [testRun.stdout, integrationRun?.stdout ?? '', buildRun.stdout].join('\n');
    const fromOutput = parsePropertyRunnerOutput(transcript);
    const fromFile = fromOutput ? undefined : await readPropertyReportFile(workspace);
    const propertyBased = buildPropertyBasedReport({
      required: propertyRequired,
      suitePassed: testRun.record.exitCode === 0,
      parsed: fromOutput ?? fromFile,
      source: fromOutput ? 'PARSED_RUNNER_OUTPUT' : fromFile ? 'REPORT_FILE' : 'NONE',
    });

    const suites: TestReport['suites'] = plan.testsRequired.map(type => {
      if (type === 'UNIT') return { type, command: testRun.record.command, passed: testRun.record.exitCode === 0, exitCode: testRun.record.exitCode };
      if (type === 'INTEGRATION' && integrationRun) return { type, command: integrationRun.record.command, passed: integrationRun.record.exitCode === 0, exitCode: integrationRun.record.exitCode };
      // A generative layer is the one suite a green build cannot vouch for, so its verdict comes
      // from the parsed evidence. Exit code 0 with no properties is a fail, and correctly so.
      if (type === 'PROPERTY') return { type, command: testRun.record.command, passed: propertyBased.status === 'PASS', exitCode: propertyBased.status === 'PASS' ? 0 : testRun.record.exitCode || 1 };
      return { type, command: buildRun.record.command, passed: buildRun.record.exitCode === 0, exitCode: buildRun.record.exitCode };
    });
    return {
      passed: suites.length === plan.testsRequired.length && suites.every(s => s.passed),
      suites,
      ...(propertyRequired || propertyBased.evidence !== 'NONE' ? { propertyBased } : {}),
      finishedAt: this.clock.now(),
    };
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

export async function readPropertyReportFile(workspace: string): Promise<ParsedPropertyRun | undefined> {
  for (const relative of propertyReportPaths) {
    try {
      const parsed = parsePropertyReportFile(await readFile(join(workspace, relative), 'utf8'));
      if (parsed) return parsed;
    } catch {
      // Absent or unreadable is the normal case; the caller records NONE evidence for it.
    }
  }
  return undefined;
}
