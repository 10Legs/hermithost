// Live HTTP, SSL, and DNS health probes for a given domain.
// All probes use Node built-ins only — no npm packages required.

import * as tls from 'node:tls';
import * as dns from 'node:dns';
import { performance } from 'node:perf_hooks';

import type { HttpStatus, SslStatus, DnsStatus } from '../types';

// ── HTTP probe ────────────────────────────────────────────────────────────────

async function probeHttp(domain: string): Promise<HttpStatus> {
  const checkedAt = new Date().toISOString();
  const start = performance.now();
  try {
    const res = await fetch(`https://${domain}`, {
      signal: AbortSignal.timeout(5000),
      redirect: 'follow',
    });
    const responseTimeMs = Math.round(performance.now() - start);
    return {
      reachable: true,
      statusCode: res.status,
      responseTimeMs,
      checkedAt,
    };
  } catch {
    return {
      reachable: false,
      statusCode: null,
      responseTimeMs: null,
      checkedAt,
    };
  }
}

// ── SSL probe ─────────────────────────────────────────────────────────────────

function probeSsl(domain: string): Promise<SslStatus> {
  const checkedAt = new Date().toISOString();
  return new Promise((resolve) => {
    let settled = false;

    const fail = (): void => {
      if (settled) return;
      settled = true;
      resolve({ valid: false, expiresAt: null, daysUntilExpiry: null, issuer: null, checkedAt });
    };

    const socket = tls.connect(
      { host: domain, port: 443, servername: domain },
      () => {
        if (settled) return;
        settled = true;
        try {
          const cert = socket.getPeerCertificate();
          const authorized = socket.authorized === true;
          const expires = new Date(cert.valid_to);
          const now = Date.now();
          const daysUntilExpiry = Math.floor((expires.getTime() - now) / 86_400_000);
          const expiresAt = expires.toISOString();
          const issuer: string | null =
            cert.issuer && typeof (cert.issuer as Record<string, unknown>).O === 'string'
              ? (cert.issuer as Record<string, string>).O
              : null;
          resolve({
            valid: authorized && daysUntilExpiry > 0,
            expiresAt,
            daysUntilExpiry,
            issuer,
            checkedAt,
          });
        } catch {
          resolve({ valid: false, expiresAt: null, daysUntilExpiry: null, issuer: null, checkedAt });
        } finally {
          socket.destroy();
        }
      }
    );

    socket.setTimeout(5000, () => {
      socket.destroy();
      fail();
    });

    socket.on('error', () => {
      socket.destroy();
      fail();
    });
  });
}

// ── DNS probe ─────────────────────────────────────────────────────────────────

async function probeDns(domain: string): Promise<DnsStatus> {
  const checkedAt = new Date().toISOString();
  try {
    await dns.promises.resolve4(domain);
    return { resolving: true, propagated: true, checkedAt };
  } catch {
    return { resolving: false, propagated: false, checkedAt };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ProbeResult {
  http: HttpStatus;
  ssl: SslStatus;
  dns: DnsStatus;
}

// ── Probe result cache (60s TTL) ──────────────────────────────────────────────

interface CacheEntry {
  result: ProbeResult;
  expiresAt: number;
}

const PROBE_CACHE_TTL_MS = 60_000;
const probeCache = new Map<string, CacheEntry>();

function getCached(domain: string): ProbeResult | null {
  const entry = probeCache.get(domain);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    probeCache.delete(domain);
    return null;
  }
  return entry.result;
}

function setCached(domain: string, result: ProbeResult): void {
  probeCache.set(domain, { result, expiresAt: Date.now() + PROBE_CACHE_TTL_MS });
}

export function clearProbeCache(domain: string): void {
  probeCache.delete(domain);
}

export async function probeSite(domain: string): Promise<ProbeResult> {
  const cached = getCached(domain);
  if (cached) return cached;

  const [httpResult, sslResult, dnsResult] = await Promise.allSettled([
    probeHttp(domain),
    probeSsl(domain),
    probeDns(domain),
  ]);

  const now = new Date().toISOString();

  const http: HttpStatus =
    httpResult.status === 'fulfilled'
      ? httpResult.value
      : { reachable: false, statusCode: null, responseTimeMs: null, checkedAt: now };

  const ssl: SslStatus =
    sslResult.status === 'fulfilled'
      ? sslResult.value
      : { valid: false, expiresAt: null, daysUntilExpiry: null, issuer: null, checkedAt: now };

  const dns: DnsStatus =
    dnsResult.status === 'fulfilled'
      ? dnsResult.value
      : { resolving: false, propagated: false, checkedAt: now };

  const result: ProbeResult = { http, ssl, dns };
  setCached(domain, result);
  return result;
}
