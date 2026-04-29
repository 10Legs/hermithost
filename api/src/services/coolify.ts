// Coolify API client — typed, using Node 18+ native fetch only.

export interface CoolifyApplication {
  uuid: string;
  name: string;
  description: string | null;
  fqdn: string | null;
  status: string;
  git_repository: string;
  git_branch: string;
  git_commit_sha: string;
  build_pack: string;
  docker_compose_location?: string;
  docker_compose_raw?: string | null;
  base_directory?: string;
  created_at: string;
  updated_at: string;
  private_key_uuid?: string;
}

export interface CoolifyLogEntry {
  output: string;
  type: 'stdout' | 'stderr' | 'error';
  timestamp: string;
  order: number;
}

export interface CoolifyDeploymentQueue {
  deployment_uuid: string;
  application_id: number;
  status: string;
  commit: string;
  commit_message: string | null;
  created_at: string;
  finished_at: string | null;
  updated_at: string;
  logs: string; // JSON-stringified CoolifyLogEntry[]
  server_name: string;
  application_name: string;
  force_rebuild: boolean;
  is_webhook: boolean;
  is_api: boolean;
}

export interface CoolifyTriggerDeployResponse {
  deployments: Array<{
    message: string;
    resource_uuid: string;
    deployment_uuid: string;
  }>;
}

export interface CoolifyCreateApplicationPayload {
  type: 'public' | 'private';
  name: string;
  description?: string;
  domains?: string;
  docker_compose_domains?: Array<{ name: string; domain: string }>;
  git_repository: string;
  git_branch: string;
  build_pack: string;
  docker_compose_location?: string;
  base_directory?: string;
  ports_exposes: string;
  server_uuid: string;
  destination_uuid: string;
  project_uuid: string;
  environment_name: string;
  instant_deploy?: boolean;
  private_key_uuid?: string;
}

export interface CoolifyServer {
  uuid: string;
  name: string;
  ip: string;
  is_reachable: boolean;
  is_usable: boolean;
}

export interface CoolifyProject {
  uuid: string;
  name: string;
  environments: Array<{ name: string; uuid: string }>;
}

export interface CoolifyUpdateApplicationPayload {
  name?: string;
  description?: string;
  domains?: string;  // sets fqdn — Coolify PATCH uses 'domains', not 'fqdn'
  docker_compose_domains?: Array<{ name: string; domain: string }>;
  git_repository?: string;
  git_branch?: string;
  build_pack?: string;
  docker_compose_location?: string;
  base_directory?: string;
}

export interface CoolifyEnv {
  uuid: string;
  key: string;
  value: string | null;
  is_shown_once: boolean;
  is_runtime: boolean;
  is_buildtime: boolean;
  is_preview: boolean;
}

export interface CoolifyEnvVar {
  key: string;
  value: string;
  is_build_time?: boolean;
  is_literal?: boolean;
}

export interface CreateEnvPayload {
  key: string;
  value: string;
  is_runtime?: boolean;
  is_buildtime?: boolean;
  is_shown_once?: boolean;
}

export interface UpdateEnvPayload extends CreateEnvPayload {
  uuid: string;
}

