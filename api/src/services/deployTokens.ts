// ── Per-site deploy tokens ────────────────────────────────────────────────────
// Bearer tokens that let automation (e.g. an app's CI) deploy ONE site through
// the HermitHost API without a dashboard session. Created and revoked from the
// dashboard (cookie auth only); the plaintext is returned once at creation and
// only a SHA-256 hash is persisted, in the coolify-api-token volume alongside
// the other API secrets.
//
// A token is valid only for the routes in isDeployTokenRouteAllowed(), and only
// for its own site. Everything else — including token management and
// /api/auth/* — rejects it.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import * as path from 'path';

export const DEPLOY_TOKEN_PREFIX = 'hhdt_';
const TOKEN_RE = /^hhdt_[A-Za-z0-9_-]{43}$/;
const NAME_MAX = 64;
// Avoid rewriting the store on every request; lastUsedAt is advisory.
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export interface DeployTokenRecord {
  id: string;
  slug: string;
  name: string;
  hash: string; // sha256 hex of the full token
  createdAt: string;
  lastUsedAt: string | null;
}

export type DeployTokenMeta = Omit<DeployTokenRecord, 'hash'>;

function storeFile(): string {
  return process.env.DEPLOY_TOKENS_FILE ?? '/coolify-api-token/site_deploy_tokens.json';
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toMeta({ hash: _hash, ...meta }: DeployTokenRecord): DeployTokenMeta {
  return meta;
}

function readStore(): DeployTokenRecord[] {
  let raw: string;
  try {
    raw = readFileSync(storeFile(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed = JSON.parse(raw) as { tokens?: DeployTokenRecord[] };
  return Array.isArray(parsed.tokens) ? parsed.tokens : [];
}

function writeStore(tokens: DeployTokenRecord[]): void {
  const file = storeFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ tokens }, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

export function normalizeTokenName(name: unknown): string | null {
  if (name === undefined || name === null || name === '') return 'deploy';
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > NAME_MAX || !/^[\w .:@-]+$/.test(trimmed)) return null;
  return trimmed;
}

export function createDeployToken(slug: string, name: string): { token: string; meta: DeployTokenMeta } {
  const token = DEPLOY_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const record: DeployTokenRecord = {
    id: randomUUID(),
    slug,
    name,
    hash: hashToken(token),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  writeStore([...readStore(), record]);
  return { token, meta: toMeta(record) };
}

export function listDeployTokens(slug: string): DeployTokenMeta[] {
  return readStore().filter((t) => t.slug === slug).map(toMeta);
}

export function revokeDeployToken(slug: string, id: string): boolean {
  const tokens = readStore();
  const kept = tokens.filter((t) => !(t.slug === slug && t.id === id));
  if (kept.length === tokens.length) return false;
  writeStore(kept);
  return true;
}

export function revokeAllDeployTokens(slug: string): number {
  const tokens = readStore();
  const kept = tokens.filter((t) => t.slug !== slug);
  if (kept.length !== tokens.length) writeStore(kept);
  return tokens.length - kept.length;
}

// Returns the token's record if it is a live token, else null. Never throws.
export function verifyDeployToken(token: string): DeployTokenMeta | null {
  if (!TOKEN_RE.test(token)) return null;
  let tokens: DeployTokenRecord[];
  try {
    tokens = readStore();
  } catch (err) {
    console.error('[deploy-tokens] could not read token store:', (err as Error).message);
    return null;
  }
  const candidate = Buffer.from(hashToken(token), 'hex');
  const match = tokens.find((t) => {
    if (typeof t.hash !== 'string') return false;
    const stored = Buffer.from(t.hash, 'hex');
    return stored.length === candidate.length && timingSafeEqual(stored, candidate);
  });
  if (!match) return null;

  const now = Date.now();
  const last = match.lastUsedAt ? Date.parse(match.lastUsedAt) : 0;
  if (now - last > LAST_USED_WRITE_INTERVAL_MS) {
    try {
      match.lastUsedAt = new Date(now).toISOString();
      writeStore(tokens);
    } catch (err) {
      console.warn('[deploy-tokens] could not record lastUsedAt:', (err as Error).message);
    }
  }
  return toMeta(match);
}

// The only routes a deploy token may call, relative to the /api mount
// (req.path). Matching is exact and case-sensitive on purpose: anything
// unusual (encoded slashes, different casing, extra segments) fails closed.
export function isDeployTokenRouteAllowed(method: string, routePath: string, slug: string): boolean {
  const base = `/sites/${slug}`;
  const p = routePath.endsWith('/') && routePath.length > 1 ? routePath.slice(0, -1) : routePath;
  if (method === 'POST') return p === `${base}/deploy`;
  if (method === 'GET') {
    if (p === base || p === `${base}/deployments`) return true;
    const prefix = `${base}/deployments/`;
    if (p.startsWith(prefix) && p.endsWith('/log')) {
      return /^[A-Za-z0-9_-]+$/.test(p.slice(prefix.length, -'/log'.length));
    }
  }
  return false;
}
