# Interledger Linear Roadmap Service

Standalone Node.js/TypeScript service that syncs Interledger Linear workspace data (teams,
projects, milestones, views) to PostgreSQL and exposes a JSON API consumed
by Astro static sites to render an interactive public roadmap.

---

## Architecture

```
Linear API ──(GraphQL)──► sync.ts ──► PostgreSQL (Prisma)
                                               │
Linear Webhooks ──► /webhook/linear ───────────┘
                                               │
Astro sites ◄──(GET /api/roadmap.json)─────────┘
```

- **Sync** — a CLI and HTTP trigger pull all teams, projects, milestones, and
  initiatives from Linear and upsert them into Postgres.
- **Webhook** — Linear fires events on create/update/remove; the service routes
  each event to the narrowest targeted sync (single project or initiative) to
  avoid full re-syncs.
- **API** — `/api/roadmap.json` returns a snapshot of projects sourced from a
  configured Linear custom view, ordered by `sortOrder`.

---

## Quick start

```bash
pnpm install
cp .env.example .env        # fill in LINEAR_API_KEY, DATABASE_URL, etc.
pnpm db:push                # push Prisma schema to your database
pnpm sync                   # initial full sync from Linear
pnpm dev                    # start server with hot reload on :3100
```

---

## Documentation

- [SETUP.md](SETUP.md) — full setup, environment variables, CLI commands, API
  reference, Astro integration guide, and deployment instructions

