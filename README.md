# HermitHost

A self-hosted web platform dashboard for managing deployed sites, DNS records, and deployments. HermitHost wraps Coolify (deployments), Technitium or Cloudflare (DNS), and Traefik (reverse proxy + SSL) into a single unified dashboard with zero-config setup.

**Status Dashboard** • **DNS Management** • **Deploy History** • **Health Monitoring** • **Backup & Restore** • **Auto SSL**

---

## What is HermitHost?

HermitHost is a lightweight platform dashboard that gives you visibility and control over all your deployed web applications in one place. Instead of logging into Coolify, Technitium, and Traefik separately, HermitHost surfaces everything in a single UI.

- **Monitor everything:** HTTP status, SSL certificate health, DNS resolution — live probes, 60s cache
- **Manage DNS:** Use Technitium (internal/LAN) or Cloudflare (public authoritative DNS) — switchable from Settings
- **Track deployments:** See deployment history and stream logs per site
- **Backup & restore:** Export/import your full hermithost configuration
- **Auto SSL:** Traefik + Let's Encrypt — HTTPS with no manual certificate management
- **One-command setup:** `bash scripts/setup.sh` prompts for two values and handles the rest

---

## Architecture

```
Browser
  ├─ LAN: http://<server-ip>:9080 (internal, no DNS required)
  │
  └─ Named domain: https://hermithost.<your-domain>
       ↓
  Traefik (reverse proxy) :8080 / :8443
    ├─ /api/* → Express API :3001
    └─ /*     → SvelteKit Frontend :3000
         ↓
    ┌──────────────────────────────────┐
    │  Express API                      │
    │  ├─ DnsProvider (abstraction)     │
    │  │   ├─ TechnitiumProvider        │
    │  │   └─ CloudflareProvider        │
    │  ├─ Coolify (deployments)         │
    │  ├─ Health probes (HTTP/SSL/DNS) │
    │  ├─ Config API                    │
    │  └─ Backup / restore              │
    └──────────────────────────────────┘
         ↓                    ↓
    Coolify :8000        DNS Server
    (PostgreSQL + Redis)  (Technitium :5380 OR Cloudflare API)
```

### Services

| Service | Tech | Purpose |
|---------|------|---------|
| **Frontend** | SvelteKit + TypeScript | Dashboard UI |
| **API** | Express.js + TypeScript | Aggregation layer — Coolify, DNS providers, probes |
| **Traefik** | Traefik v3 | Reverse proxy, Let's Encrypt SSL |
| **Coolify** | Coolify (Docker) | Deployment and app lifecycle management |
| **DNS Provider** | Technitium DNS or Cloudflare API | DNS server with REST management (switchable) |
| **PostgreSQL** | Postgres 15 | Coolify database |
| **Redis** | Redis | Coolify queue and cache |

---

## Prerequisites

- **Docker** (v20.10+) and **Docker Compose** (v2.0+)
- **Node.js** (v18+) — only for native development, not required for Docker
- **Cloudflare account** (optional, only if using Cloudflare for public DNS)

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
│   │   │   ├── healthProbe.ts    # HTTP/SSL/DNS probes
│   │   │   ├── backup.ts         # Backup/restore logic
│   │   │   ├── mapper.ts         # Coolify → hermithost type mapper
│   │   │   └── dns/
│   │   │       ├── DnsProvider.ts        # Interface (abstract)
│   │   │       ├── TechnitiumProvider.ts # Technitium implementation
│   │   │       ├── CloudflareProvider.ts # Cloudflare API v4 implementation
│   │   │       └── index.ts              # Factory (reads DNS_PROVIDER setting)
│   │   └── types.ts              # Shared API types
│   ├── package.json
│   └── Dockerfile
├── src/                          # SvelteKit frontend
│   ├── routes/
│   │   ├── +page.svelte          # Sites dashboard
│   │   ├── sites/[slug]/
│   │   │   └── +page.svelte      # Site detail
│   │   └── settings/
│   │       └── +page.svelte      # Settings + backup + DNS provider UI
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
