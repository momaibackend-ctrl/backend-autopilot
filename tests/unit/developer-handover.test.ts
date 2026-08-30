import { describe, expect, it } from "vitest";
import { buildDeveloperHandoverReport, requiredHandoverDocuments } from "../../packages/canonical-repository/src/handover.js";
import { commitSha } from "../helpers/repository-provider.js";

const headSha = commitSha("aaaa1111");
const now = "2026-08-30T00:00:00.000Z";
const filler = (topic: string) => `# ${topic}\n\n${`Concrete ${topic} facts for this service. `.repeat(12)}\n`;

/** A repository that satisfies every objective check, used as the baseline to break one at a time. */
function completeDocuments(): Record<string, string | undefined> {
  return {
    "README.md": `# Service\n\n## Quick start\n\n\`\`\`bash\ngit clone git@github.com:momai/app.git\ncd app\n./gradlew build\n\`\`\`\n\n${filler("quick start")}`,
    ".env.example": "DATABASE_URL=postgresql://user:password@localhost:5432/app\nREDIS_URL=redis://localhost:6379\nS3_BUCKET=local-bucket\n",
    "docs/handover/README.md": filler("handover index"),
    "docs/handover/architecture.md": `${filler("architecture")}\n## Ownership\n\nEach module owns its data; no second source of truth is permitted.\n`,
    "docs/handover/local-development.md": `${filler("local development")}\n\`\`\`bash\ndocker compose up -d postgres redis minio\n./gradlew bootRun\n\`\`\`\n`,
    "docs/handover/infrastructure.md": `${filler("infrastructure")}\n| Item | Status |\n| --- | --- |\n| Staging database | REQUIRES_OPERATOR_SETUP |\n`,
    "docs/handover/database.md": `${filler("database")}\nRun the migrations with \`./gradlew flywayMigrate\`.\n`,
    "docs/handover/contracts.md": `${filler("contracts")}\nEvery cross-module contract lives in the contract module.\n`,
    "docs/handover/testing.md": `${filler("testing")}\n\`\`\`bash\n./gradlew test integrationTest\n\`\`\`\n`,
    "docs/handover/deployment.md": filler("deployment"),
    "docs/handover/troubleshooting.md": `${filler("troubleshooting")}\n## Database refuses connections\n`,
    "docs/handover/change-guide.md": `${filler("change guide")}\n1. Determine the owning module.\n2. Find the existing contract.\n`,
  };
}

const report = (documents: Record<string, string | undefined>, canonicalActive = true) =>
  buildDeveloperHandoverReport({
    projectId: "11111111-1111-4111-8111-111111111111",
    repository: "momai/app",
    defaultBranch: "main",
    headSha,
    canonicalActive,
    documents,
    now,
  });

const check = (value: ReturnType<typeof report>, name: string) => value.checks.find((entry) => entry.check === name);
const codes = (value: ReturnType<typeof report>) => value.blockers.map((blocker) => blocker.code);

