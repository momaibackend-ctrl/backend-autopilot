import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectGradleFailures, collectGradleTotals, parseGradleTranscriptFailures, parseGradleTranscriptTotals, parseJUnitFailures, parseJUnitTotals } from "../../packages/execution-engine/src/test-failures.js";

const junit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.momna.architecture.ModuleContractCatalogTest" tests="3" skipped="1" failures="1" errors="0">
  <testcase name="contracts are complete()" classname="com.momna.architecture.ModuleContractCatalogTest" time="0.1"/>
  <testcase name="http package imports core and platform behavior only from contract packages()" classname="com.momna.architecture.ModuleContractCatalogTest" time="0.2">
    <failure message="API bypasses public contract in src/main/kotlin/Application.kt: import com.momna.platform.database.JdbcTransactionExecutor ==&gt; expected: &lt;true&gt; but was: &lt;false&gt;" type="org.opentest4j.AssertionFailedError">org.opentest4j.AssertionFailedError: ...
	at com.momna.architecture.ModuleContractCatalogTest</failure>
  </testcase>
  <testcase name="skipped()" classname="com.momna.architecture.ModuleContractCatalogTest"><skipped/></testcase>
</testsuite>`;

describe("failing tests by name", () => {
  it("reads JUnit XML: only failures, with class, name and the first line of the message", () => {
    expect(parseJUnitFailures(junit)).toEqual([
      {
        test: "com.momna.architecture.ModuleContractCatalogTest > http package imports core and platform behavior only from contract packages()",
        message: "API bypasses public contract in src/main/kotlin/Application.kt: import com.momna.platform.database.JdbcTransactionExecutor ==> expected: <true> but was: <false>",
      },
    ]);
  });

  it("falls back to the Gradle transcript and ignores the task-level FAILED line", () => {
    const transcript = "ObservabilityContractTest > accepts events() STANDARD_OUT\nModuleContractCatalogTest > http package imports only contracts() FAILED\n    org.opentest4j.AssertionFailedError at ModuleContractCatalogTest.kt:64\n\n> Task :test FAILED\n";
    expect(parseGradleTranscriptFailures(transcript)).toEqual([{ test: "ModuleContractCatalogTest > http package imports only contracts()", message: "org.opentest4j.AssertionFailedError at ModuleContractCatalogTest.kt:64" }]);
  });

  it("prefers the XML results of the workspace and bounds the list", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "test-failures-"));
    await mkdir(join(workspace, "build", "test-results", "test"), { recursive: true });
    await writeFile(join(workspace, "build", "test-results", "test", "TEST-a.xml"), junit);
    const failures = await collectGradleFailures(workspace, "Other > ignored() FAILED\n");
    expect(failures.map((value) => value.test)).toEqual(["com.momna.architecture.ModuleContractCatalogTest > http package imports core and platform behavior only from contract packages()"]);
    const many = Array.from({ length: 80 }, (_, index) => `T${index} > t() FAILED`).join("\n");
    expect(await collectGradleFailures(await mkdtemp(join(tmpdir(), "test-failures-")), many)).toHaveLength(50);
  });
});

describe("executed test totals", () => {
  it("reads a testsuite's counts, errors counted as failures", () => {
    expect(parseJUnitTotals('<testsuite name="A" tests="3" skipped="1" failures="1" errors="1" time="0.2">')).toEqual({ tests: 3, failures: 2, skipped: 1 });
  });

  it("falls back to Gradle's summary line", () => {
    expect(parseGradleTranscriptTotals("473 tests completed, 1 failed, 9 skipped\n")).toEqual({ tests: 473, failures: 1, skipped: 9 });
    expect(parseGradleTranscriptTotals("12 tests completed\n")).toEqual({ tests: 12, failures: 0, skipped: 0 });
    expect(parseGradleTranscriptTotals("BUILD SUCCESSFUL")).toBeUndefined();
  });

  it("sums the workspace's XML results", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "test-totals-"));
    await mkdir(join(workspace, "build", "test-results", "test"), { recursive: true });
    await writeFile(join(workspace, "build", "test-results", "test", "TEST-a.xml"), junit);
    await writeFile(join(workspace, "build", "test-results", "test", "TEST-b.xml"), '<testsuite name="B" tests="5" skipped="0" failures="0" errors="0">');
    expect(await collectGradleTotals(workspace, "")).toEqual({ tests: 8, failures: 1, skipped: 1 });
  });
});
