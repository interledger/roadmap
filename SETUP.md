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
| `PORT` | Port to run the service on (default: `3100`) |
| `HOST` | Server bind address (default: `0.0.0.0`) |
| `NODE_ENV` | `development` or `production` |
| `API_SECRET` | Bearer token to protect the manual `/api/sync` endpoints |
| `DEPLOY_HOOK_SITE_1` | Netlify/Vercel deploy hook URL for site 1 (optional) |
| `DEPLOY_HOOK_SITE_2` | Netlify/Vercel deploy hook URL for site 2 (optional) |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowed origins (dev default: `*`) |

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

This fetches all teams, projects, milestones, and initiatives from Linear and
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
- **Events**: Projects, Project Milestones, Initiatives

> Issues and Labels are not used by the roadmap and do not need to be enabled.

---

## CLI Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Run dev server with hot reload |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run compiled server (production) |
| **Syncing** | |
| `pnpm sync` | Full sync: teams → projects → initiatives |
| `pnpm sync:teams` | Sync teams only |
| `pnpm sync:projects` | Sync projects + milestones |
| `pnpm sync:initiatives` | Sync all initiatives |
| `pnpm sync:initiative <id>` | Sync a single initiative by Linear ID |
| `pnpm sync:project <id>` | Sync a single project by Linear ID |
| `pnpm sync:milestone <id>` | Sync a single milestone by Linear ID |
| `pnpm sync:view <view-id>` | Sync all projects from a custom Linear view |
| **Custom views** | |
| `pnpm fetch:views` | List all custom views in your workspace with their IDs |
| `pnpm fetch:view <view-id>` | Display details (filters, projects) for a single view |
| **Database** | |
| `pnpm db:generate` | Generate Prisma client |
| `pnpm db:push` | Push schema to DB (dev) |
| `pnpm db:migrate` | Run migrations (production) |
| `pnpm db:studio` | Open Prisma Studio (visual DB browser) |

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/roadmap.json` | None | Full roadmap snapshot (60s cache) |
| `GET` | `/api/status` | None | Sync status and record counts |
| `POST` | `/api/sync` | Bearer token | Trigger a full sync |
| `POST` | `/api/sync/teams` | Bearer token | Trigger teams-only sync |
| `POST` | `/api/sync/projects` | Bearer token | Trigger projects + milestones sync |
| `POST` | `/webhook/linear` | HMAC-SHA256 | Linear webhook receiver |

### Manual sync example

```bash
curl -X POST https://your-service.com/api/sync \
  -H "Authorization: Bearer YOUR_API_SECRET"
```

---

## Custom View

`/api/roadmap.json` sources its projects from a specific Linear **custom view**
rather than fetching all projects across all teams. The view ID is set in
`src/routes/roadmap.ts` as `ROADMAP_VIEW_ID`.

To find or change the view:

```bash
# List all custom views in your workspace
pnpm fetch:views

# Inspect a specific view
pnpm fetch:view <view-id>
```

Once you have the right view ID, update the constant in
`src/routes/roadmap.ts` and re-sync with `pnpm sync:view <view-id>`.

---

## Roadmap JSON Output

`GET /api/roadmap.json` returns:

```typescript
interface RoadmapSnapshot {
  generatedAt: string        // ISO timestamp of this response
  lastSyncAt: string | null  // ISO timestamp of the last completed sync
  teams: RoadmapTeam[]
  projects: RoadmapProject[] // ordered by sortOrder from the custom view
}

interface RoadmapTeam {
  id: string
  name: string
  key: string
  color: string | null
  childrenIds: string[]   // IDs of child teams
  projectCount: number    // count of projects belonging to this team
}

interface RoadmapProject {
  id: string
  name: string
  description: string | null
  state: 'planned' | 'started' | 'paused' | 'completed' | 'cancelled'
  color: string | null
  icon: string | null
  priority: number
  progress: number          // 0–100
  sortOrder: number         // position within the custom view
  startDate: string | null  // ISO
  targetDate: string | null // ISO
  completedAt: string | null
  url: string | null
  team: { id: string; name: string; key: string; color: string | null } | null
  milestones: RoadmapMilestone[]
}

interface RoadmapMilestone {
  id: string
  name: string
  targetDate: string | null  // ISO
}
```

Archived projects (name prefixed with `(Archived) `) are excluded from the
response automatically.

---

## Using in Astro

### Fetch at build time (SSG)

```astro
---
// src/pages/roadmap.astro
const res = await fetch(import.meta.env.ROADMAP_API_URL + '/api/roadmap.json')
const { teams, projects } = await res.json()
---

<RoadmapBoard teams={teams} projects={projects} />
```

Add to your Astro `.env`:

```
ROADMAP_API_URL=https://your-service.com
```

### Component example

```astro
---
// src/components/RoadmapBoard.astro
interface Props {
  teams: RoadmapTeam[]
  projects: RoadmapProject[]
}
const { projects } = Astro.props
---

{projects.map((project) => (
  <div class="project" style={`border-left-color: ${project.color}`}>
    <a href={project.url ?? '#'}>{project.icon} {project.name}</a>
    <span class="state">{project.state}</span>
    <div class="milestones">
      {project.milestones.map((ms) => (
        <span class="milestone">{ms.name} — {ms.targetDate}</span>
      ))}
    </div>
  </div>
))}
```

---

## Webhook Sync Routing

When Linear fires a webhook, the service routes it to the narrowest sync
available — avoiding a full re-sync for single-record changes:

| Linear event type | Sync triggered |
|---|---|
| `Project` | `syncSingleProject(id)` |
| `ProjectMilestone` | `syncSingleProject(parentProjectId)` |
| `Initiative` | `syncSingleInitiative(id)` |
| `InitiativeToProject` | `syncSingleInitiative(initiativeId)` |
| Anything else | `syncAll()` |

The service acknowledges the webhook immediately (returns `200`) and runs the
sync asynchronously.

---

## Deployment (Railway recommended)

1. Push this folder to its own Git repo
2. Create a new Railway project → Deploy from GitHub
3. Add a PostgreSQL plugin in Railway
4. Set environment variables in the Railway dashboard
5. Railway auto-deploys on every push
