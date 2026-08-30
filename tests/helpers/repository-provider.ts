import type { GitRepositoryProvider, RepositoryDescription } from "../../packages/canonical-repository/src/ports.js";
import type { RepositoryRef } from "../../packages/schemas/src/index.js";

export interface FakeRepositoryState {
  defaultBranch?: string;
  head?: string;
  branches?: RepositoryRef[];
  tags?: RepositoryRef[];
  commits?: string[];
  files?: Record<string, string>;
  visibility?: string;
  permissions?: Partial<RepositoryDescription["permissions"]>;
  protectedBranches?: string[];
  /** Simulates a repository the provider cannot read at all. */
  unreachable?: boolean;
  /** Identity the provider reports, when it deliberately differs from the registration. */
  reportedIdentity?: string;
}

/**
 * An in-memory Git host. It answers exactly the questions the real provider answers, so the
 * planning, export and handover rules can be exercised against real branch/tag/commit/file state
 * without a network, and a missing ref is a fact rather than a mocked rejection.
 */
export class FakeRepositoryProvider implements GitRepositoryProvider {
  constructor(private readonly repositories: Record<string, FakeRepositoryState> = {}) {}

  set(repository: string, state: FakeRepositoryState) {
    this.repositories[repository] = state;
    return this;
  }

  private state(repository: string) {
    const value = this.repositories[repository];
    if (!value || value.unreachable) throw new Error(`Repository ${repository} is not reachable`);
    return value;
  }

  async describe(repository: string): Promise<RepositoryDescription> {
    const state = this.state(repository);
    return {
      externalReference: state.reportedIdentity ?? repository,
      defaultBranch: state.defaultBranch ?? "main",
      isEmpty: !state.head,
      visibility: state.visibility ?? "private",
      permissions: { pull: true, push: true, admin: true, ...state.permissions },
      protectedBranches: state.protectedBranches ?? [],
    };
  }
  async resolveRef(repository: string, ref: string) {
    const state = this.state(repository);
    if (ref === (state.defaultBranch ?? "main")) return state.head;
    return (state.branches ?? []).find((value) => value.name === ref)?.sha
      ?? (state.tags ?? []).find((value) => value.name === ref)?.sha;
  }
  async commitExists(repository: string, sha: string) {
    const state = this.state(repository);
    return (state.commits ?? [state.head].filter((value): value is string => Boolean(value))).includes(sha);
  }
  async listRefs(repository: string) {
    const state = this.state(repository);
    return { branches: state.branches ?? [], tags: state.tags ?? [] };
  }
  async readFile(repository: string, path: string) {
    return this.state(repository).files?.[path];
  }
  async listDirectory(repository: string, path: string) {
    const files = Object.keys(this.state(repository).files ?? {}).filter((value) => value.startsWith(`${path}/`));
    return files.length ? files : undefined;
  }
}

export const commitSha = (seed: string) => seed.padEnd(40, "0").slice(0, 40).replace(/[^0-9a-f]/g, "a");
