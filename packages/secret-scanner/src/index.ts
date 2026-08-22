const KNOWN_SECRET_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{36,}/, // GitHub personal/OAuth/user/server/refresh tokens
  /github_pat_[A-Za-z0-9_]{22,}/, // GitHub fine-grained PAT
  /sbp_[a-f0-9]{40}/, // Supabase access/service token
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, // PEM private key material
  /postgres(?:ql)?:\/\/[^:\s'"]+:[^@\s'"]+@/, // connection string with embedded credentials
];

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
  for (const match of content.matchAll(HARDCODED_ASSIGNMENT)) {
    const value = (match[3] ?? "").trim();
    if (value.length < 12) continue;
    if (PLACEHOLDER_VALUE.test(value)) continue;
    return true;
  }
  return false;
}
