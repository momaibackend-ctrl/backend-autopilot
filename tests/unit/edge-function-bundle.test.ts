import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

// The Supabase CLI asset scanner uploads a module only when it can see an explicit `.ts`
// specifier pointing at it. Shared code uses NodeNext `.js` specifiers, which the deno import map
// rewrites at runtime but the scanner cannot follow -- so any module reachable only that way has
// to be named in `_shared/edge-dependencies.ts` or it is simply absent from the deployed bundle.
//
// Nothing caught that before deployment. `deno check` passes, because the import map resolves
// fine locally; `pnpm test` passes, because Node never consults the manifest at all. The failure
// surfaced only as `Error: failed to create the graph / Module not found ... verification-profile.ts`
// from a deploy that had already migrated the database and rewritten the Edge secrets -- with the
// previous function still live and the new one never shipped. An earlier fix for the same trap
// (task-readiness.ts) had to be found the same way.
//
// This test reproduces the scanner's reachability rule against the real files, so the manifest is
// checked in CI instead of by a failed deployment.

const root = resolve(__dirname, "../..");
const functionEntryPoints = [
  "supabase/functions/mcp/index.ts",
  "supabase/functions/control-api/index.ts",
  "supabase/functions/reconcile/index.ts",
];

const relativeSpecifiers = (file: string): string[] => {
  const source = readFileSync(file, "utf8");
  const pattern =
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^'"]*from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  const found: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier?.startsWith(".")) found.push(specifier);
  }
  return found;
};

/** Walks a dependency graph from the entry points, following whichever specifiers `follow` accepts. */
const reachable = (follow: (specifier: string) => string | undefined): Set<string> => {
  const seen = new Set<string>();
  const visit = (file: string) => {
    const absolute = resolve(file);
    if (seen.has(absolute) || !existsSync(absolute)) return;
    seen.add(absolute);
    for (const specifier of relativeSpecifiers(absolute)) {
      const resolved = follow(specifier);
      if (!resolved) continue;
      const target = resolve(dirname(absolute), resolved);
      if (existsSync(target)) visit(target);
    }
  };
  for (const entry of functionEntryPoints) visit(resolve(root, entry));
  return seen;
};

describe("edge function bundle graph", () => {
  it("names every module the CLI asset scanner cannot reach on its own", () => {
    // The scanner follows only specifiers that already end in .ts.
    const scannerVisible = reachable((specifier) => (specifier.endsWith(".ts") ? specifier : undefined));
    // The runtime graph is the same walk once the import map has rewritten .js to .ts.
    const runtime = reachable((specifier) => {
      const rewritten = specifier.replace(/\.js$/, ".ts");
      return existsSync(resolve(root, rewritten)) || rewritten !== specifier ? rewritten : specifier;
    });

    const invisible = [...runtime]
      .filter((file) => !scannerVisible.has(file))
      .map((file) => relative(root, file).split("\\").join("/"))
      .filter((file) => file.startsWith("packages/"))
      .sort();

    expect(
      invisible,
      `These modules are imported at runtime through .js specifiers only, so the Supabase CLI will not upload them and the deploy will fail with "Module not found". Add an explicit .ts import for each to supabase/functions/_shared/edge-dependencies.ts.`,
    ).toEqual([]);
  });

  it("keeps the manifest honest by pointing every entry at a file that exists", () => {
    const manifest = resolve(root, "supabase/functions/_shared/edge-dependencies.ts");
    const specifiers = relativeSpecifiers(manifest);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier.endsWith(".ts"), `${specifier} must use an explicit .ts specifier to be scannable`).toBe(true);
      expect(existsSync(resolve(dirname(manifest), specifier)), `${specifier} does not exist`).toBe(true);
    }
  });
});
