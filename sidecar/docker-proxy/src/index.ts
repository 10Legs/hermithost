import express, { Request, Response, NextFunction } from 'express';
import * as http from 'http';

const app = express();
app.use(express.json());

const DOCKER_SOCKET = '/var/run/docker.sock';
const PORT = 2375;

// A container is "managed" if it belongs to the hermithost compose stack
// OR is a Coolify-deployed application (carries coolify.applicationId or coolify.managed=true).
function isManagedContainer(labels: Record<string, string>): boolean {
  if (labels['com.docker.compose.project'] === 'hermithost') return true;
  if (labels['coolify.applicationId']) return true;
  if (labels['coolify.managed'] === 'true') return true;
  return false;
}

// ── Docker socket helpers ─────────────────────────────────────────────────────

function dockerRequest(options: http.RequestOptions, body?: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET, ...options }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Docker socket timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function getContainerLabels(id: string): Promise<Record<string, string> | null> {
  try {
    const result = await dockerRequest({ path: `/containers/${id}/json`, method: 'GET', headers: { Host: 'localhost' } });
    if (result.statusCode === 404) return null;
    const data = JSON.parse(result.body) as { Config?: { Labels?: Record<string, string> } };
    return data.Config?.Labels ?? {};
  } catch {
    return null;
  }
}

// ── Guard middleware for mutating container operations ───────────────────────

async function assertManaged(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { id } = req.params;
  const labels = await getContainerLabels(id);
  if (labels === null) {
    res.status(404).json({ error: 'Container not found' });
    return;
  }
  if (!isManagedContainer(labels)) {
    console.warn(`[docker-proxy] BLOCKED: operation on unmanaged container ${id}`);
    res.status(403).json({ error: 'Container is not managed by hermithost' });
    return;
  }
  next();
}

// ── GET /containers* — list containers, pass through filters from query ────────

app.get('/containers*', async (req: Request, res: Response): Promise<void> => {
  try {
    // If path is exactly /containers (no trailing /json), add it for Docker API compatibility
    const dockerPath = req.path === '/containers' ? '/containers/json' : req.path;
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const result = await dockerRequest({
      path: `${dockerPath}${qs}`,
      method: 'GET',
      headers: { Host: 'localhost' },
    });
    res.status(result.statusCode).set('Content-Type', 'application/json').send(result.body);
  } catch (err) {
    console.error('[docker-proxy] GET /containers* failed:', (err as Error).message);
    res.status(502).json({ error: 'Docker socket error' });
  }
});

// ── POST /containers/:id/start ────────────────────────────────────────────────

app.post('/containers/:id/start', assertManaged, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await dockerRequest({
      path: `/containers/${req.params.id}/start`,
      method: 'POST',
      headers: { Host: 'localhost', 'Content-Length': '0' },
    });
    res.status(result.statusCode).send();
  } catch (err) {
    console.error(`[docker-proxy] start ${req.params.id} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Docker socket error' });
  }
});

// ── POST /containers/:id/stop ─────────────────────────────────────────────────

app.post('/containers/:id/stop', assertManaged, async (req: Request, res: Response): Promise<void> => {
  try {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const result = await dockerRequest({
      path: `/containers/${req.params.id}/stop${qs}`,
      method: 'POST',
      headers: { Host: 'localhost', 'Content-Length': '0' },
    });
    res.status(result.statusCode).send();
  } catch (err) {
    console.error(`[docker-proxy] stop ${req.params.id} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Docker socket error' });
  }
});

// ── POST /containers/:id/restart ──────────────────────────────────────────────

app.post('/containers/:id/restart', assertManaged, async (req: Request, res: Response): Promise<void> => {
  try {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const result = await dockerRequest({
      path: `/containers/${req.params.id}/restart${qs}`,
      method: 'POST',
      headers: { Host: 'localhost', 'Content-Length': '0' },
    });
    res.status(result.statusCode).send();
  } catch (err) {
    console.error(`[docker-proxy] restart ${req.params.id} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Docker socket error' });
  }
});

// ── DELETE /containers/:id ────────────────────────────────────────────────────

app.delete('/containers/:id', assertManaged, async (req: Request, res: Response): Promise<void> => {
  try {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const result = await dockerRequest({
      path: `/containers/${req.params.id}${qs}`,
      method: 'DELETE',
      headers: { Host: 'localhost' },
    });
    res.status(result.statusCode).send();
  } catch (err) {
    console.error(`[docker-proxy] delete ${req.params.id} failed:`, (err as Error).message);
    res.status(502).json({ error: 'Docker socket error' });
  }
});

// ── Catch-all — deny anything not explicitly routed ──────────────────────────

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`[docker-proxy] Listening on :${PORT}`);
  console.log(`[docker-proxy] Socket: ${DOCKER_SOCKET}`);
});
