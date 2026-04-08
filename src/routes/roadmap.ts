import type { FastifyInstance } from 'fastify'
import { prisma } from '../db/client.js'
import type { RoadmapSnapshot, RoadmapInitiative, BoardRow, BoardProject } from '../types/roadmap.js'

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

    const [teams, projects, initiatives, syncMeta] = await Promise.all([
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
      prisma.initiative.findMany({
        orderBy: { sortOrder: 'asc' },
        include: { projects: true },
      }),
      prisma.syncMeta.findUnique({ where: { id: 1 } }),
    ])

    // Build a map for fast project lookup (used to derive initiative startDate)
    const projectById = new Map(projects.map((p) => [p.id, p]))

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
      initiatives: initiatives.map((i): RoadmapInitiative => {
        // Derive startDate as the earliest startDate among child projects
        const childStartDates = i.projects
          .map((p) => projectById.get(p.projectId)?.startDate)
          .filter((d): d is Date => d != null)
        const startDate = childStartDates.length > 0
          ? new Date(Math.min(...childStartDates.map((d) => d.getTime()))).toISOString()
          : null

        return {
          id: i.id,
          name: i.name,
          description: i.description,
          color: i.color,
          icon: i.icon,
          status: i.status,
          sortOrder: i.sortOrder,
          startDate,
          targetDate: i.targetDate?.toISOString() ?? null,
          slugId: i.slugId,
          projectIds: i.projects.map((p) => p.projectId),
        }
      }),
      board: initiatives.map((i): BoardRow => {
        const childStartDates = i.projects
          .map((link) => projectById.get(link.projectId)?.startDate)
          .filter((d): d is Date => d != null)
        const boardStartDate = childStartDates.length > 0
          ? new Date(Math.min(...childStartDates.map((d) => d.getTime()))).toISOString()
          : null

        const boardProjects: BoardProject[] = i.projects
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .flatMap((link) => {
            const p = projectById.get(link.projectId)
            if (!p) return []
            return [{
              id: p.id,
              name: p.name,
              color: p.color,
              state: p.state,
              icon: p.icon,
              progress: p.progress,
              startDate: p.startDate?.toISOString() ?? null,
              targetDate: p.targetDate?.toISOString() ?? null,
              url: p.url,
              milestones: p.milestones.map((m) => ({
                id: m.id,
                name: m.name,
                sortOrder: m.sortOrder,
                startDate: p.startDate?.toISOString() ?? null,
                targetDate: m.targetDate?.toISOString() ?? null,
                color: p.color,
              })),
            }]
          })

        return {
          id: i.id,
          name: i.name,
          description: i.description,
          color: i.color,
          icon: i.icon,
          status: i.status,
          startDate: boardStartDate,
          targetDate: i.targetDate?.toISOString() ?? null,
          projects: boardProjects,
        }
      }),
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
      prisma.initiative.count(),
    ])

    return {
      status: meta?.status ?? 'idle',
      lastSyncAt: meta?.lastSyncAt ?? null,
      error: meta?.error ?? null,
      counts: {
        teams: counts[0],
        projects: counts[1],
        issues: counts[2],
        initiatives: counts[3],
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
  startedAt: Date | null
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
    startedAt: issue.startedAt?.toISOString() ?? null,
    completedAt: issue.completedAt?.toISOString() ?? null,
    assigneeName: issue.assigneeName,
    url: issue.url,
    labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
  }
}
