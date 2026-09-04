import { ExecutionFailed, PolicyViolation } from '../../../core/src/errors.js';
import type { ArtifactBlobStore } from '../../../core/src/ports.js';

// Cloudflare R2's S3-compatible endpoint is signed with AWS SigV4. Both Node 22 and the Supabase
// Deno Edge Runtime expose `fetch` and Web Crypto (`crypto.subtle`), so the signer below is built
// on those primitives only -- no aws-sdk dependency, and no code fork between the two runtimes.
const REGION = 'auto';
const SERVICE = 's3';

const UUID_SOURCE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`);
// The object path contract mirrors SupabaseStorageArtifactBlobStore's <projectId>/<artifactId>.json
// scheme exactly, with both segments constrained to the schema's own UUID shape. Because the
// pattern permits nothing but hex digits, hyphens and one literal ".json" suffix, it rejects
// path traversal ("..", leading "/", backslashes) and arbitrary-bucket access by construction --
// there is no separate blocklist to keep in sync with the allowlist.
const OBJECT_PATH_PATTERN = new RegExp(`^${UUID_SOURCE}/${UUID_SOURCE}\\.json$`);

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export interface R2Config {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const R2_ENV_NAMES = ['AUTOPILOT_R2_ACCOUNT_ID', 'AUTOPILOT_R2_BUCKET_NAME', 'AUTOPILOT_R2_ACCESS_KEY_ID', 'AUTOPILOT_R2_SECRET_ACCESS_KEY'] as const;

/**
 * Backward-compatible R2 wiring for both the Edge Runtime (`Deno.env.get`) and the GitHub Actions
 * runner (`process.env`): all four `AUTOPILOT_R2_*` variables present selects R2, none present
 * preserves today's Supabase Storage behavior untouched. A partial set is neither -- it is almost
 * certainly a misconfiguration, so it fails closed with only the *names* of the missing variables
 * (never a value) rather than silently falling back to Supabase Storage.
 */
export function readR2ConfigFromEnv(get: (name: string) => string | undefined): R2Config | undefined {
  const entries = R2_ENV_NAMES.map(name => ({ name, value: get(name) }));
  const present = entries.filter(entry => Boolean(entry.value));
  if (present.length === 0) return undefined;
  if (present.length < R2_ENV_NAMES.length) throw new PolicyViolation('Cloudflare R2 artifact storage is partially configured', { missing: entries.filter(entry => !entry.value).map(entry => entry.name) });
  const [accountId, bucketName, accessKeyId, secretAccessKey] = entries.map(entry => entry.value as string) as [string, string, string, string];
  return { accountId, bucketName, accessKeyId, secretAccessKey };
}

export class R2ArtifactBlobStore implements ArtifactBlobStore {
  constructor(private readonly accountId: string, private readonly bucket: string, private readonly accessKeyId: string, private readonly secretAccessKey: string) {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new PolicyViolation('Invalid Cloudflare R2 account id');
    if (!BUCKET_NAME_PATTERN.test(bucket)) throw new PolicyViolation('Invalid Cloudflare R2 bucket name');
    if (!accessKeyId) throw new PolicyViolation('Cloudflare R2 access key id is required');
    if (!secretAccessKey) throw new PolicyViolation('Cloudflare R2 secret access key is required');
  }

  async put(input: { projectId: string; artifactId: string; body: string; contentType: string }) {
    const path = objectPath(input.projectId, input.artifactId);
    const response = await this.signedFetch('PUT', path, input.body, input.contentType);
    if (!response.ok) throw new ExecutionFailed('R2 artifact upload failed', { status: response.status, body: (await response.text()).slice(0, 300) });
    return { provider: 'r2', bucket: this.bucket, path, contentType: input.contentType, size: new TextEncoder().encode(input.body).byteLength };
  }

  async get(reference: { provider: string; bucket: string; path: string; contentType: string; size: number }) {
    if (reference.provider !== 'r2' || reference.bucket !== this.bucket || !OBJECT_PATH_PATTERN.test(reference.path)) throw new PolicyViolation('Artifact storage reference is not authorized');
    const response = await this.signedFetch('GET', reference.path);
    if (!response.ok) throw new ExecutionFailed('R2 artifact download failed', { status: response.status });
    return response.text();
  }

  private async signedFetch(method: 'PUT' | 'GET', path: string, body?: string, contentType?: string): Promise<Response> {
    const host = `${this.accountId}.r2.cloudflarestorage.com`;
    const canonicalPath = `/${this.bucket}/${path}`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = await sha256Hex(body ?? '');
    const signedContentType = method === 'PUT' ? contentType : undefined;
    const authorization = await buildAuthorizationHeader({ method, canonicalPath, payloadHash, amzDate, dateStamp, host, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey, contentType: signedContentType });
    // The Host header is intentionally not set explicitly: it is one of the headers user agents
    // (and several server-side fetch implementations) forbid scripts from overriding, and it is
    // always identical to the request URL's own host anyway -- which is the value signed above.
    const headers: Record<string, string> = { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, authorization };
    if (signedContentType) headers['content-type'] = signedContentType;
    return fetch(`https://${host}${canonicalPath}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  }
}

function objectPath(projectId: string, artifactId: string): string {
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(artifactId)) throw new PolicyViolation('Invalid artifact storage identifiers');
  return `${projectId}/${artifactId}.json`;
}

async function buildAuthorizationHeader(input: { method: string; canonicalPath: string; payloadHash: string; amzDate: string; dateStamp: string; host: string; accessKeyId: string; secretAccessKey: string; contentType?: string | undefined }): Promise<string> {
  const headerLines = input.contentType ? [['content-type', input.contentType], ['host', input.host], ['x-amz-content-sha256', input.payloadHash], ['x-amz-date', input.amzDate]] : [['host', input.host], ['x-amz-content-sha256', input.payloadHash], ['x-amz-date', input.amzDate]];
  const canonicalHeaders = headerLines.map(([name, value]) => `${name}:${value}\n`).join('');
  const signedHeaders = headerLines.map(([name]) => name).join(';');
  const canonicalRequest = [input.method, input.canonicalPath, '', canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  const credentialScope = `${input.dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');
  const signingKey = await deriveSigningKey(input.secretAccessKey, input.dateStamp);
  const signature = toHex(await hmacSha256(signingKey, stringToSign));
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function deriveSigningKey(secretAccessKey: string, dateStamp: string): Promise<Uint8Array> {
  const kDate = await hmacSha256(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, REGION);
  const kService = await hmacSha256(kRegion, SERVICE);
  return hmacSha256(kService, 'aws4_request');
}

async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data)));
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
}
