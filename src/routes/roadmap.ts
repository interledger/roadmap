import type { FastifyInstance } from 'fastify'
import { prisma } from '../db/client.js'
import type { RoadmapSnapshot } from '../types/roadmap.js'

export async function roadmapRoutes(app: FastifyInstance) {
  /**
   * GET /api/roadmap.json
   *
   * Returns the full roadmap snapshot. This is what Astro sites fetch
   * at build time (SSG) or on each request (SSR).
   *
   * Optionally filter by team key: /api/roadmap.json?team=ENG
   */
  app.get<{ Querystring: { team?: string } }>('/api/roadmap.json', async (request, reply) => {
    const { team: teamKey } = request.query

    const [teams, projects, syncMeta] = await Promise.all([
      prisma.team.findMany({ orderBy: { name: 'asc' } }),
      prisma.project.findMany({
        where: teamKey ? { team: { key: teamKey } } : undefined,
        orderBy: [{ state: 'asc' }, { targetDate: 'asc' }, { name: 'asc' }],
        include: {
          team: true,
          milestones: {
            orderBy: { sortOrder: 'asc' },
            include: {
              issues: {
                orderBy: [{ priority: 'asc' }, { title: 'asc' }],
                include: { labels: true },
              },
            },
          },
          issues: {
            where: { milestoneId: null },
            orderBy: [{ priority: 'asc' }, { title: 'asc' }],
            include: { labels: true },
          },
        },
      }),
      prisma.syncMeta.findUnique({ where: { id: 1 } }),
    ])

    const snapshot: RoadmapSnapshot = {
      generatedAt: new Date().toISOString(),
      lastSyncAt: syncMeta?.lastSyncAt.toISOString() ?? null,
      teams: teams.map((t) => ({
        id: t.id,
        name: t.name,
        key: t.key,
        color: t.color,
        projectCount: projects.filter((p) => p.teamId === t.id).length,
      })),
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        state: p.state,
        color: p.color,
        icon: p.icon,
        progress: p.progress,
        startDate: p.startDate?.toISOString() ?? null,
        targetDate: p.targetDate?.toISOString() ?? null,
        url: p.url,
        team: p.team
          ? { id: p.team.id, name: p.team.name, key: p.team.key, color: p.team.color }
          : null,
        milestones: p.milestones.map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          targetDate: m.targetDate?.toISOString() ?? null,
          sortOrder: m.sortOrder,
          issues: m.issues.map(formatIssue),
        })),
        issues: p.issues.map(formatIssue),
      })),
    }

    reply.header('Content-Type', 'application/json')
    reply.header('Cache-Control', 'public, max-age=60') // 1 min browser cache
    return snapshot
  })

  /**
   * GET /api/status
   * Quick health check — shows sync status and last sync time.
   */
  app.get('/api/status', async () => {
    const meta = await prisma.syncMeta.findUnique({ where: { id: 1 } })
    const counts = await Promise.all([
      prisma.team.count(),
      prisma.project.count(),
      prisma.issue.count(),
    ])

    return {
      status: meta?.status ?? 'idle',
      lastSyncAt: meta?.lastSyncAt ?? null,
      error: meta?.error ?? null,
      counts: {
        teams: counts[0],
        projects: counts[1],
        issues: counts[2],
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatIssue(issue: {
  id: string
  title: string
  state: string
  stateName: string
  stateColor: string | null
  priority: number
  priorityName: string | null
  estimate: number | null
  dueDate: Date | null
  completedAt: Date | null
  assigneeName: string | null
  url: string | null
  labels: { id: string; name: string; color: string | null }[]
}) {
  return {
    id: issue.id,
    title: issue.title,
    state: issue.state,
    stateName: issue.stateName,
    stateColor: issue.stateColor,
    priority: issue.priority,
    priorityName: issue.priorityName,
    estimate: issue.estimate,
    dueDate: issue.dueDate?.toISOString() ?? null,
    completedAt: issue.completedAt?.toISOString() ?? null,
    assigneeName: issue.assigneeName,
    url: issue.url,
    labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
  }
}
