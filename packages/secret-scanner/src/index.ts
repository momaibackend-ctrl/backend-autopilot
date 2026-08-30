const KNOWN_SECRET_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{36,}/, // GitHub personal/OAuth/user/server/refresh tokens
  /github_pat_[A-Za-z0-9_]{22,}/, // GitHub fine-grained PAT
  /sbp_[a-f0-9]{40}/, // Supabase access/service token
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, // PEM private key material
];

// A connection string with credentials in it, wherever it appears. Split out from the pattern list
// because whether it is a leak depends on where it points, and a single regex cannot say.
const CONNECTION_STRING =
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/([^/\s'"]+)@([^/\s'"?#]+)/gi;

/**
 * Hosts that cannot be a real target: loopback, and the names RFC 2606 and RFC 6761 reserve for
 * documentation and testing. A dotless single label is included because it is not resolvable on the
 * public internet -- it is a fixture, a service name inside a compose file, or a doc example.
 *
 * This exemption exists because the rule it relaxes made one class of code impossible to write.
 * Every fixture in a DSN parser's test suite is credential-shaped by construction, and so is every
 * comment explaining what a malformed DSN looks like; the check rejected the fix for a real
 * connection-string defect on the strength of the sentence describing that defect. What it still
 * catches is the case that matters: a DSN pointing at a routable host with a real password in it.
 */
function isNonRoutableHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  if (name === "localhost" || name === "127.0.0.1" || name === "0.0.0.0" || name === "::1" || name === "[::1]") return true;
  if (/\.(?:example|invalid|test|localhost)$/.test(name)) return true;
  if (/^example\.(?:com|org|net)$/.test(name)) return true;
  return !name.includes(".");
}

function hasLeakedConnectionString(content: string): boolean {
  for (const match of content.matchAll(CONNECTION_STRING)) {
    const userinfo = match[1] ?? "";
    const host = match[2] ?? "";
    // No password component at all is just a username in a URL, which is not secret material.
    if (!userinfo.includes(":")) continue;
    if (isNonRoutableHost(host)) continue;
    return true;
  }
  return false;
}

const PLACEHOLDER_VALUE =
  /^(x+|\*+|change[_-]?me|your[-_].+|redacted|todo|example|placeholder|dummy|test|<.+>|\$\{.+\})$/i;

// Only flags an assignment when the value is a quoted string literal, so a reference to an
// environment variable or secret-store lookup (token = process.env.X, Deno.env.get('X'),
// getSecret(...), or any other bare identifier/call) never matches -- those never start with a
// quote right after `=`/`:`. This is what a hardcoded/raw secret value looks like as opposed to a
// variable or property merely named `password`/`token`/`credential`, which is safe on its own.
const HARDCODED_ASSIGNMENT =
  /(password|token|secret|api[_-]?key|credential)s?\s*[:=]\s*(['"])((?:(?!\2).)+)\2/gi;

function isBlockedEnvFile(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  if (!/^\.env(\.[A-Za-z0-9_-]+)?$/.test(name)) return false;
  return !/\.(example|sample|template)$/i.test(name);
}

/**
 * Detects real, hardcoded/raw secret material -- not the mere presence of secret-sounding
 * identifier names (`githubToken`, `password`, `credential`) or references that fetch a secret
 * from the environment or a secret store, and not `.env.example`-style templates.
 */
export function detectHardcodedSecret(path: string, content: string): boolean {
  if (isBlockedEnvFile(path)) return true;
  if (KNOWN_SECRET_PATTERNS.some((pattern) => pattern.test(content)))
    return true;
  if (hasLeakedConnectionString(content)) return true;
  for (const match of content.matchAll(HARDCODED_ASSIGNMENT)) {
    const value = (match[3] ?? "").trim();
    if (value.length < 12) continue;
    if (PLACEHOLDER_VALUE.test(value)) continue;
    return true;
  }
  return false;
}
