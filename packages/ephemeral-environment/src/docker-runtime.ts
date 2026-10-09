// ContainerRuntime over the Docker CLI, through the shared CommandRunner: shell:false, the
// ENVIRONMENT command category (CommandPolicy refuses privileged mode, host namespaces, added
// capabilities, devices, the Docker socket and host system binds), and a command journal.
//
// Environment variables are passed as `-e NAME` with the value in the docker CLI's own process
// environment, so a generated credential never appears in argv, in the journal or in `ps`.
import type { CommandRunner } from "../../execution-engine/src/command-runner.js";
import type { ContainerRuntime, StepOutcome } from "./executor.js";

export class DockerRuntime implements ContainerRuntime {
  constructor(
    private readonly commands: CommandRunner,
    /** Absolute host path of the checked-out project, mounted at /workspace. */
    private readonly workspace: string,
    private readonly journalId: string,
  ) {}

  private async docker(args: string[], env: Record<string, string> = {}): Promise<StepOutcome> {
    const started = Date.now();
    const result = await this.commands.run({ command: "docker", args, cwd: this.workspace, taskId: this.journalId, allowed: ["ENVIRONMENT"], env });
    return { exitCode: result.record.exitCode, output: `${result.stdout}${result.stderr}`, durationMs: Date.now() - started };
  }

  private async required(args: string[], env: Record<string, string> = {}) {
    const outcome = await this.docker(args, env);
    if (outcome.exitCode !== 0) throw new Error(`docker ${args[0]} failed (${outcome.exitCode}): ${outcome.output.slice(-2000)}`);
    return outcome;
  }

  private static envFlags(env: Record<string, string>) {
    return Object.keys(env).flatMap((name) => ["-e", name]);
  }

  async prepare(input: { network: string; cacheVolume: string }) {
    await this.required(["network", "create", input.network]);
    await this.required(["volume", "create", input.cacheVolume]);
  }

  async startService(input: { name: string; image: string; env: Record<string, string>; network: string }) {
    await this.required(["run", "-d", "--name", input.name, "--network", input.network, ...DockerRuntime.envFlags(input.env), input.image], input.env);
  }

  exec(input: { name: string; argv: string[]; env?: Record<string, string> }) {
    return this.docker(["exec", ...DockerRuntime.envFlags(input.env ?? {}), input.name, ...input.argv], input.env ?? {});
  }

  runStep(input: { name: string; image: string; argv: string[]; env: Record<string, string>; workdir: string; network: string; cacheVolume: string }) {
    return this.docker(
      [
        "run",
        "--rm",
        "--name",
        input.name,
        "--network",
        input.network,
        "-v",
        `${this.workspace}:/workspace`,
        "-v",
        `${input.cacheVolume}:/cache`,
        "-w",
        input.workdir,
        ...DockerRuntime.envFlags(input.env),
        input.image,
        ...input.argv,
      ],
      input.env,
    );
  }

  async startApplication(input: {
    name: string;
    image: string;
    argv: string[];
    env: Record<string, string>;
    workdir: string;
    network: string;
    cacheVolume: string;
    containerPort: number;
    hostPort: number;
  }) {
    await this.required(
      [
        "run",
        "-d",
        "--name",
        input.name,
        "--network",
        input.network,
        // Published on loopback only: the application is reachable from the runner, not the world.
        "-p",
        `127.0.0.1:${input.hostPort}:${input.containerPort}`,
        "-v",
        `${this.workspace}:/workspace`,
        "-v",
        `${input.cacheVolume}:/cache`,
        "-w",
        input.workdir,
        ...DockerRuntime.envFlags(input.env),
        input.image,
        ...input.argv,
      ],
      input.env,
    );
  }

  async isRunning(name: string) {
    const outcome = await this.docker(["inspect", "--format", "{{.State.Running}}", name]);
    return outcome.exitCode === 0 && outcome.output.trim() === "true";
  }

  async logs(name: string, tailLines: number) {
    return (await this.docker(["logs", "--tail", String(tailLines), name])).output;
  }

  async cleanup(input: { names: string[]; network: string; cacheVolume: string }) {
    if (input.names.length) await this.docker(["rm", "-f", "-v", ...input.names]);
    await this.docker(["network", "rm", input.network]);
    await this.docker(["volume", "rm", "-f", input.cacheVolume]);
  }
}
