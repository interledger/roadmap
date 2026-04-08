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

## RoadmapBoard Astro Component

### Data shape

Fetch the `board` field from the roadmap JSON — it's a pre-joined hierarchy ready for rendering:

```
BoardRow (initiative)
  └─ BoardProject[]
       └─ BoardMilestone[]
```

**BoardRow** (one row per initiative)
| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `name` | string | |
| `color` | string \| null | Use as row background tint |
| `icon` | string \| null | |
| `status` | string | `planned` \| `active` \| `completed` |
| `startDate` | string \| null | ISO — earliest project start |
| `targetDate` | string \| null | ISO |
| `projects` | BoardProject[] | Ordered by `sortOrder` from Linear |

**BoardProject** (label chip on its own sub-row)
| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `name` | string | |
| `color` | string \| null | Use as label background |
| `state` | string | `planned` \| `started` \| `paused` \| `completed` \| `cancelled` |
| `icon` | string \| null | |
| `progress` | number | 0–100 |
| `startDate` | string \| null | ISO |
| `targetDate` | string \| null | ISO |
| `url` | string \| null | Link to Linear project |
| `milestones` | BoardMilestone[] | Ordered by `sortOrder` |

**BoardMilestone** (label chip along the timeline)
| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `name` | string | |
| `sortOrder` | number | |
| `startDate` | string \| null | ISO — **inherited from parent project** |
| `targetDate` | string \| null | ISO |
| `color` | string \| null | **Inherited from parent project** — use as label background |

---

### Visual rendering spec

```
Visual layout:
┌──────────────────────────────────────────────────────────────────────┐
│ [sticky label col 240px] │ [Q1 2025] │ [Q2 2025] │ … │ [Q4 2027]   │
├──────────────────────────┼────────────────────────────────────────── │
│ ■ Initiative name        │ ─────── colored band across all cols ─── │
│   [Project chip ↗]       │     ░░░░░░░░░░ milestone chips ░░░░░░░░░ │
│   ├─ Milestone A name    │              [████ Milestone A ████]      │
│   └─ Milestone B name    │                      [███ B ███]         │
│   [Project chip 2 ↗]     │                                          │
│   └─ Milestone C         │         [████████████ C ███████████]     │
└──────────────────────────────────────────────────────────────────────┘
```

- **Initiative row** — full-width band; apply `initiative.color` at ~15% opacity as `background-color`
- **Project label** — chip/pill on its own sub-row; `background-color: project.color`; links to `project.url`
- **Milestone chips** — positioned along a timeline axis using `startDate` (left edge) → `targetDate` (right edge); `background-color: project.color` (inherited); display `milestone.name`

---

### Component props & usage

```typescript
// types (import from your roadmap API types or copy locally)
interface BoardMilestone {
  id: string; name: string; sortOrder: number
  startDate: string | null; targetDate: string | null; color: string | null
}
interface BoardProject {
  id: string; name: string; color: string | null; state: string
  icon: string | null; progress: number
  startDate: string | null; targetDate: string | null; url: string | null
  milestones: BoardMilestone[]
}
interface BoardRow {
  id: string; name: string; description: string | null
  color: string | null; icon: string | null; status: string
  startDate: string | null; targetDate: string | null
  projects: BoardProject[]
}
```

```astro
---
// src/pages/roadmap.astro
const res = await fetch(import.meta.env.ROADMAP_API_URL + '/api/roadmap.json')
const { board } = await res.json()
---

<RoadmapBoard board={board} />
```

```astro
---
// src/components/RoadmapBoard.astro
interface Props { board: BoardRow[] }
const { board } = Astro.props
---

{board.map((row) => (
  <div class="initiative-row" style={`background-color: ${row.color}26`}>
    <span class="initiative-name">{row.icon} {row.name}</span>
    {row.projects.map((project) => (
      <div class="project-row">
        <a class="project-label" href={project.url ?? '#'}
           style={`background-color: ${project.color}`}>
          {project.icon} {project.name}
        </a>
        <div class="milestones-timeline">
          {project.milestones.map((ms) => (
            <span class="milestone-chip"
                  style={`background-color: ${ms.color}`}
                  data-start={ms.startDate}
                  data-end={ms.targetDate}>
              {ms.name}
            </span>
          ))}
        </div>
      </div>
    ))}
  </div>
))}
```

---

## Deployment (Railway recommended)

1. Push this folder to its own Git repo
2. Create a new Railway project → Deploy from GitHub
3. Add a PostgreSQL plugin in Railway
4. Set environment variables in Railway dashboard
5. Railway auto-deploys on every push
