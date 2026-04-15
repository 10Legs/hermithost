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
  created_at: string;
  updated_at: string;
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
  message: string;
  deployment_uuid: string;
  status: string;
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
    return handleResponse<CoolifyDeploymentQueue[]>(res, `GET /deployments/applications/${uuid}`);
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
}

export function createCoolifyClient(): CoolifyClient | null {
  const baseUrl = process.env.COOLIFY_API_URL;
  const token = process.env.COOLIFY_API_TOKEN;
  if (!baseUrl || !token) return null;
  return new CoolifyClient(baseUrl, token);
}
