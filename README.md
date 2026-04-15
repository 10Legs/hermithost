# HermitHost

A self-hosted web platform dashboard for managing deployed sites, DNS records, and deployments. HermitHost integrates with Coolify for deployment management, Technitium for DNS, and provides real-time health monitoring via live probes.

**Status Dashboard** • **DNS Management** • **Deploy History** • **Health Monitoring**

---

## What is HermitHost?

HermitHost is a lightweight platform dashboard that gives you visibility and control over all your deployed web applications in one place. It replaces the need to log into multiple dashboards to check site status, manage DNS, and review deployments.

- **Monitor everything:** HTTP status, SSL certificate health, DNS resolution
- **Manage DNS records:** View, create, update, and delete DNS records via Technitium integration
- **Track deployments:** See deployment history and logs for every site
- **Works standalone or integrated:** Runs in Docker with optional Coolify and Technitium backends, or in mock mode for UI development

---

## Features

- **Site Directory:** List all deployed sites with live health status indicators
- **Health Probes:** Real-time HTTP, SSL, and DNS monitoring with 60-second cache
- **Deployment Management:** Trigger deploys, view history, and stream deployment logs
- **DNS Management:** Create, update, and delete DNS records for your sites
- **Mock Mode:** Full functionality with mock data when no external services are configured
- **Traefik Reverse Proxy:** Single ingress point with path-prefix routing (development) or host-based routing (production)
- **Docker Compose Stack:** Frontend, API, and reverse proxy in one `docker compose up`

---

## Architecture

HermitHost is a three-tier system with clear separation of concerns:

```
Browser
  ↓
Traefik (reverse proxy) :8080 — path-prefix routing
  ├─ /api/* → Express API :3001
  └─ /*    → SvelteKit Frontend :3000
```

### Components

| Service | Tech | Purpose |
|---------|------|---------|
| **Frontend** | SvelteKit + TypeScript | Dashboard UI with Svelte reactive components |
| **API** | Express.js + TypeScript | Thin proxy/aggregation layer to Coolify and Technitium |
| **Traefik** | Traefik v3 | Reverse proxy with optional Let's Encrypt SSL |
| **Coolify** | *(optional)* | Deployment and application lifecycle management |
| **Technitium** | *(optional)* | DNS server with record management API |

### Data Flow

1. **Get Sites List:** Browser → Traefik → Express API → (Coolify OR Mock) → JSON
2. **Health Probes:** Express API spawns parallel HTTP/SSL/DNS checks, caches 60s per domain
3. **DNS Management:** Frontend → Express API → Technitium API (or mock fallback)
4. **Deployments:** Express API triggers Coolify webhooks, streams logs via Coolify's API

---

## Prerequisites

### Required
- **Docker** (v20.10+) and **Docker Compose** (v2.0+)
- **Node.js** (v18+) — if running native development

### Optional
- **Coolify instance** — for real deployment management (leave empty for mock mode)
- **Technitium DNS server** — for real DNS management (leave empty for mock mode)

---

## Quick Start — Docker (Local Development)

Get the dashboard running in < 2 minutes:

```bash
cd /Users/rdemeritt/projects/ai/hermithost

# Copy environment template and optionally edit
cp .env.template .env
# Leave COOLIFY and TECHNITIUM vars empty for mock mode
# Edit if you have real instances

# Start all services with Docker Compose
docker compose up --build

# Dashboard: http://localhost:8080
# Traefik UI: http://localhost:8081
```

That's it. The entire stack is running:
- Frontend on port 3000
- API on port 3001
- Traefik on port 8080 (HTTP), 8081 (dashboard), 8443 (HTTPS)

Stop with `Ctrl+C`, restart with `docker compose up`.

---

## Quick Start — Native (Local Development)

Run frontend and API separately without Docker:

### Terminal 1 — API Server
```bash
cd /Users/rdemeritt/projects/ai/hermithost/api

npm install
npm run dev
# API listening at http://localhost:3001
```

### Terminal 2 — Frontend
```bash
cd /Users/rdemeritt/projects/ai/hermithost

npm install
npm run dev
# Dashboard at http://localhost:5113
# API proxied to localhost:3001 automatically
```

