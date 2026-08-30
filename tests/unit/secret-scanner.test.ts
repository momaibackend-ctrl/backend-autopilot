import { describe, expect, it } from "vitest";
import { detectHardcodedSecret } from "../../packages/secret-scanner/src/index.js";

describe("secret scanner", () => {
  it("does not block on secret-sounding identifier names alone", () => {
    expect(detectHardcodedSecret("src/auth.ts", "const githubToken = loadToken();")).toBe(false);
    expect(detectHardcodedSecret("src/config.ts", "export interface Config { password: string; apiKey: string; }")).toBe(false);
  });
  it("does not block environment/secret-store references", () => {
    expect(detectHardcodedSecret("src/github.ts", "const token = process.env.GITHUB_TOKEN;")).toBe(false);
    expect(detectHardcodedSecret("src/db.ts", "const password = Deno.env.get('DB_PASSWORD');")).toBe(false);
    expect(detectHardcodedSecret("src/vault.ts", "const secret = getSecretFromStore('DB_PASSWORD');")).toBe(false);
    expect(detectHardcodedSecret("src/vault.ts", "credential = secretsManager.get('api-credential');")).toBe(false);
  });
  it("does not block .env.example/.sample/.template templates", () => {
    expect(detectHardcodedSecret(".env.example", "GITHUB_TOKEN=your-token-here\n")).toBe(false);
    expect(detectHardcodedSecret("config/.env.sample", "PASSWORD=changeme\n")).toBe(false);
  });
  it("does not block placeholder literal values", () => {
    expect(detectHardcodedSecret("docs/setup.md", "token: 'your-token-here'")).toBe(false);
    expect(detectHardcodedSecret("docs/setup.md", "password = 'changeme'")).toBe(false);
    expect(detectHardcodedSecret("docs/setup.md", "credential: '<INSERT_VALUE>'")).toBe(false);
  });
  it("does not block a path merely containing the word 'secret'", () => {
    expect(detectHardcodedSecret("packages/secret-scanner/src/index.ts", "export function detectHardcodedSecret() {}")).toBe(false);
    expect(detectHardcodedSecret("docs/secrets-policy.md", "Rotate secrets every 90 days.")).toBe(false);
  });

  it("blocks a real .env file regardless of content", () => {
    expect(detectHardcodedSecret(".env", "GITHUB_TOKEN=whatever\n")).toBe(true);
    expect(detectHardcodedSecret("apps/api/.env.production", "x=1\n")).toBe(true);
  });
  it("blocks known raw secret token shapes", () => {
    // Built by concatenation rather than as source-literal tokens, so this test file itself never
    // contains a contiguous string shaped like a real credential (GitHub push protection correctly
    // flags a literal one, which is exactly the scanner behavior this test is verifying).
    const ghpShaped = "ghp_" + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8".repeat(1);
    const sbpShaped = "sbp_" + "0123456789abcdef".repeat(2) + "01234567";
    const awsShaped = "AKIA" + "ABCDEFGHIJKLMNOP";
    expect(detectHardcodedSecret("src/x.ts", `const t = '${ghpShaped}';`)).toBe(true);
    expect(detectHardcodedSecret("src/x.ts", `const t = '${sbpShaped}';`)).toBe(true);
    expect(detectHardcodedSecret("src/x.ts", `AWS_KEY=${awsShaped}`)).toBe(true);
    expect(detectHardcodedSecret("src/x.ts", ["-----BEGIN RSA PRIVATE KEY-----", "MIIBOgIBAAJBAK...", "-----END RSA PRIVATE KEY-----"].join("\n"))).toBe(true);
  });
  it("blocks a hardcoded quoted secret literal", () => {
    expect(detectHardcodedSecret("src/x.ts", "const password = \"s3cr3t-real-value-1\";")).toBe(true);
    expect(detectHardcodedSecret("src/x.ts", "credential: 'a-genuinely-long-hardcoded-value'")).toBe(true);
  });
  it("allows a connection string that documents the shape rather than leaking a target", () => {
    // The rule this relaxes made one class of code impossible to write. Every fixture in a DSN
    // parser is credential-shaped by construction, and so is every comment explaining what a
    // malformed DSN looks like -- the scanner rejected the fix for a real connection-string defect
    // on the strength of the sentence describing that defect.
    for (const safe of [
      "libpq writes credentials as userinfo -- `postgresql://user:password@host/db` -- which JDBC cannot read",
      "adapter.normalizePostgresUrl('postgresql://autopilot:secret@127.0.0.1:5432/autopilot_epic')",
      "postgres://svc:p%40ss@db.example:5432/app",
      "redis://user:pass@localhost:6379",
      "postgresql://user:pa@ss@host:5432/db",
    ]) {
      expect(detectHardcodedSecret("src/x.ts", safe), safe).toBe(false);
    }
  });

  it("still blocks a connection string that points at a routable host", () => {
    for (const leak of [
      "const url = 'postgres://user:hunterhunterhunter@db.example.com:5432/app';",
      "DATABASE_URL=postgresql://postgres.abcdefgh:Kd83Jf9Xm2@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
      "mongodb+srv://root:s3cr3tvalue@cluster0.mongodb.net/prod",
    ]) {
      expect(detectHardcodedSecret("src/x.ts", leak), leak).toBe(true);
    }
  });

  it("does not treat a username-only url as secret material", () => {
    expect(detectHardcodedSecret("src/x.ts", "postgres://reader@db.production.internal:5432/app")).toBe(false);
  });

  it("blocks a connection string with embedded credentials", () => {
    expect(detectHardcodedSecret("src/x.ts", "const url = 'postgres://user:hunterhunterhunter@db.example.com:5432/app';")).toBe(true);
  });
});