async function handleResponse<T>(res: Response, context: string): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Coolify ${context} failed: HTTP ${res.status} — ${body}`);
  }
  return res.json() as Promise<T>;
}

export class CoolifyClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  async listApplications(): Promise<CoolifyApplication[]> {
    const res = await fetch(`${this.baseUrl}/applications`, { headers: this.headers });
    return handleResponse<CoolifyApplication[]>(res, 'GET /applications');
  }

  async getApplication(uuid: string): Promise<CoolifyApplication> {
    const res = await fetch(`${this.baseUrl}/applications/${uuid}`, { headers: this.headers });
    return handleResponse<CoolifyApplication>(res, `GET /applications/${uuid}`);
  }

  async listDeployments(uuid: string, limit = 10): Promise<CoolifyDeploymentQueue[]> {
    const url = `${this.baseUrl}/deployments/applications/${uuid}?limit=${limit}`;
    const res = await fetch(url, { headers: this.headers });
    const data = await handleResponse<{ deployments: CoolifyDeploymentQueue[] } | CoolifyDeploymentQueue[]>(res, `GET /deployments/applications/${uuid}`);
    return Array.isArray(data) ? data : (data as { deployments: CoolifyDeploymentQueue[] }).deployments ?? [];
  }

  async triggerDeploy(uuid: string): Promise<CoolifyTriggerDeployResponse> {
    const url = `${this.baseUrl}/deploy?uuid=${uuid}`;
    const res = await fetch(url, { method: 'POST', headers: this.headers });
    return handleResponse<CoolifyTriggerDeployResponse>(res, `POST /deploy?uuid=${uuid}`);
  }

  async getDeployment(deploymentUuid: string): Promise<CoolifyDeploymentQueue> {
    const res = await fetch(`${this.baseUrl}/deployments/${deploymentUuid}`, { headers: this.headers });
    return handleResponse<CoolifyDeploymentQueue>(res, `GET /deployments/${deploymentUuid}`);
  }

  async getServers(): Promise<CoolifyServer[]> {
    const res = await fetch(`${this.baseUrl}/servers`, { headers: this.headers });
    return handleResponse<CoolifyServer[]>(res, 'GET /servers');
  }

  async getProjects(): Promise<CoolifyProject[]> {
    const res = await fetch(`${this.baseUrl}/projects`, { headers: this.headers });
    return handleResponse<CoolifyProject[]>(res, 'GET /projects');
  }

  async createProject(name: string): Promise<CoolifyProject> {
    const res = await fetch(`${this.baseUrl}/projects`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ name }),
    });
    return handleResponse<CoolifyProject>(res, 'POST /projects');
  }

  async createApplication(payload: CoolifyCreateApplicationPayload): Promise<CoolifyApplication> {
    const res = await fetch(`${this.baseUrl}/applications/public`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    return handleResponse<CoolifyApplication>(res, 'POST /applications/public');
  }

  async deployApplication(uuid: string): Promise<CoolifyTriggerDeployResponse> {
    const res = await fetch(`${this.baseUrl}/applications/${uuid}/start`, {
      method: 'POST',
      headers: this.headers,
    });
    return handleResponse<CoolifyTriggerDeployResponse>(res, `POST /applications/${uuid}/start`);
  }

  async deleteApplication(uuid: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/applications/${uuid}`, {
      method: 'DELETE',
      headers: this.headers,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      throw new Error(`Coolify DELETE /applications/${uuid} failed: HTTP ${res.status} — ${body}`);
    }
  }

  async updateApplication(uuid: string, payload: CoolifyUpdateApplicationPayload): Promise<CoolifyApplication> {
    const res = await fetch(`${this.baseUrl}/applications/${uuid}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    return handleResponse<CoolifyApplication>(res, `PATCH /applications/${uuid}`);
  }

  async listEnvs(appUuid: string): Promise<CoolifyEnv[]> {
    const res = await fetch(`${this.baseUrl}/applications/${appUuid}/envs`, { headers: this.headers });
    return handleResponse<CoolifyEnv[]>(res, `GET /applications/${appUuid}/envs`);
  }

  async createEnv(appUuid: string, payload: CreateEnvPayload): Promise<void> {
    const res = await fetch(`${this.baseUrl}/applications/${appUuid}/envs`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    await handleResponse<unknown>(res, `POST /applications/${appUuid}/envs`);
  }

  async updateEnv(appUuid: string, payload: UpdateEnvPayload): Promise<void> {
    const res = await fetch(`${this.baseUrl}/applications/${appUuid}/envs`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    await handleResponse<unknown>(res, `PATCH /applications/${appUuid}/envs`);
  }

  // ── Key-based env patch (no uuid in body) ─────────────────────────────────
  // Coolify's PATCH /applications/{uuid}/envs identifies the var by key.
  // Sending uuid in the body causes a 422 validation error.
  async patchEnvByKey(appUuid: string, payload: { key: string; value: string }): Promise<void> {
    const res = await fetch(`${this.baseUrl}/applications/${appUuid}/envs`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    await handleResponse<unknown>(res, `PATCH /applications/${appUuid}/envs (by key)`);
  }

  // ── Bulk env var prefill ──────────────────────────────────────────────────────
  // Pushes multiple env vars to a Coolify application sequentially.
  // On duplicate-key or other per-var failure: logs warning and continues.
  async setApplicationEnvs(uuid: string, envs: CoolifyEnvVar[]): Promise<void> {
    for (const env of envs) {
      const payload: CreateEnvPayload = {
        key: env.key,
        value: env.value,
        ...(env.is_build_time !== undefined ? { is_buildtime: env.is_build_time } : {}),
        ...(env.is_literal !== undefined ? { is_shown_once: env.is_literal } : {}),
      };
      try {
        await this.createEnv(uuid, payload);
      } catch (err) {
        console.warn(
          `[coolify] setApplicationEnvs: failed to set ${env.key} on ${uuid} — ${(err as Error).message}`,
        );
      }
    }
  }

  async deleteEnv(appUuid: string, envUuid: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/applications/${appUuid}/envs/${envUuid}`, {
      method: 'DELETE',
      headers: this.headers,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      throw new Error(`Coolify DELETE /applications/${appUuid}/envs/${envUuid} failed: HTTP ${res.status} — ${body}`);
    }
  }
}

export function createCoolifyClient(): CoolifyClient | null {
  const baseUrl = process.env.COOLIFY_API_URL;
  // Prefer token file — setup script always refreshes it on boot, so it's always valid
  let token: string | undefined;
  try {
    const { readFileSync } = require('fs') as typeof import('fs');
    token = readFileSync('/coolify-api-token/token', 'utf8').trim() || undefined;
  } catch { /* file not present */ }
  // Fall back to env var
  if (!token) token = process.env.COOLIFY_API_TOKEN;
  if (!baseUrl || !token) return null;
  return new CoolifyClient(baseUrl, token);
}