The Vite dev server auto-proxies `/api/*` requests to the Express API.

---

## Environment Variables

Create `.env` from `.env.template` and configure:

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `GITHUB_TOKEN` | GitHub personal access token for git operations | *(empty)* | No |
| `COOLIFY_API_URL` | Coolify API base URL (e.g., `http://localhost:8000/api/v1`) | *(empty)* | No* |
| `COOLIFY_API_TOKEN` | Coolify API token for authentication | *(empty)* | No* |
| `TECHNITIUM_URL` | Technitium DNS server base URL (e.g., `http://localhost:5380`) | *(empty)* | No* |
| `TECHNITIUM_TOKEN` | Technitium DNS API token | *(empty)* | No* |
| `TRAEFIK_HTTP_PORT` | HTTP port for Traefik reverse proxy | `8080` | No |
| `TRAEFIK_HTTPS_PORT` | HTTPS port for Traefik reverse proxy | `8443` | No |
| `ACME_EMAIL` | Email for Let's Encrypt ACME account (production only) | *(empty)* | No |

**\* Either both or neither must be set.** If `COOLIFY_API_URL` is empty, the API runs in mock mode with built-in test data.

### Mock Mode
When all integration variables are empty, HermitHost runs entirely in mock mode:
- No external dependencies required
- All endpoints return mock data
- Perfect for UI development and demos
- Health probes still work for real domains (e.g., `probeSite('github.com')`)

---

## Production Deployment

### Standalone (Self-Hosted)

Deploy on a standalone server with Traefik handling SSL:

```bash
# Set your ACME email for Let's Encrypt
echo "ACME_EMAIL=admin@yourdomain.com" >> .env

# Start with production compose file
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Dashboard at https://yourdomain.com
# Traefik dashboard at https://yourdomain.com:8081
```

The production compose file adds:
- ACME automatic certificate provisioning
- Persistent traefik certificate storage

### Behind Coolify (Managed Hosting)

If deploying HermitHost *inside* Coolify:

1. **Remove Traefik from stack** — Coolify's Traefik handles ingress
2. **Update Docker labels** — Change routing rule from `PathPrefix()` to `Host()`
3. **Set CORS_ORIGIN** — Update to your actual domain

```yaml
# In docker-compose.yml, update frontend labels:
labels:
  - "traefik.http.routers.frontend.rule=Host(`hermithost.yourdomain.com`)"
  - "traefik.http.routers.frontend.priority=1"
```

Then update environment:
```bash
CORS_ORIGIN=https://hermithost.yourdomain.com
```

---

## API Reference

All endpoints are namespaced under `/api`.

### Sites
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sites` | List all sites |
| `GET` | `/api/sites/:slug` | Get site details with health probes |
| `POST` | `/api/sites` | Create new site |
| `PATCH` | `/api/sites/:slug` | Update site settings (name, description, etc.) |
| `DELETE` | `/api/sites/:slug` | Delete site |

### Site Health & Deployments
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sites/:slug/deploy` | Trigger a deployment |
| `GET` | `/api/sites/:slug/deployments` | Get deployment history |
| `GET` | `/api/sites/:slug/deployments/:id/log` | Get deployment logs |

