# Linear Roadmap Service — Setup Guide

Standalone Node.js service that syncs Linear data to PostgreSQL and exposes a
JSON endpoint consumed by Astro sites.

---

## Prerequisites

- Node.js 20+
- pnpm (`npm i -g pnpm`)
- A running PostgreSQL database
- A Linear workspace with API access

---

## 1. Install dependencies

```bash
pnpm install
```

---

## 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Description |
|---|---|
| `LINEAR_API_KEY` | Personal API key from Linear → Settings → API |
| `LINEAR_WEBHOOK_SECRET` | Secret you set when creating the Linear webhook |
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | Port to run the service on (default: 3100) |
| `API_SECRET` | Bearer token to protect the manual `/api/sync` endpoint |
| `DEPLOY_HOOK_SITE_1` | Netlify/Vercel deploy hook URL for site 1 |
| `DEPLOY_HOOK_SITE_2` | Netlify/Vercel deploy hook URL for site 2 (add when ready) |

---

## 3. Set up the database

```bash
# Generate Prisma client
pnpm db:generate

# Push schema to your database (dev) or run migrations (prod)
pnpm db:push        # development
pnpm db:migrate     # production
```

---

## 4. Run the first sync

```bash
pnpm sync
```

This fetches all teams, projects, milestones, and issues from Linear and
writes them to PostgreSQL.

---

## 5. Start the service

```bash
# Development (hot reload)
pnpm dev

# Production
pnpm build && pnpm start
```

---

## 6. Configure the Linear webhook

In Linear → Settings → API → Webhooks:

- **URL**: `https://your-service.com/webhook/linear`
- **Secret**: same value as `LINEAR_WEBHOOK_SECRET` in `.env`
- **Events**: Issues, Projects, Project Milestones, Issue Labels

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/roadmap.json` | Full roadmap snapshot |
| `GET` | `/api/roadmap.json?team=ENG` | Filtered by team key |
| `GET` | `/api/status` | Sync status and record counts |
| `POST` | `/api/sync` | Manually trigger a full sync |
| `POST` | `/webhook/linear` | Linear webhook receiver |

---

## Using in Astro (build time)

```astro
---
// src/pages/roadmap.astro
const res = await fetch(import.meta.env.ROADMAP_API_URL + '/api/roadmap.json')
const roadmap = await res.json()
---

<RoadmapBoard projects={roadmap.projects} teams={roadmap.teams} />
```

Add to your Astro `.env`:
```
ROADMAP_API_URL=https://your-service.com
```

---

## Deployment (Railway recommended)

1. Push this folder to its own Git repo
2. Create a new Railway project → Deploy from GitHub
3. Add a PostgreSQL plugin in Railway
4. Set environment variables in Railway dashboard
5. Railway auto-deploys on every push
