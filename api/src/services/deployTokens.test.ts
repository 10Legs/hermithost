import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  createDeployToken,
  isDeployTokenRouteAllowed,
  listDeployTokens,
  normalizeTokenName,
  revokeAllDeployTokens,
  revokeDeployToken,
  verifyDeployToken,
} from './deployTokens';

const SLUG = 'c1ngfacciakfgbxmt96uaeoz';
const OTHER = 'lv44itdkau12rdgxomfi28j9';

beforeEach(() => {
  process.env.DEPLOY_TOKENS_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'deploy-tokens-')), 'tokens.json');
});

describe('deploy token store', () => {
  it('returns the plaintext once and persists only a hash', () => {
    const { token, meta } = createDeployToken(SLUG, 'ci');
    expect(token).toMatch(/^hhdt_[A-Za-z0-9_-]{43}$/);
    expect(meta).toMatchObject({ slug: SLUG, name: 'ci', lastUsedAt: null });
    expect(meta).not.toHaveProperty('hash');

    const file = process.env.DEPLOY_TOKENS_FILE!;
    expect(readFileSync(file, 'utf8')).not.toContain(token);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('verifies a live token and records lastUsedAt', () => {
    const { token } = createDeployToken(SLUG, 'ci');
    const meta = verifyDeployToken(token);
    expect(meta?.slug).toBe(SLUG);
    expect(listDeployTokens(SLUG)[0].lastUsedAt).not.toBeNull();
  });

  it('rejects unknown, malformed and revoked tokens', () => {
    const { token, meta } = createDeployToken(SLUG, 'ci');
    expect(verifyDeployToken(`hhdt_${'A'.repeat(43)}`)).toBeNull();
    expect(verifyDeployToken('not-a-token')).toBeNull();
    expect(verifyDeployToken('')).toBeNull();
    expect(revokeDeployToken(SLUG, meta.id)).toBe(true);
    expect(verifyDeployToken(token)).toBeNull();
  });

  it('scopes listing and revocation to the site', () => {
    const a = createDeployToken(SLUG, 'a');
    createDeployToken(OTHER, 'b');
    expect(listDeployTokens(SLUG).map((t) => t.name)).toEqual(['a']);
    expect(revokeDeployToken(OTHER, a.meta.id)).toBe(false);
    expect(verifyDeployToken(a.token)).not.toBeNull();
  });

  it('revokes every token of a deleted site', () => {
    const a = createDeployToken(SLUG, 'a');
    createDeployToken(SLUG, 'b');
    const other = createDeployToken(OTHER, 'c');
    expect(revokeAllDeployTokens(SLUG)).toBe(2);
    expect(verifyDeployToken(a.token)).toBeNull();
    expect(verifyDeployToken(other.token)).not.toBeNull();
  });

  it('returns null (fails closed) when the store is unreadable', () => {
    const { token } = createDeployToken(SLUG, 'ci');
    process.env.DEPLOY_TOKENS_FILE = tmpdir(); // a directory: read fails with EISDIR
    expect(verifyDeployToken(token)).toBeNull();
  });
});

describe('normalizeTokenName', () => {
  it('defaults, trims and validates', () => {
    expect(normalizeTokenName(undefined)).toBe('deploy');
    expect(normalizeTokenName('  hayloft ci  ')).toBe('hayloft ci');
    expect(normalizeTokenName('a'.repeat(65))).toBeNull();
    expect(normalizeTokenName('<script>')).toBeNull();
    expect(normalizeTokenName(42)).toBeNull();
  });
});

describe('isDeployTokenRouteAllowed', () => {
  it.each([
    ['POST', `/sites/${SLUG}/deploy`],
    ['GET', `/sites/${SLUG}`],
    ['GET', `/sites/${SLUG}/`],
    ['GET', `/sites/${SLUG}/deployments`],
    ['GET', `/sites/${SLUG}/deployments/abc123-XYZ_9/log`],
  ])('allows %s %s', (method, p) => {
    expect(isDeployTokenRouteAllowed(method, p, SLUG)).toBe(true);
  });

  it.each([
    ['POST', `/sites/${OTHER}/deploy`],          // another site
    ['GET', `/sites/${OTHER}`],
    ['GET', '/sites'],                            // site list
    ['PATCH', `/sites/${SLUG}`],                  // settings
    ['DELETE', `/sites/${SLUG}`],
    ['GET', `/sites/${SLUG}/deploy-tokens`],      // token management
    ['POST', `/sites/${SLUG}/deploy-tokens`],
    ['GET', `/sites/${SLUG}/envs`],               // secrets
    ['GET', `/sites/${SLUG}/env`],
    ['POST', `/sites/${SLUG}/disable`],
    ['GET', `/sites/${SLUG}/deploy`],             // wrong method
    ['POST', `/sites/${SLUG}/DEPLOY`],            // case variant
    ['POST', `/sites/${SLUG}/deploy/extra`],
    ['GET', `/sites/${SLUG}/deployments/a%2F..%2Fx/log`],
    ['GET', `/sites/${SLUG}/deployments//log`],
    ['GET', '/config/deploy-key'],
    ['POST', '/auth/login'],
    ['GET', '/services'],
  ])('rejects %s %s', (method, p) => {
    expect(isDeployTokenRouteAllowed(method, p, SLUG)).toBe(false);
  });
});