describe("developer handover gate", () => {
  it("passes a repository a human developer could actually pick up", () => {
    const value = report(completeDocuments());
    expect(value.result).toBe("PASS");
    expect(value.blockers).toEqual([]);
    expect(value.headSha).toBe(headSha);
    expect(check(value, "DOCUMENTATION_READ_AT_EXACT_COMMIT")?.status).toBe("PASS");
  });

  it("blocks when the project has no ACTIVE canonical repository to hand over", () => {
    const value = report(completeDocuments(), false);
    expect(value.canonicalRepositoryStatus).toBe("ABSENT");
    expect(codes(value)).toContain("CANONICAL_REPOSITORY_ABSENT");
  });

  it("names every missing required document", () => {
    const documents = completeDocuments();
    delete documents["docs/handover/change-guide.md"];
    delete documents["docs/handover/testing.md"];
    const value = report(documents);
    expect(codes(value)).toContain("HANDOVER_DOCUMENTS_MISSING");
    expect(check(value, "HANDOVER_DOCUMENTS_PRESENT")?.detail).toContain("change-guide.md");
    expect(check(value, "HANDOVER_DOCUMENTS_PRESENT")?.detail).toContain("testing.md");
  });

  it("rejects a placeholder that merely occupies the required path", () => {
    const documents = completeDocuments();
    documents["docs/handover/deployment.md"] = "# Deployment\n\nTODO.\n";
    const value = report(documents);
    expect(codes(value)).toContain("HANDOVER_DOCUMENTS_PLACEHOLDER");
  });

  it("rejects a real credential in .env.example", () => {
    const documents = completeDocuments();
    documents[".env.example"] = "GITHUB_TOKEN=ghp_S3cr3tValueThatIsRealAndLong0000000000\n";
    const value = report(documents);
    expect(codes(value)).toContain("ENV_EXAMPLE_CONTAINS_SECRET");
  });

  it("rejects secret material anywhere else in the documentation", () => {
    const documents = completeDocuments();
    documents["docs/handover/infrastructure.md"] = `${documents["docs/handover/infrastructure.md"]}\nGITHUB_TOKEN=ghp_S3cr3tValueThatIsRealAndLong0000000000\n`;
    const value = report(documents);
    expect(codes(value)).toContain("DOCUMENTATION_CONTAINS_SECRET");
  });

  it("rejects absolute developer-machine paths nobody else can follow", () => {
    for (const path of ["C:\\Users\\alex\\projects\\app", "/home/alex/projects/app", "/Users/alex/projects/app"]) {
      const documents = completeDocuments();
      documents["docs/handover/local-development.md"] = `${documents["docs/handover/local-development.md"]}\nOpen ${path} and run the build.\n`;
      expect(codes(report(documents)), path).toContain("DOCUMENTATION_CONTAINS_ABSOLUTE_PATH");
    }
  });

  it("rejects local development instructions that need Backend Autopilot at all", () => {
    for (const requirement of ["Set AUTOPILOT_SUPERADMIN_MCP_TOKEN before building.", "Call superadmin_task_execute to build.", "Connect the MCP server first."]) {
      const documents = completeDocuments();
      documents["docs/handover/local-development.md"] = `${documents["docs/handover/local-development.md"]}\n${requirement}\n`;
      expect(codes(report(documents)), requirement).toContain("LOCAL_DEVELOPMENT_REQUIRES_AUTOPILOT");
    }
  });

  it("checks documented substance, not prose quality", () => {
    const documents = completeDocuments();
    documents["docs/handover/testing.md"] = filler("testing prose with no runnable command at all");
    documents["docs/handover/database.md"] = filler("storage overview that never mentions how to apply schema changes");
    const value = report(documents);
    expect(codes(value)).toEqual(expect.arrayContaining(["TEST_COMMANDS_MISSING", "MIGRATION_INSTRUCTIONS_MISSING"]));
    // Nothing in the report judges tone, length beyond the placeholder floor, or writing style.
    expect(value.checks.every((entry) => !/quality|readab|style|tone/i.test(entry.check))).toBe(true);
  });

  it("reports an unresolvable head commit as UNVERIFIED rather than inventing one", () => {
    const value = buildDeveloperHandoverReport({ projectId: "11111111-1111-4111-8111-111111111111", canonicalActive: true, documents: completeDocuments(), now });
    expect(check(value, "DOCUMENTATION_READ_AT_EXACT_COMMIT")?.status).toBe("UNVERIFIED");
    expect(value.headSha).toBeUndefined();
  });

  it("keeps the required document list stable so a repository can be prepared against it", () => {
    expect([...requiredHandoverDocuments]).toEqual([
      "README.md",
      ".env.example",
      "docs/handover/README.md",
      "docs/handover/architecture.md",
      "docs/handover/local-development.md",
      "docs/handover/infrastructure.md",
      "docs/handover/database.md",
      "docs/handover/contracts.md",
      "docs/handover/testing.md",
      "docs/handover/deployment.md",
      "docs/handover/troubleshooting.md",
      "docs/handover/change-guide.md",
    ]);
  });
});
