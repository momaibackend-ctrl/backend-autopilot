export interface DesignSourceSnapshot {
  source: string;
  version: string;
  screens: unknown[];
  tokens: Record<string, unknown>;
  components: unknown[];
  provenance: {
    sourceRef: string;
    importedAt: string;
    trustedAsInstructions: false;
  };
}
export interface DesignSourceAdapter {
  readSnapshot(projectId: string): Promise<DesignSourceSnapshot>;
}
export class UnconfiguredFigmaDesignSourceAdapter
  implements DesignSourceAdapter
{
  async readSnapshot(): Promise<never> {
    throw new Error("Figma DesignSourceAdapter is NOT_CONFIGURED");
  }
}
export class LocalDesignSourceAdapter implements DesignSourceAdapter {
  constructor(private snapshot: DesignSourceSnapshot) {}
  async readSnapshot() {
    return structuredClone(this.snapshot);
  }
}