### DNS Records
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sites/:slug/dns` | List DNS records for site |
| `POST` | `/api/sites/:slug/dns` | Create DNS record |
| `PUT` | `/api/sites/:slug/dns/:id` | Update DNS record |
| `DELETE` | `/api/sites/:slug/dns/:id` | Delete DNS record |

### System
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check endpoint |

---

## Health Probes

The API runs real-time health checks on configured sites:

### HTTP Probe
Performs HTTPS request to domain, records:
- Response status code
- Response time (ms)
- Reachability (true/false)

### SSL Probe
Opens TLS connection, extracts certificate:
- Certificate valid (true/false)
- Expiration date and days until expiry
- Issuer (e.g., "Let's Encrypt")

### DNS Probe
Performs DNS A-record lookup:
- Domain resolves (true/false)
- Propagation status

All probes run in parallel and cache results for 60 seconds per domain.

---

## Development

### Project Structure
```
hermithost/
├── api/                          # Express API server
│   ├── src/
│   │   ├── index.ts              # Express app setup
│   │   ├── routes/
│   │   │   ├── sites.ts          # Site CRUD and probes
│   │   │   ├── health.ts         # Health check endpoint
│   │   │   └── hosted.ts         # Static file serving for deployed sites
│   │   ├── services/
│   │   │   ├── coolify.ts        # Coolify API client
│   │   │   ├── technitium.ts     # Technitium DNS client
│   │   │   └── healthProbe.ts    # HTTP/SSL/DNS probes
│   │   └── data/
│   │       └── mock.ts           # Mock site and DNS data
│   ├── package.json
│   └── Dockerfile
├── src/                          # SvelteKit frontend
│   ├── routes/
│   │   ├── +page.svelte          # Dashboard / sites list
│   │   └── sites/[slug]/+page.svelte  # Site detail view
│   ├── lib/
│   │   └── types.ts              # Shared TypeScript types
│   └── app.html
├── docker-compose.yml            # Development compose
├── docker-compose.prod.yml       # Production overrides (ACME, volumes)
├── Dockerfile                    # SvelteKit build (multi-stage)
├── vite.config.ts               # Dev server proxy config
├── package.json
├── .env.template
└── README.md
```

### Useful Commands

#### Frontend
```bash
npm run dev        # Start dev server (http://localhost:5113)
npm run build      # Build for production
npm run check      # TypeScript and Svelte type checking
npm run check:watch  # Watch for type errors
```

#### API
```bash
cd api
npm run dev        # Start Express dev server
npm run build      # Compile TypeScript → dist/
npm start          # Run compiled server
```

#### Docker
```bash
docker compose up --build     # Build and start all services
docker compose logs -f        # Stream all service logs
docker compose down           # Stop and remove containers
```

### Type Checking

Both frontend and API are fully typed with TypeScript. Check types before committing:

```bash
# Frontend
npm run check

# API
cd api && npx tsc --noEmit
```

### CI/CD

GitHub Actions pipeline runs on all PRs and pushes to main:
1. **Typecheck API** — TypeScript compilation check
2. **Typecheck Frontend** — SvelteKit sync + TypeScript check
3. **Build Frontend** — Vite production build
4. **Build API** — TypeScript compilation
5. **Docker Build** — Build both Docker images (no push in CI)

All steps must pass before merging.

---

## Troubleshooting

### "API not reachable" in development (native)

**Problem:** Frontend can't reach API at localhost:3001

**Solution:** Ensure both dev servers are running:
- Terminal 1: `cd api && npm run dev` (port 3001)
- Terminal 2: `npm run dev` (port 5113 with proxy)

Vite dev server proxies `/api` automatically via `vite.config.ts`.

### "CORS error" in production

**Problem:** Browser blocks API requests with CORS error

**Solution:** Update `CORS_ORIGIN` environment variable to match frontend domain:
```bash
CORS_ORIGIN=https://yourdomain.com
docker compose up -d
```

### Probes always show "not reachable"

**Problem:** Health probes fail for all sites

**Solution:** Check that:
1. Site domains are valid and publicly resolvable
2. Sites have valid HTTPS certificates
3. No firewall blocking outbound HTTPS traffic from container
4. Mock mode works (test with `curl localhost:8080/api/sites`)

### Traefik dashboard shows no routes

**Problem:** Services appear offline in Traefik UI

**Solution:** Check that services are healthy:
```bash
docker compose logs traefik
docker compose logs frontend
docker compose logs api
```

Ensure labels are correct in docker-compose.yml (no typos in `traefik.http.routers.*`).

### Docker Compose fails with "port already in use"

**Problem:** Port 8080 or 3000 already in use

**Solution:** Either:
1. Stop the conflicting service: `lsof -i :8080`
2. Change ports in `.env`: `TRAEFIK_HTTP_PORT=8082`

---

## Contributing

All work must pass type checking and build tests:

```bash
# Before committing:
npm run check              # Frontend
cd api && npm run build    # API
docker compose up --build  # Full stack smoke test
```

Create a feature branch and open a PR. GitHub Actions will run the full pipeline automatically.

---

## License

Proprietary — part of Ron DeMeritt's personal project harness.
