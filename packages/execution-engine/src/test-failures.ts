import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Which tests failed, by name, with the first line of why.
//
// A Gradle run reports "473 tests completed, 1 failed" and an exit code; the name of the failing
// test sat somewhere in megabytes of DEBUG output (4 MB on a real Kotlin run). An agent repairing
// the task could not find it, sent variations of the same change three times, and stalled. The
// name and message are what a repair needs, so the test report now carries them.
//
// JUnit XML results are the source of truth when the build wrote them; the console transcript is
// the fallback. Content is untrusted project output: it is length-bounded and never interpreted.

export interface FailedTest {
  test: string;
  message?: string;
}

export const MAX_FAILED_TESTS = 50;
const MAX_MESSAGE = 500;

function decode(value: string) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
}

function firstLine(value: string | undefined) {
  const line = value?.split('\n').map((part) => part.trim()).find(Boolean);
  return line ? line.slice(0, MAX_MESSAGE) : undefined;
}

/** Failing test cases in one JUnit XML document. */
export function parseJUnitFailures(xml: string): FailedTest[] {
  const failures: FailedTest[] = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = match[2] ?? '';
    const failure = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (!failure) continue;
    const attributes = match[1] ?? '';
    const name = decode(/\bname="([^"]*)"/.exec(attributes)?.[1] ?? 'unnamed');
    const className = decode(/\bclassname="([^"]*)"/.exec(attributes)?.[1] ?? '');
    const message = /\bmessage="([^"]*)"/.exec(failure[2] ?? '')?.[1];
    const summary = firstLine(message === undefined ? decode(failure[3] ?? '') : decode(message));
    failures.push({ test: className ? `${className} > ${name}` : name, ...(summary ? { message: summary } : {}) });
  }
  return failures;
}

/** Failing tests named in a Gradle console transcript ("Class > test() FAILED"). */
export function parseGradleTranscriptFailures(transcript: string): FailedTest[] {
  const lines = transcript.split('\n');
  const failures: FailedTest[] = [];
  lines.forEach((line, index) => {
    const match = /^(\S.*\S) > (.+) FAILED\s*$/.exec(line);
    if (!match) return;
    // Gradle prints the exception on the following indented lines.
    const detail = lines.slice(index + 1, index + 4).map((value) => value.trim()).find(Boolean);
    failures.push({ test: `${match[1]} > ${match[2]}`, ...(detail ? { message: detail.slice(0, MAX_MESSAGE) } : {}) });
  });
  return failures;
}

export interface TestTotals {
  tests: number;
  failures: number;
  skipped: number;
}

/** Totals of one JUnit XML document, from its testsuite element. */
export function parseJUnitTotals(xml: string): TestTotals | undefined {
  const suite = /<testsuite\b([^>]*)>/.exec(xml)?.[1];
  if (!suite) return undefined;
  const count = (name: string) => Number(new RegExp(`\\b${name}="(\\d+)"`).exec(suite)?.[1] ?? 0);
  return { tests: count('tests'), failures: count('failures') + count('errors'), skipped: count('skipped') };
}

/** "N tests completed, M failed, K skipped" from a Gradle transcript, the fallback when no XML exists. */
export function parseGradleTranscriptTotals(transcript: string): TestTotals | undefined {
  const match = /(\d+) tests? completed(?:, (\d+) failed)?(?:, (\d+) skipped)?/.exec(transcript);
  return match ? { tests: Number(match[1]), failures: Number(match[2] ?? 0), skipped: Number(match[3] ?? 0) } : undefined;
}

/** How many tests a Gradle workspace ran: summed JUnit XML results, else the transcript line. */
export async function collectGradleTotals(workspace: string, transcript: string): Promise<TestTotals | undefined> {
  const root = join(workspace, 'build', 'test-results');
  let totals: TestTotals | undefined;
  for (const directory of await readdir(root).catch(() => [] as string[])) {
    for (const file of (await readdir(join(root, directory)).catch(() => [] as string[])).filter((name) => name.endsWith('.xml'))) {
      const value = parseJUnitTotals(await readFile(join(root, directory, file), 'utf8').catch(() => ''));
      if (value) totals = { tests: (totals?.tests ?? 0) + value.tests, failures: (totals?.failures ?? 0) + value.failures, skipped: (totals?.skipped ?? 0) + value.skipped };
    }
  }
  return totals ?? parseGradleTranscriptTotals(transcript);
}

/** Every failing test of a Gradle workspace: JUnit XML results first, then the transcript. */
export async function collectGradleFailures(workspace: string, transcript: string): Promise<FailedTest[]> {
  const found: FailedTest[] = [];
  const root = join(workspace, 'build', 'test-results');
  const directories = await readdir(root).catch(() => [] as string[]);
  for (const directory of directories) {
    const files = await readdir(join(root, directory)).catch(() => [] as string[]);
    for (const file of files.filter((name) => name.endsWith('.xml'))) found.push(...parseJUnitFailures(await readFile(join(root, directory, file), 'utf8').catch(() => '')));
  }
  const failures = found.length ? found : parseGradleTranscriptFailures(transcript);
  const unique = new Map(failures.map((value) => [value.test, value]));
  return [...unique.values()].slice(0, MAX_FAILED_TESTS);
}
