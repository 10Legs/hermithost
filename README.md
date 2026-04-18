# HermitHost

A self-hosted web platform dashboard for managing deployed sites, DNS records, and deployments. HermitHost wraps Coolify (deployments), Technitium (DNS), and Traefik (reverse proxy + SSL) into a single unified dashboard with zero-config setup.

**Status Dashboard** • **DNS Management** • **Deploy History** • **Health Monitoring** • **Backup & Restore** • **Auto SSL**

---

## What is HermitHost?

HermitHost is a lightweight platform dashboard that gives you visibility and control over all your deployed web applications in one place. Instead of logging into Coolify, Technitium, and Traefik separately, HermitHost surfaces everything in a single UI.

- **Monitor everything:** HTTP status, SSL certificate health, DNS resolution — live probes, 60s cache
- **Manage DNS:** View, create, update, and delete DNS records via Technitium
- **Track deployments:** See deployment history and stream logs per site
- **Backup & restore:** Export/import your full hermithost configuration
- **Auto SSL:** Traefik + Let's Encrypt — HTTPS with no manual certificate management
- **One-command setup:** `bash scripts/setup.sh` prompts for two values and handles the rest

---

## Architecture

```
Browser
  ↓
Traefik (reverse proxy) :8080 / :8443
  ├─ /api/* → Express API :3001
  └─ /*     → SvelteKit Frontend :3000
       ↓
  ┌────────────────────────────────┐
  │  Express API                   │
  │  ├─ Coolify (deployments)      │
  │  ├─ Technitium (DNS)           │
  │  ├─ Health probes (HTTP/SSL/DNS)│
  │  ├─ Config API                 │
  │  └─ Backup / restore           │
  └────────────────────────────────┘
       ↓                    ↓
  Coolify :8000        Technitium :5380
  (PostgreSQL + Redis)
```

### Services

| Service | Tech | Purpose |
|---------|------|---------|
| **Frontend** | SvelteKit + TypeScript | Dashboard UI |
| **API** | Express.js + TypeScript | Aggregation layer — Coolify, Technitium, probes |
| **Traefik** | Traefik v3 | Reverse proxy, Let's Encrypt SSL |
| **Coolify** | Coolify (Docker) | Deployment and app lifecycle management |
| **Technitium** | Technitium DNS | DNS server with REST management API |
| **PostgreSQL** | Postgres 15 | Coolify database |
| **Redis** | Redis | Coolify queue and cache |

---

## Prerequisites

- **Docker** (v20.10+) and **Docker Compose** (v2.0+)
- **Node.js** (v18+) — only for native development, not required for Docker

---

## Quick Start

### 1. Clone and setup

```bash
git clone https://github.com/rdemeritt/hermithost.git
cd hermithost

bash scripts/setup.sh
```

