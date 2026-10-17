import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { NextFunction, Request, Response } from 'express';
import { requireAuth, signTimestamp } from './auth';
import { createDeployToken } from '../services/deployTokens';

const SLUG = 'c1ngfacciakfgbxmt96uaeoz';
const OTHER = 'lv44itdkau12rdgxomfi28j9';

function call(opts: { method?: string; path: string; cookie?: string; authorization?: string }) {
  const req = {
    method: opts.method ?? 'GET',
    path: opts.path,
    headers: { cookie: opts.cookie, authorization: opts.authorization },
  } as unknown as Request;
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    locals: {} as Record<string, unknown>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  const next = vi.fn() as unknown as NextFunction;
  requireAuth(req, res as unknown as Response, next);
  return { res, next: next as unknown as ReturnType<typeof vi.fn> };
}

function sessionCookie(): string {
  const ts = String(Date.now());
  return `hermithost_session=${ts}:${signTimestamp(ts, 'test-secret')}`;
}

beforeEach(() => {
  process.env.COOKIE_SECRET = 'test-secret';
  process.env.DEPLOY_TOKENS_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'auth-mw-')), 'tokens.json');
});

describe('requireAuth', () => {
  it('accepts a valid session cookie on any route', () => {
    const { next } = call({ method: 'PATCH', path: `/sites/${SLUG}`, cookie: sessionCookie() });
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects a request with no credentials', () => {
    const { res, next } = call({ path: '/sites' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('lets a deploy token deploy its own site', () => {
    const { token, meta } = createDeployToken(SLUG, 'ci');
    const { res, next } = call({ method: 'POST', path: `/sites/${SLUG}/deploy`, authorization: `Bearer ${token}` });
    expect(next).toHaveBeenCalledOnce();
    expect((res.locals.deployToken as { id: string }).id).toBe(meta.id);
  });

  it('forbids a deploy token on another site and on non-allow-listed routes', () => {
    const { token } = createDeployToken(SLUG, 'ci');
    for (const [method, p] of [
      ['POST', `/sites/${OTHER}/deploy`],
      ['PATCH', `/sites/${SLUG}`],
      ['POST', `/sites/${SLUG}/deploy-tokens`],
      ['GET', '/sites'],
    ]) {
      const { res, next } = call({ method, path: p, authorization: `Bearer ${token}` });
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    }
  });

  it('rejects an unknown bearer token with 401', () => {
    const { res, next } = call({ method: 'POST', path: `/sites/${SLUG}/deploy`, authorization: `Bearer hhdt_${'x'.repeat(43)}` });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('falls back to the token when the cookie is invalid', () => {
    const { token } = createDeployToken(SLUG, 'ci');
    const { next } = call({
      method: 'GET',
      path: `/sites/${SLUG}/deployments`,
      cookie: 'hermithost_session=1:bad',
      authorization: `Bearer ${token}`,
    });
    expect(next).toHaveBeenCalledOnce();
  });
});
