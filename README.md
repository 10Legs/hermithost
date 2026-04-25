# HermitHost

A self-hosted web platform dashboard for managing deployed sites, DNS records, and deployments. HermitHost wraps Coolify (deployments), Technitium or Cloudflare (DNS), and Traefik (reverse proxy + SSL) into a single unified dashboard with zero-config setup.

**Status Dashboard** • **DNS Management** • **Deploy History** • **Health Monitoring** • **Services Pane** • **Backup & Restore** • **Auto SSL** • **Auto-Deploy CD**

---

## What is HermitHost?

HermitHost is a lightweight platform dashboard that gives you full visibility and control over all your deployed web applications in one place. Coolify, Technitium, and Traefik are infrastructure — HermitHost is the only interface you interact with.

- **Monitor everything:** HTTP status, SSL certificate health, DNS resolution — live probes, 60s cache
- **Manage DNS:** Use Technitium (internal/LAN) or Cloudflare (public authoritative DNS) — switchable from Settings
- **Track deployments:** See deployment history and stream logs per site
- **Services pane:** Real-time view of all Docker containers — stack services and deployed sites — with start/stop/restart controls
- **Backup & restore:** Export/import your full hermithost configuration
- **Auto SSL:** Traefik + Let's Encrypt — HTTPS with no manual certificate management
- **Auto-deploy CD:** Push to `main` → GitHub Actions builds new images and hot-swaps containers on the production host with automatic rollback on failure
- **One-command setup:** `bash scripts/setup.sh` prompts for two values and handles the rest

---

## Architecture

### Request Flow

```
Browser
  ├─ LAN: http://<server-ip>:9080  (admin entrypoint — no DNS required)
  └─ Named domain: https://hermithost.<your-domain>
         ↓
    Traefik :9080 (admin) / :80 / :443
      ├─ /api/* → Express API :3001
      └─ /*     → SvelteKit Frontend :3000
```

### API Layer

```
Express API
  ├─ /api/sites        — Site CRUD, health probes, deploy triggers
  │     └─ Coolify API client (GET/POST/PATCH/DELETE /v1/applications)
  ├─ /api/services     — Docker container monitoring (stack + deployed sites)
  │     └─ Docker socket (/var/run/docker.sock)
  ├─ /api/dns          — DNS record management
  │     └─ DnsProvider (abstraction)
  │           ├─ TechnitiumProvider → Technitium REST API :5380
  │           └─ CloudflareProvider → Cloudflare API v4
  ├─ /api/config       — Settings read/write
  ├─ /api/backup       — Export / import / validate
  ├─ /api/stats        — Live request stats (ingested from Traefik access logs)
  └─ /api/health       — Stack health check
```

### Services

| Service | Tech | Purpose |
|---------|------|---------|
| **Frontend** | SvelteKit + TypeScript | Dashboard UI |
| **API** | Express.js + TypeScript | Aggregation layer — Coolify, DNS, Docker, health probes |
| **Traefik** | Traefik v3 | Reverse proxy, Let's Encrypt SSL, admin entrypoint |
| **Coolify** | Coolify (Docker) | Deployment engine — not user-facing; HermitHost is the interface |
| **DNS Provider** | Technitium DNS or Cloudflare API | DNS management (switchable) |
| **PostgreSQL** | Postgres 15 | Coolify database |
| **Redis** | Redis | Coolify queue and cache |

### Design Principles

- **HermitHost is the authority.** Coolify is a deployment engine accessed only via API — the Coolify UI is an escape hatch, not part of the normal workflow.
- **Docker socket for container reality.** The Services pane reads directly from the Docker API to show actual container state — not what Coolify thinks is running.
- **Infra is invisible.** One-shot init containers (`coolify-server-setup`, `coolify-keys-init`) and infrastructure containers (`coolify-proxy`, `coolify-sentinel`) are automatically filtered from the Services pane once they exit.

---

## CI/CD & Auto-Deploy

HermitHost ships with a full GitHub Actions pipeline. Every push to `main` triggers a zero-downtime deploy to the production host.

### Pipeline Overview