`setup.sh` will:
- Generate all Coolify internal secrets automatically
- Default Coolify admin to `admin@hermithost.local` / `admin`
- Prompt for your **ACME email** (Let's Encrypt SSL notifications)
- Prompt for your **NS_HOSTNAME** (public IP or hostname of this server)

### 2. Start the stack

```bash
bash scripts/start.sh
```

### 3. Open the dashboard

```
http://localhost:8080
```

Coolify UI (escape hatch only): `http://localhost:8000`
Technitium DNS UI: `http://localhost:5380`

---

## Setup Script Details

```bash
bash scripts/setup.sh
```

| Variable | How it's set |
|----------|-------------|
| `COOLIFY_ADMIN_EMAIL` | Defaults to `admin@hermithost.local` |
| `COOLIFY_ADMIN_PASSWORD` | Defaults to `admin` |
| `COOLIFY_APP_ID/KEY` | Auto-generated (`openssl rand`) |
| `COOLIFY_DB_PASSWORD` | Auto-generated |
| `COOLIFY_REDIS_PASSWORD` | Auto-generated |
| `COOLIFY_PUSHER_*` | Auto-generated |
| `ACME_EMAIL` | **Prompted** — required for SSL cert issuance |
| `NS_HOSTNAME` | **Prompted** — your server's public IP or hostname |

Safe to re-run — only fills empty values, never overwrites existing ones.

---

## Environment Variables

Full reference for `.env`:

| Variable | Description | Default |
|----------|-------------|---------|
| `COOLIFY_ADMIN_EMAIL` | Coolify admin login email | `admin@hermithost.local` |
| `COOLIFY_ADMIN_PASSWORD` | Coolify admin login password | `admin` |
| `COOLIFY_PORT` | Coolify UI port | `8000` |
| `ACME_EMAIL` | Let's Encrypt contact email | *(prompted)* |
| `NS_HOSTNAME` | Server public IP or hostname | *(prompted)* |
| `TRAEFIK_HTTP_PORT` | Traefik HTTP port | `8080` |
| `TRAEFIK_HTTPS_PORT` | Traefik HTTPS port | `8443` |
| `TECHNITIUM_URL` | Technitium API base URL | `http://technitium:5380` |
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

### DNS Management
Create, update, and delete DNS records for your sites via the Technitium integration. Records update immediately.

### Backup & Restore
Export a full snapshot of your hermithost configuration (sites, DNS records, settings) to a JSON file. Import to restore or migrate to a new server.

```
Settings → Backup → Export
Settings → Backup → Import
```

### Settings
Manage hermithost configuration (NS hostname, Traefik ports, admin credentials) from the UI without editing `.env` directly.

### Auto SSL
Traefik + Let's Encrypt automatically issues and renews SSL certificates for all sites. Requires a valid `ACME_EMAIL` and publicly reachable `NS_HOSTNAME`.

---

## Scripts

| Script | Purpose |
|--------|---------|
| `bash scripts/setup.sh` | First-time config — generates secrets, prompts for email + hostname |
| `bash scripts/start.sh` | Start the full stack |
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

### Config & Backup
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config` | Get current hermithost config |
| `PATCH` | `/api/config` | Update config values |
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
├── api/                          # Express API
│   ├── src/
│   │   ├── index.ts              # App setup + route registration
│   │   ├── routes/
│   │   │   ├── sites.ts          # Site CRUD, health probes, deployments
│   │   │   ├── backup.ts         # Export / import / validate
│   │   │   ├── config.ts         # Config read/write
│   │   │   └── health.ts         # Health check
│   │   ├── services/
│   │   │   ├── coolify.ts        # Coolify API client
│   │   │   ├── technitium.ts     # Technitium DNS client
│   │   │   ├── healthProbe.ts    # HTTP/SSL/DNS probes
│   │   │   ├── backup.ts         # Backup/restore logic
│   │   │   └── mapper.ts         # Coolify → hermithost type mapper
│   │   └── types.ts              # Shared API types
│   ├── package.json
│   └── Dockerfile
├── src/                          # SvelteKit frontend
│   ├── routes/
│   │   ├── +page.svelte          # Sites dashboard
│   │   ├── sites/[slug]/
│   │   │   └── +page.svelte      # Site detail
│   │   └── settings/
│   │       └── +page.svelte      # Settings + backup UI
│   └── lib/
│       └── types.ts              # Frontend types
├── traefik/                      # Traefik config
│   └── conf.d/routes.yml         # Route rules
├── docker/                       # Container entrypoint scripts
├── scripts/                      # Setup and management scripts
├── docker-compose.yml            # Full stack
├── docker-compose.prod.yml       # Production overrides (ACME volumes)
├── Dockerfile                    # SvelteKit multi-stage build
├── vite.config.ts                # Dev proxy config
├── .env.template                 # Environment template
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

### Coolify login fails

Default credentials: `admin@hermithost.local` / `admin`
Override in `.env`: set `COOLIFY_ADMIN_EMAIL` and `COOLIFY_ADMIN_PASSWORD` before first boot.

### SSL certs not issuing

- Confirm `ACME_EMAIL` is a real email address
- Confirm `NS_HOSTNAME` resolves publicly and ports 80/443 are open
- Check Traefik logs: `docker compose logs traefik`

### Probes show "not reachable"

- Verify the site domain is publicly resolvable
- Confirm outbound HTTPS from the container isn't blocked
- Test: `curl -I https://yourdomain.com`

### Port conflict

Change ports in `.env`:
```bash
TRAEFIK_HTTP_PORT=8082
TRAEFIK_HTTPS_PORT=8444
```

---

## License

Proprietary — part of Ron DeMeritt's personal project harness.
