import * as http from 'http';

// Route all Docker API calls through the label-gated sidecar proxy.
// The proxy blocks operations on containers not managed by hermithost.
const PROXY_BASE = process.env.DOCKER_PROXY_URL ?? 'http://docker-proxy:2375';

function parseBase(base: string): { hostname: string; port: number; basePath: string } {
  const u = new URL(base);
  return {
    hostname: u.hostname,
    port: parseInt(u.port || '80', 10),
    basePath: u.pathname.replace(/\/$/, ''),
  };
}

// Translate Docker Engine API paths (/containers/json, /containers/:id/start …)
// to the proxy surface, which mirrors those paths directly.
// The proxy exposes /containers/* so paths pass through unchanged.
function proxyPath(dockerPath: string): string {
  const { basePath } = parseBase(PROXY_BASE);
  return `${basePath}${dockerPath}`;
}

export function dockerGet(path: string): Promise<unknown> {
  const { hostname, port } = parseBase(PROXY_BASE);
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname, port, path: proxyPath(path), headers: { Host: hostname } },
      (res) => {
        let body = '';
        res.on('data', (d: Buffer) => { body += d; });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            let message = `Docker proxy error ${statusCode}`;
            try { message = (JSON.parse(body) as { error?: string; message?: string }).error ?? message; } catch {}
            reject(new Error(message));
            return;
          }
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error(`Docker proxy parse error: ${body.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('Docker proxy timeout')); });
  });
}

export function dockerDelete(path: string): Promise<{ statusCode: number }> {
  const { hostname, port } = parseBase(PROXY_BASE);
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname,
      port,
      path: proxyPath(path),
      method: 'DELETE',
      headers: { Host: hostname },
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => { body += d; });
      res.on('end', () => {
        const code = res.statusCode ?? 0;
        if (code >= 200 && code < 300) {
          resolve({ statusCode: code });
        } else {
          let message = `Docker proxy error ${code}`;
          try { message = (JSON.parse(body) as { error?: string; message?: string }).error ?? message; } catch {}
          reject(new Error(message));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Docker proxy timeout')); });
    req.end();
  });
}

/**
 * Low-level POST that always resolves with { statusCode, body } — callers decide
 * whether to treat non-2xx as an error. Prefer dockerPost() for the common case.
 */
export function dockerPostRaw(path: string, body?: object): Promise<{ statusCode: number; body: string }> {
  const { hostname, port } = parseBase(PROXY_BASE);
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const options: http.RequestOptions = {
      hostname,
      port,
      path: proxyPath(path),
      method: 'POST',
      headers: {
        Host: hostname,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (d: Buffer) => { responseBody += d; });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: responseBody }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Docker proxy timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

export function dockerPost(path: string, body?: object): Promise<{ statusCode: number | undefined }> {
  return dockerPostRaw(path, body).then(({ statusCode, body: responseBody }) => {
    // Docker returns 204 No Content for successful start/stop/restart
    // Proxy returns 403 for unauthorized, 404 for not found, etc.
    if (statusCode >= 200 && statusCode < 300) {
      return { statusCode };
    }
    let message = `Docker proxy error ${statusCode}`;
    try { message = (JSON.parse(responseBody) as { error?: string; message?: string }).error ?? message; } catch {}
    throw Object.assign(new Error(message), { statusCode });
  });
}

/**
 * Attaches an existing container to a Docker network.
 * Idempotent: Docker 409 (endpoint already exists in this network) is swallowed.
 * Real proxy denials (403 — container not managed, network not allowed) are re-thrown.
 */
export async function dockerNetworkConnect(network: string, containerId: string, aliases: string[] = []): Promise<void> {
  const result = await dockerPostRaw(
    `/networks/${encodeURIComponent(network)}/connect`,
    {
      Container: containerId,
      ...(aliases.length > 0 ? { EndpointConfig: { Aliases: aliases } } : {}),
    },
  );
  if (result.statusCode >= 200 && result.statusCode < 300) return;
  // Docker returns 409 (or 403 on some versions) when the container is already connected.
  if (result.statusCode === 409) {
    console.log(`[docker] dockerNetworkConnect: container ${containerId} already on ${network} network — OK`);
    return;
  }
  if (result.statusCode === 403) {
    let msg = '';
    try { msg = (JSON.parse(result.body) as { message?: string }).message ?? ''; } catch {}
    if (msg.includes('already exists in network')) {
      console.log(`[docker] dockerNetworkConnect: container ${containerId} already on ${network} network — OK`);
      return;
    }
  }
  // Any other non-2xx (403 proxy-denied, 404, 500, …) must propagate.
  let message = `Docker proxy error ${result.statusCode}`;
  try { message = (JSON.parse(result.body) as { error?: string; message?: string }).error ?? message; } catch {}
  throw Object.assign(new Error(message), { statusCode: result.statusCode });
}

/**
 * Detaches an existing container from a Docker network.
 * Used when a container is already connected without the stable alias required
 * by HermitHost's Traefik file-provider route.
 */
export async function dockerNetworkDisconnect(network: string, containerId: string): Promise<void> {
  const result = await dockerPostRaw(
    `/networks/${encodeURIComponent(network)}/disconnect`,
    { Container: containerId },
  );
  if (result.statusCode >= 200 && result.statusCode < 300) return;
  // Docker returns 404/403 variants when the endpoint is already absent.
  if (result.statusCode === 404) return;

  let message = `Docker proxy error ${result.statusCode}`;
  try { message = (JSON.parse(result.body) as { error?: string; message?: string }).error ?? message; } catch {}
  if (message.includes('is not connected to the network')) return;
  throw Object.assign(new Error(message), { statusCode: result.statusCode });
}
