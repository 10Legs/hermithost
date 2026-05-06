import { Router, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { signTimestamp, verifySessionCookie } from '../middleware/auth';

const router = Router();
const COOKIE_NAME = 'hermithost_session';
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

function buildCookieHeader(value: string, req: Request, clear = false): string {
  const isSecure =
    req.secure ||
    (req.headers['x-forwarded-proto'] ?? '').includes('https');

  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${clear ? 0 : MAX_AGE_SECONDS}`,
    'Path=/',
  ];

  if (isSecure) parts.push('Secure');

  return parts.join('; ');
}

// POST /api/auth/login
router.post('/login', (req: Request, res: Response): void => {
  const password: string | undefined = req.body?.password;

  if (typeof password !== 'string' || password.length === 0) {
    res.status(400).json({ error: 'password is required' });
    return;
  }

  const secret = process.env.COOKIE_SECRET;
  const expected = process.env.HERMITHOST_PASSWORD;

  if (!secret || !expected) {
    console.error('[auth] COOKIE_SECRET or HERMITHOST_PASSWORD env var is not set');
    res.status(500).json({ error: 'Server misconfiguration' });
    return;
  }

  // Pad both buffers to the same length to safely use timingSafeEqual
  const provided = Buffer.from(password);
  const target = Buffer.from(expected);
  const maxLen = Math.max(provided.length, target.length);
  const a = Buffer.alloc(maxLen);
  const b = Buffer.alloc(maxLen);
  provided.copy(a);
  target.copy(b);

  const match = timingSafeEqual(a, b);

  if (!match) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  const timestamp = String(Date.now());
  const signature = signTimestamp(timestamp, secret);
  const cookieValue = `${timestamp}:${signature}`;

  res.setHeader('Set-Cookie', buildCookieHeader(cookieValue, req));
  res.status(200).json({ ok: true });
});

// POST /api/auth/logout
router.post('/logout', (req: Request, res: Response): void => {
  res.setHeader('Set-Cookie', buildCookieHeader('', req, true));
  res.status(200).json({ ok: true });
});

// GET /api/auth/check — no requireAuth middleware; inspect cookie directly
router.get('/check', (req: Request, res: Response): void => {
  const secret = process.env.COOKIE_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'Server misconfiguration' });
    return;
  }

  const cookieHeader = req.headers.cookie ?? '';
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 1) continue;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  }

  const sessionValue = cookies[COOKIE_NAME];
  if (!sessionValue || !verifySessionCookie(sessionValue, secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  res.status(200).json({ ok: true });
});

export default router;