```
Pull Request opened
  → CI workflow (runs on any self-hosted runner)
       ├─ API: TypeScript typecheck + build
       ├─ Frontend: TypeScript typecheck + svelte-check + build
       └─ Docker: both images build cleanly
            ↓ (all must pass before merge)

Merge to main
  → Deploy workflow (runs on runner labeled `production`)
       ├─ Preflight: verify .env exists on host
       ├─ Sync: git fetch + reset --hard origin/main
       ├─ Snapshot: record current image IDs for rollback
       ├─ Build API image    (docker compose build --no-cache api)
       ├─ Build Frontend image
       ├─ Deploy API         (hot-swap: --no-deps --no-build)
       ├─ Deploy Frontend    (hot-swap: --no-deps --no-build)
       ├─ Health check: GET http://localhost:9080/api/health  (30s window)
       ├─ Health check: GET http://localhost:9080             (30s window)
       ├─ [on failure] Rollback: restore previous image IDs
       └─ [on success] Prune dangling images
```

### Key Design Decisions

**Hot-swap, not full restart.** `docker compose up -d --no-deps --no-build` replaces only the `api` and `frontend` containers. Coolify, PostgreSQL, Redis, Traefik, and Technitium are never touched during a deploy — zero disruption to running sites.

**No workspace checkout.** The deploy job runs directly from `STACK_DIR` (the live stack on the host), not from a fresh `actions/checkout` workspace. This ensures relative volume mounts (`./data`, `./traefik/conf.d`) always resolve against the real live directory.

**Automatic rollback.** Before building new images, the deploy snapshots the current image IDs. If any step after the snapshot fails, the previous images are tagged and re-deployed automatically.

**Dedicated runner.** The deploy job requires a runner labeled `production` — the same host that runs the live stack. The CI job runs on any available self-hosted runner. Two runners in the pool keeps CI fast without serializing on the production host.

**Concurrency guard.** Only one deploy runs at a time (`cancel-in-progress: false`). If two merges land back-to-back, the second queues rather than cancels — no deploys are silently skipped.

### Runner Setup

Two self-hosted GitHub Actions runners are expected:

| Runner | Label | Purpose |
|--------|-------|---------|
| Any host | `self-hosted` | CI checks on PRs |
| Production host | `self-hosted, production` | Deploy to production |

To add the `production` label: GitHub repo → Settings → Actions → Runners → click the production runner → edit labels → add `production`.

### One-Time Bootstrap (Production Host)

These steps are done once on the production host and never need to be repeated:

```bash
# 1. Clone the repo to the live stack directory
git clone https://github.com/your-org/hermithost.git /path/to/hermithost
cd /path/to/hermithost

# 2. Create .env from template and fill in secrets
cp .env.template .env
# Edit .env — fill in ACME_EMAIL and NS_HOSTNAME at minimum
# All other secrets are auto-generated by setup.sh

bash scripts/setup.sh

# 3. Start the stack
bash scripts/start.sh
```

After this, every `git push origin main` deploys automatically.

### Overriding the Stack Directory

If your stack lives somewhere other than the default path, set a GitHub Actions variable:

```
Repository → Settings → Variables → Actions → New variable
Name: STACK_DIR
Value: /your/custom/path/hermithost
```

---

## Prerequisites

- **Docker** (v20.10+) and **Docker Compose** (v2.0+)
- **Node.js** (v18+) — only for native development, not required for Docker
- **Cloudflare account** (optional, only if using Cloudflare for public DNS)

---

## Quick Start

### 1. Clone and setup

```bash
git clone https://github.com/your-org/hermithost.git
cd hermithost

bash scripts/setup.sh
```

