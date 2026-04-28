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

export function dockerPost(path: string, body?: object): Promise<{ statusCode: number | undefined }> {
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
      res.on('end', () => {
        // Docker returns 204 No Content for start/stop/restart
        resolve({ statusCode: res.statusCode });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Docker proxy timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}
