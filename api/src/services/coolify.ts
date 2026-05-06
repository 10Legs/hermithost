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
  // Coolify's DB stores docker_compose_domains as a keyed object, but the REST API
  // serialises it as a JSON string. Accept both forms.
  docker_compose_domains?: string | Record<string, { domain: string }> | null;
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
  // Fix 3 — docker_compose_domains payload shape:
  // We send an array: [{ name: "frontend", domain: "https://example.com" }]
  // Coolify v4.3.5 accepts the array on PATCH /applications/{uuid} and internally converts
  // it to an object keyed by service name when persisting to the DB:
  //   e.g. {"frontend": {"domain": "https://example.com"}}
  // This is a Coolify-side serialisation detail — no change needed on our end.
  // Verified against Coolify source (ApplicationController@update, ComposeParser):
  // the API accepts the array form; the DB stores the object form. Sending an array is correct.
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
  // is_required is included when true — if Coolify rejects it (422) we log and swallow.
  async patchEnvByKey(appUuid: string, payload: { key: string; value: string; is_required?: boolean }): Promise<void> {
    const body: Record<string, unknown> = { key: payload.key, value: payload.value };
    if (payload.is_required === true) body.is_required = true;
    const res = await fetch(`${this.baseUrl}/applications/${appUuid}/envs`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok && res.status === 422 && payload.is_required) {
      // Coolify may not accept is_required — retry without it
      console.warn(`[coolify] patchEnvByKey: is_required rejected for ${payload.key} on ${appUuid} — retrying without`);
      const retry = await fetch(`${this.baseUrl}/applications/${appUuid}/envs`, {
        method: 'PATCH',
        headers: this.headers,
        body: JSON.stringify({ key: payload.key, value: payload.value }),
      });
      await handleResponse<unknown>(retry, `PATCH /applications/${appUuid}/envs (by key, no is_required)`);
      return;
    }
    await handleResponse<unknown>(res, `PATCH /applications/${appUuid}/envs (by key)`);
  }

  // ── Bulk env var prefill ──────────────────────────────────────────────────────
  // Pushes multiple env vars to a Coolify application sequentially.
  // Idempotent: fetches existing envs first and skips any key already present in Coolify.
  // This prevents the 2× duplication that occurs when Coolify auto-extracts compose envs
  // AND we also seed them — both would create separate rows with the same key.
  // On duplicate-key or other per-var failure: logs warning and continues.
  async setApplicationEnvs(uuid: string, envs: CoolifyEnvVar[]): Promise<void> {
    // Fetch current env keys so we can skip ones Coolify already has (auto-extracted or prior seed)
    let existingKeys = new Set<string>();
    try {
      const existing = await this.listEnvs(uuid);
      existingKeys = new Set(existing.map((e) => e.key));
    } catch (err) {
      // Non-fatal: if listing fails we proceed without dedup (safe — worst case is dups, not data loss)
      console.warn(`[coolify] setApplicationEnvs: could not list existing envs for ${uuid} — proceeding without dedup: ${(err as Error).message}`);
    }

    for (const env of envs) {
      if (existingKeys.has(env.key)) {
        console.log(`[coolify] setApplicationEnvs: skipping ${env.key} on ${uuid} — already exists in Coolify`);
        continue;
      }
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

  // ── Race-safe env sync ────────────────────────────────────────────────────────
  // Eliminates the duplicate-env race with Coolify's async compose auto-extraction.
  //
  // Strategy: instead of creating new env rows (which races with Coolify's extractor),
  // wait until Coolify's auto-extracted rows appear, then PATCH their values in-place.
  // This means we write into the rows Coolify already created — zero duplicate rows.
  //
  // For each var from our extractEnvVars() result:
  //   - If Coolify has the key AND value is empty/null AND we want to populate → PATCH value
  //   - If Coolify has the key AND is_required should be true → PATCH is_required
  //   - If Coolify does NOT have the key (rare) → CREATE via setApplicationEnvs
  //
  // pollTimeoutMs: how long to wait for Coolify to auto-populate envs (default 30s)
  async syncApplicationEnvs(
    uuid: string,
    envs: CoolifyEnvVar[],
    requiredKeys: Set<string>,
    pollTimeoutMs = 30_000,
  ): Promise<void> {
    const pollInterval = 500;
    const maxAttempts = Math.ceil(pollTimeoutMs / pollInterval);

    // Poll until Coolify's auto-extracted envs appear
    let coolifyEnvs: CoolifyEnv[] = [];
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollInterval));
      try {
        const fetched = await this.listEnvs(uuid);
        if (fetched.length > 0) {
          coolifyEnvs = fetched;
          break;
        }
      } catch (err) {
        console.warn(`[coolify] syncApplicationEnvs: listEnvs poll attempt ${attempt + 1} failed: ${(err as Error).message}`);
      }
    }

    if (coolifyEnvs.length === 0) {
      console.warn(`[coolify] syncApplicationEnvs: Coolify envs never appeared for ${uuid} after ${pollTimeoutMs}ms — falling back to create`);
      await this.setApplicationEnvs(uuid, envs);
      return;
    }

    console.log(`[coolify] syncApplicationEnvs: found ${coolifyEnvs.length} Coolify-extracted envs for ${uuid}`);

    // Build lookup of Coolify's auto-extracted envs by key.
    // If Coolify has duplicate rows for a key (caused by LoadComposeFile running twice after
    // our PATCH docker_compose_domains), keep the first occurrence and delete the extras.
    const coolifyByKey = new Map<string, CoolifyEnv>();
    const dupesToDelete: string[] = [];
    for (const env of coolifyEnvs) {
      if (!coolifyByKey.has(env.key)) {
        coolifyByKey.set(env.key, env);
      } else {
        // This is a duplicate row — queue for deletion (uuid is the Coolify env row uuid)
        dupesToDelete.push(env.uuid);
      }
    }
    if (dupesToDelete.length > 0) {
      console.log(`[coolify] syncApplicationEnvs: deduplicating ${dupesToDelete.length} extra Coolify env rows for ${uuid}`);
      for (const envUuid of dupesToDelete) {
        try {
          await this.deleteEnv(uuid, envUuid);
        } catch (delErr) {
          console.warn(`[coolify] syncApplicationEnvs: failed to delete dupe env row ${envUuid} on ${uuid}: ${(delErr as Error).message}`);
        }
      }
    }

    const missing: CoolifyEnvVar[] = [];

    for (const env of envs) {
      const coolifyRow = coolifyByKey.get(env.key);
      if (coolifyRow) {
        // Row exists — PATCH value if empty AND we have a value to set
        const currentValue = coolifyRow.value ?? '';
        const isRequired = requiredKeys.has(env.key);
        if (currentValue === '' && env.value !== '') {
          try {
            await this.patchEnvByKey(uuid, { key: env.key, value: env.value, ...(isRequired ? { is_required: true } : {}) });
            console.log(`[coolify] syncApplicationEnvs: patched value for ${env.key} on ${uuid} (is_required=${isRequired})`);
          } catch (err) {
            console.warn(`[coolify] syncApplicationEnvs: patch failed for ${env.key} on ${uuid}: ${(err as Error).message}`);
          }
        } else {
          console.log(`[coolify] syncApplicationEnvs: ${env.key} already has a value on ${uuid} — skipping`);
        }
      } else {
        // Key not in Coolify at all — queue for creation
        missing.push(env);
      }
    }

    // Create any vars Coolify didn't auto-extract
    if (missing.length > 0) {
      console.log(`[coolify] syncApplicationEnvs: creating ${missing.length} vars not auto-extracted by Coolify`);
      for (const env of missing) {
        const payload: CreateEnvPayload = {
          key: env.key,
          value: env.value,
          ...(env.is_build_time !== undefined ? { is_buildtime: env.is_build_time } : {}),
          ...(env.is_literal !== undefined ? { is_shown_once: env.is_literal } : {}),
        };
        try {
          await this.createEnv(uuid, payload);
        } catch (err) {
          console.warn(`[coolify] syncApplicationEnvs: create failed for ${env.key} on ${uuid}: ${(err as Error).message}`);
        }
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