`setup.sh` will:
- Generate all Coolify internal secrets automatically
- Prompt for your **ACME email** (Let's Encrypt SSL notifications) — also used as the Coolify admin email
- Prompt for your **NS_HOSTNAME** (public IP or hostname of this server)
- Auto-generate a strong Coolify admin password and print it once — save it

### 2. Start the stack

```bash
bash scripts/start.sh
```

This script automatically creates the `coolify` Docker network if it doesn't exist (required for inter-container communication).

### 3. Open the dashboard

**LAN (no DNS required):**
```
http://<server-ip>:9080
```

**Named domain (requires DNS + TLS):**
```
https://hermithost.<your-domain>
```

Coolify UI (escape hatch only): `http://localhost:8000`
Technitium DNS UI (if using Technitium): `http://localhost:5380`

---

## Setup Script Details

```bash
bash scripts/setup.sh
```

| Variable | How it's set |
|----------|-------------|
| `COOLIFY_ADMIN_EMAIL` | Defaults to `ACME_EMAIL` value (real email required by Coolify) |
| `COOLIFY_ADMIN_PASSWORD` | Auto-generated strong password — printed to stdout during setup |
| `COOLIFY_APP_ID/KEY` | Auto-generated (`openssl rand`) |
| `COOLIFY_DB_PASSWORD` | Auto-generated |
| `COOLIFY_REDIS_PASSWORD` | Auto-generated |
| `COOLIFY_PUSHER_*` | Auto-generated |
| `ACME_EMAIL` | **Prompted** — required for SSL cert issuance |
| `NS_HOSTNAME` | **Prompted** — your server's public IP or hostname |
| `DNS_PROVIDER` | Default: `technitium` — optionally switch to `cloudflare` after setup |
| `CLOUDFLARE_TOKEN` | Optional — set via Settings if using Cloudflare provider |

Safe to re-run — only fills empty values, never overwrites existing ones.

---

## Environment Variables

Full reference for `.env`:

| Variable | Description | Default |
|----------|-------------|---------|
| `COOLIFY_ADMIN_EMAIL` | Coolify admin login email | Defaults to `ACME_EMAIL` value |
| `COOLIFY_ADMIN_PASSWORD` | Coolify admin login password | Auto-generated strong password, printed at setup |
| `COOLIFY_PORT` | Coolify UI port | `8000` |
| `ACME_EMAIL` | Let's Encrypt contact email | *(prompted)* |
| `NS_HOSTNAME` | Server public IP or hostname | *(prompted)* |
| `TRAEFIK_HTTP_PORT` | Traefik HTTP port | `8080` |
| `TRAEFIK_HTTPS_PORT` | Traefik HTTPS port | `8443` |
| `TECHNITIUM_URL` | Technitium API base URL | `http://technitium:5380` |
| `DNS_PORT` | Host port for DNS queries. Use `53` on dedicated servers; default avoids macOS/Linux conflict | `5353` |
| `DNS_PROVIDER` | Active DNS provider | `technitium` |
| `CLOUDFLARE_TOKEN` | Cloudflare API token (also settable via Settings UI) | *(empty)* |
| `COOLIFY_API_TOKEN` | Auto-provisioned at startup | *(auto)* |
| `TECHNITIUM_TOKEN` | Auto-provisioned at startup | *(auto)* |

---

## Features

### Site Directory
List all deployed sites with live status indicators — HTTP reachability, SSL validity, DNS resolution.

### Health Probes
Real-time per-site probes run in parallel, cached 60 seconds:
- **HTTP** — response code + latency
- **SSL** — cert valid, expiry date, issuer
- **DNS** — A-record resolves

### Deployment Management
Trigger deploys, view deployment history, stream live deployment logs — all via the Coolify integration.

### Services Pane
Real-time view of every Docker container on the host, sourced directly from the Docker socket:

- **Stack Services** — hermithost infrastructure containers grouped by function (HermitHost, Coolify, Infrastructure). Exited one-shot init containers are hidden automatically.
- **Deployed Sites** — all user-deployed application containers grouped by site. Containers belonging to sites that no longer exist in Coolify are flagged as abandoned and can be force-deleted.
- **Actions** — start, stop, and restart any container directly from the UI
- **Shutdown** — gracefully stop all deployed site containers with a checkpoint, then stop the hermithost stack

### DNS Management
Create, update, and delete DNS records via Technitium (internal/LAN) or Cloudflare (public authoritative DNS). Switch providers anytime from Settings → DNS Provider.

### DNS Provider Setup

#### Technitium (Default)
- No setup required — Technitium is deployed automatically
- Access UI at `http://localhost:5380` (internal only)
- Best for: home labs, internal networks, ISPs that don't block port 53

#### Cloudflare (Public DNS)
- Use when your ISP blocks inbound port 53 (common with AT&T and others)
- **One-time setup:**
  1. Create a Cloudflare API token at https://dash.cloudflare.com/profile/api-tokens
  2. Token must have permissions: **Zone:Edit** + **Zone:Create** (account-level)
  3. *(Note: "Edit zone DNS" template is insufficient — create a custom token)*
  4. Open HermitHost Settings → DNS Provider
  5. Select "Cloudflare"
  6. Paste your API token
  7. Save — system will verify connectivity
- Best for: public-facing sites, when ISP blocks port 53, production deployments

### Backup & Restore
Export a full snapshot of your hermithost configuration (sites, DNS records, settings) to a JSON file. Import to restore or migrate to a new server.

```
Settings → Backup → Export
Settings → Backup → Import
```

### Settings
Manage hermithost configuration:
- NS hostname, Traefik ports, admin credentials
- **DNS Provider** — switch between Technitium and Cloudflare
- **Cloudflare Token** — set/update your API token
- Backup & restore

All from the UI without editing `.env` directly.

### Auto SSL
Traefik + Let's Encrypt automatically issues and renews SSL certificates for all sites. Requires a valid `ACME_EMAIL` and publicly reachable `NS_HOSTNAME`.

---

## Scripts

| Script | Purpose |
|--------|---------|
| `bash scripts/setup.sh` | First-time config — generates secrets, prompts for email + hostname |
| `bash scripts/start.sh` | Start the full stack (auto-creates Docker `coolify` network) |
| `bash scripts/stop.sh` | Stop all containers |
| `bash scripts/restart.sh` | Restart the stack |
| `bash scripts/status.sh` | Show container status |
| `bash scripts/logs` | Tail logs (usage: `bash scripts/logs api`) |

---

## API Reference

All endpoints are under `/api`.

### Sites
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sites` | List all sites |
| `GET` | `/api/sites/:slug` | Site detail with live health probes |
| `POST` | `/api/sites` | Create site |
| `PATCH` | `/api/sites/:slug` | Update site settings |
| `DELETE` | `/api/sites/:slug` | Delete site |

### Deployments
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sites/:slug/deploy` | Trigger deployment |
| `GET` | `/api/sites/:slug/deployments` | Deployment history |
| `GET` | `/api/sites/:slug/deployments/:id/log` | Deployment logs |

### DNS
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sites/:slug/dns` | List DNS records |
| `POST` | `/api/sites/:slug/dns` | Create DNS record |
| `PUT` | `/api/sites/:slug/dns/:id` | Update DNS record |
| `DELETE` | `/api/sites/:slug/dns/:id` | Delete DNS record |

### Services (Docker)
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/services` | All containers — stack groups + site groups + restore event |
| `POST` | `/api/services/:id/start` | Start container |
| `POST` | `/api/services/:id/stop` | Stop container |
| `POST` | `/api/services/:id/restart` | Restart container |
| `DELETE` | `/api/services/:id` | Force-remove abandoned container |
| `POST` | `/api/services/shutdown` | Checkpoint + graceful stack shutdown |

### Config & Backup
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config` | Get current hermithost config (includes `dns_provider`, `cloudflare_status`, `cloudflare_token_set`) |
| `PATCH` | `/api/config` | Update config values (accepts `dns_provider`, `cloudflare_token`) |
| `GET` | `/api/backup/export` | Export full config backup |
| `POST` | `/api/backup/import` | Import backup file |
| `POST` | `/api/backup/validate` | Validate backup before importing |

### System
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |

---

## Project Structure

```
hermithost/
├── .github/
│   └── workflows/
│       ├── ci.yml            # PR checks — typecheck, build, Docker image validation
│       └── deploy.yml        # CD — push to main → hot-swap deploy on production host
├── api/                      # Express API
│   ├── src/
│   │   ├── index.ts          # App setup + route registration
│   │   ├── routes/
│   │   │   ├── sites.ts      # Site CRUD, health probes, DNS provisioning, deployments
│   │   │   ├── services.ts   # Docker container monitoring + container actions
│   │   │   ├── backup.ts     # Export / import / validate
│   │   │   ├── config.ts     # Config read/write
│   │   │   ├── stats.ts      # Live request stats
│   │   │   └── health.ts     # Health check
│   │   ├── services/
│   │   │   ├── coolify.ts        # Coolify API client (typed)
│   │   │   ├── docker.ts         # Docker socket HTTP client
│   │   │   ├── healthProbe.ts    # HTTP/SSL/DNS probes
│   │   │   ├── backup.ts         # Backup/restore logic
│   │   │   ├── mapper.ts         # Coolify → hermithost type mapper
│   │   │   ├── liveStats.ts      # Real-time stats aggregation
│   │   │   ├── statsIngester.ts  # Traefik log ingestion
│   │   │   └── dns/
│   │   │       ├── DnsProvider.ts        # Interface (abstract)
│   │   │       ├── TechnitiumProvider.ts # Technitium implementation
│   │   │       ├── CloudflareProvider.ts # Cloudflare API v4 implementation
│   │   │       └── index.ts              # Factory (reads DNS_PROVIDER setting)
│   │   └── types.ts          # Shared API types
│   ├── package.json
│   └── Dockerfile
├── src/                      # SvelteKit frontend
│   ├── routes/
│   │   ├── +page.svelte          # Sites dashboard
│   │   ├── +layout.svelte        # App shell + sidebar navigation
│   │   ├── sites/[slug]/
│   │   │   └── +page.svelte      # Site detail
│   │   ├── services/
│   │   │   └── +page.svelte      # Container management pane
│   │   ├── dns/
│   │   │   └── +page.svelte      # DNS management
│   │   └── settings/
│   │       └── +page.svelte      # Settings + backup + DNS provider UI
│   └── lib/
│       └── types.ts              # Frontend types
├── traefik/                  # Traefik config
│   └── conf.d/routes.yml     # Route rules (HermitHost stack + per-site dynamic routes)
├── docker/                   # Container entrypoint scripts
├── scripts/                  # Setup and management scripts
├── docker-compose.yml        # Full stack
├── docker-compose.prod.yml   # Production overrides (ACME volumes)
├── Dockerfile                # SvelteKit multi-stage build
├── vite.config.ts            # Dev proxy config
├── .env.template             # Environment template
└── README.md
```

---

## Development (Native)

Run frontend and API outside Docker:

**Terminal 1 — API**
```bash
cd api && npm install && npm run dev
# http://localhost:3001
```

**Terminal 2 — Frontend**
```bash
npm install && npm run dev
# http://localhost:5113 — proxies /api to :3001 automatically
```

### Useful Commands

```bash
# Frontend
npm run dev          # Dev server
npm run build        # Production build
npm run check        # TypeScript + Svelte type check

# API
cd api
npm run dev          # Express dev server
npm run build        # Compile TypeScript → dist/

# Docker
docker compose up --build    # Build and start
docker compose logs -f       # Stream logs
docker compose down          # Stop and remove
```

---

## Troubleshooting

### Stack won't start — missing .env values

Run `bash scripts/setup.sh` — it will prompt for anything missing and generate all secrets.

### Stack won't start — Docker network missing

`scripts/start.sh` automatically creates the `coolify` network. If manually running `docker compose up`, ensure the network exists:

```bash
docker network create coolify
docker compose up
```

### Coolify login fails

- **Email:** the value of `ACME_EMAIL` you entered during `setup.sh`
- **Password:** the strong password printed to stdout during `setup.sh` (look for `[setup] Coolify admin password: ...`)
- To reset: clear `COOLIFY_ADMIN_EMAIL` and `COOLIFY_ADMIN_PASSWORD` in `.env` and re-run `bash scripts/setup.sh`

### SSL certs not issuing

- Confirm `ACME_EMAIL` is a real email address
- Confirm `NS_HOSTNAME` resolves publicly and ports 80/443 are open
- Check Traefik logs: `docker compose logs traefik`

### Probes show "not reachable"

- Verify the site domain is publicly resolvable
- Confirm outbound HTTPS from the container isn't blocked
- Test: `curl -I https://yourdomain.com`

### Auto-deploy not triggering

- Confirm the production runner is online: GitHub repo → Settings → Actions → Runners
- Confirm the runner has the `production` label
- Check deploy run logs: GitHub repo → Actions → Deploy

### Auto-deploy fails — .env not found

The deploy expects `.env` at `STACK_DIR` on the production host. Run `bash scripts/setup.sh` once on the host to create it.

### ISP blocks port 53 (DNS queries fail)

Use Cloudflare provider instead:
1. Create a Cloudflare API token (see **DNS Provider Setup** section)
2. Open Settings → DNS Provider
3. Select "Cloudflare" and paste your token
4. Save and verify connection

### Cloudflare provider not connecting

- Verify token has **Zone:Edit** + **Zone:Create** permissions (not just "Edit zone DNS" template)
- Check that your Cloudflare account owns the domain you're configuring
- Review API token in Cloudflare dashboard — confirm it hasn't expired
- Check API logs: `docker compose logs api | grep -i cloudflare`

### Port conflict

Change ports in `.env`:
```bash
TRAEFIK_HTTP_PORT=8082
TRAEFIK_HTTPS_PORT=8444
```

---

## License

Proprietary — part of Ron DeMeritt's personal project harness.
