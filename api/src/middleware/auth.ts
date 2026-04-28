import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

const COOKIE_NAME = 'hermithost_session';

export function signTimestamp(timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(timestamp).digest('hex');
}

export function verifySessionCookie(cookieValue: string, secret: string): boolean {
  const parts = cookieValue.split(':');
  if (parts.length !== 2) return false;

  const [timestamp, signature] = parts;

  // Reject cookies older than 7 days
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;
  const age = Date.now() - ts;
  if (age < 0 || age > 7 * 24 * 60 * 60 * 1000) return false;

  const expected = signTimestamp(timestamp, secret);

  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.COOKIE_SECRET;
  if (!secret) {
    console.error('[auth] COOKIE_SECRET env var is not set');
    res.status(500).json({ error: 'Server misconfiguration' });
    return;
  }

  const cookieHeader = req.headers.cookie ?? '';
  const cookies = parseCookies(cookieHeader);
  const sessionValue = cookies[COOKIE_NAME];

  if (!sessionValue || !verifySessionCookie(sessionValue, secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    result[key] = decodeURIComponent(val);
  }
  return result;
}
