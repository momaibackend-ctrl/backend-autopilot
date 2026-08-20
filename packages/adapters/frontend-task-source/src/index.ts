export interface FrontendTaskSnapshot {
  projectId: string;
  repository?: string;
  tasks: unknown[];
  contractVersion?: string;
  provenance: {
    sourceRef: string;
    importedAt: string;
    trustedAsInstructions: false;
  };
}
export interface FrontendTaskSourceAdapter {
  readTasks(projectId: string): Promise<FrontendTaskSnapshot>;
}
export class UnconfiguredFrontendTaskSourceAdapter
  implements FrontendTaskSourceAdapter
{
  async readTasks(): Promise<never> {
    throw new Error("FrontendTaskSourceAdapter is NOT_CONFIGURED");
  }
}
export class LocalFrontendTaskSourceAdapter
  implements FrontendTaskSourceAdapter
{
  constructor(private snapshot: FrontendTaskSnapshot) {}
  async readTasks() {
    return structuredClone(this.snapshot);
  }
}
