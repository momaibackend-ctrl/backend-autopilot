import { readFile } from "node:fs/promises";
import * as httpRunner from "../../packages/http-runner/src/index.js";

export interface PublishedTool {
  name: string;
  description: string;
}

// Registrations in the deployed Edge MCP may name a tool either with a string literal or with a
// shared exported constant (so the runner and its published contract cannot drift apart). Both
// forms are resolved here, which is what makes "the tool really is in the published roster" a
// checkable property rather than a grep for one particular spelling.
const exported = httpRunner as unknown as Record<string, unknown>;
const registration =
  /registerTool\(\s*(?:'((?:[^'\\]|\\.)*)'|([A-Za-z_$][\w$]*))\s*,\s*\{\s*description\s*:\s*(?:'((?:[^'\\]|\\.)*)'|([A-Za-z_$][\w$]*))/g;

function resolve(literal?: string, identifier?: string) {
  if (literal !== undefined) return literal.replace(/\\'/g, "'");
  const value = identifier ? exported[identifier] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** Every tool the remote HTTP MCP endpoint publishes to an external client such as ChatGPT. */
export async function publishedMcpTools(
  path = "supabase/functions/mcp/index.ts",
): Promise<PublishedTool[]> {
  const source = await readFile(path, "utf8");
  const tools: PublishedTool[] = [];
  for (const match of source.matchAll(registration)) {
    const name = resolve(match[1], match[2]);
    const description = resolve(match[3], match[4]);
    if (name && description) tools.push({ name, description });
  }
  return tools;
}

/** Mirrors how a connector surfaces tools for a free-text capability search. */
export function searchTools(tools: PublishedTool[], query: string) {
  const needle = query.toLowerCase();
  return tools.filter(
    (tool) =>
      tool.name.toLowerCase().includes(needle) ||
      tool.description.toLowerCase().includes(needle),
  );
}
