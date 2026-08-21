import type { Clock } from '../../core/src/ports.js';
import type { ImplementationPlan, TestReport } from '../../schemas/src/index.js';
import type { CommandRunner } from './command-runner.js';
import { GradleTestEngine } from './gradle-test-engine.js';
import { detectStack } from './stack-detection.js';
import { TestEngine } from './test-engine.js';

// Selects the Node or Kotlin/Gradle TestExecutor per job based on what's actually checked out,
// so the caller (AutopilotService) is constructed once and never needs to know which stack a
// given task's workspace turns out to be.
export class StackAwareTestExecutor {
  private readonly node: TestEngine;
  private readonly gradle: GradleTestEngine;

  constructor(commands: CommandRunner, clock: Clock) {
    this.node = new TestEngine(commands, clock);
    this.gradle = new GradleTestEngine(commands, clock);
  }

  async run(workspace: string, taskId: string, plan: ImplementationPlan): Promise<TestReport> {
    const stack = await detectStack(workspace);
    return stack === 'KOTLIN_GRADLE' ? this.gradle.run(workspace, taskId, plan) : this.node.run(workspace, taskId, plan);
  }
}
