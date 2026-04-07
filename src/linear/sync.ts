import 'dotenv/config'
import { linear } from './client.js'
import { prisma } from '../db/client.js'

// ---------------------------------------------------------------------------
// Concurrency guard — prevents multiple simultaneous syncs of the same type.
// If a sync is already running when a second request arrives, it sets a
// "pending" flag. After the running sync finishes, one more run is executed.
// This coalesces any number of queued requests into at most one follow-up run.
// ---------------------------------------------------------------------------

type SyncType = 'teams' | 'projects' | 'issues' | 'all'

const syncState = new Map<SyncType, { running: boolean; pending: boolean }>()

function getState(type: SyncType) {
  if (!syncState.has(type)) syncState.set(type, { running: false, pending: false })
  return syncState.get(type)!
}

async function runWithGuard(type: SyncType, fn: () => Promise<void>): Promise<void> {
  const state = getState(type)
  if (state.running) {
    state.pending = true
    return
  }
  state.running = true
  state.pending = false
  try {
    await fn()
  } finally {
    state.running = false
    if (state.pending) {
      state.pending = false
      setImmediate(() => runWithGuard(type, fn))
    }
  }
}

// ---------------------------------------------------------------------------
// Full sync
// ---------------------------------------------------------------------------

/**
 * Full sync: fetches all teams, projects, milestones, and issues from Linear
 * and upserts them into PostgreSQL.
 *
 * Safe to run multiple times — all operations are upserts.
 */
export async function syncAll(): Promise<void> {
  return runWithGuard('all', async () => {
    console.log('[sync] Starting full Linear sync...')

    await prisma.syncMeta.upsert({
      where: { id: 1 },
      update: { status: 'running', error: null },
      create: { id: 1, status: 'running' },
    })

    try {
      await _syncTeams()
      await _syncProjects()
      await _syncIssues()

      await prisma.syncMeta.update({
        where: { id: 1 },
        data: { status: 'idle', lastSyncAt: new Date() },
      })

      console.log('[sync] Done.')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[sync] Error:', message)

      await prisma.syncMeta.update({
        where: { id: 1 },
        data: { status: 'error', error: message },
      })

      throw err
    }
  })
}

// ---------------------------------------------------------------------------
// Individual sync exports (guarded)
// ---------------------------------------------------------------------------

/** Sync only teams. */
export async function syncTeams(): Promise<void> {
  return runWithGuard('teams', _syncTeams)
}

/** Sync only projects and their milestones. */
export async function syncProjects(): Promise<void> {
  return runWithGuard('projects', _syncProjects)
}

/** Sync only issues (and their labels). */
export async function syncIssues(): Promise<void> {
  return runWithGuard('issues', _syncIssues)
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

async function _syncTeams() {
  console.log('[sync] Fetching teams...')
  const teams = await linear.teams()

  for (const team of teams.nodes) {
    await prisma.team.upsert({
      where: { id: team.id },
      update: {
        name: team.name,
        key: team.key,
        description: team.description ?? null,
        color: team.color ?? null,
      },
      create: {
        id: team.id,
        name: team.name,
        key: team.key,
        description: team.description ?? null,
        color: team.color ?? null,
      },
    })
  }

  console.log(`[sync] Upserted ${teams.nodes.length} teams.`)
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

// Minimal raw query — avoids the SDK's full Team fragment which requires a
// userId argument for the `membership` field (breaking change in SDK v25+).
// Also eliminates the N+1 of calling project.teams() per project.
const PROJECTS_QUERY = `
  query SyncProjects($first: Int!, $after: String) {
    projects(first: $first, after: $after) {
      nodes {
        id
        name
        description
        state
        color
        icon
        startDate
        targetDate
        progress
        url
        teams {
          nodes { id }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

type ProjectsQueryResult = {
  projects: {
    nodes: Array<{
      id: string
      name: string
      description: string | null
      state: string
      color: string | null
      icon: string | null
      startDate: string | null
      targetDate: string | null
      progress: number
      url: string
      teams: { nodes: Array<{ id: string }> }
    }>
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
  }
}

async function _syncProjects() {
  console.log('[sync] Fetching projects...')

  let hasNextPage = true
  let endCursor: string | undefined
  let total = 0

  while (hasNextPage) {
    const result = await linear.client.request<ProjectsQueryResult>(
      PROJECTS_QUERY,
      { first: 50, after: endCursor ?? null },
    )

    const { nodes: projects, pageInfo } = result.projects

    for (const project of projects) {
      const teamId = project.teams.nodes[0]?.id ?? null

      await prisma.project.upsert({
        where: { id: project.id },
        update: {
          name: project.name,
          description: project.description ?? null,
          state: project.state,
          color: project.color ?? null,
          icon: project.icon ?? null,
          startDate: project.startDate ? new Date(project.startDate) : null,
          targetDate: project.targetDate ? new Date(project.targetDate) : null,
          progress: project.progress ?? 0,
          url: project.url,
          teamId,
        },
        create: {
          id: project.id,
          name: project.name,
          description: project.description ?? null,
          state: project.state,
          color: project.color ?? null,
          icon: project.icon ?? null,
          startDate: project.startDate ? new Date(project.startDate) : null,
          targetDate: project.targetDate ? new Date(project.targetDate) : null,
          progress: project.progress ?? 0,
          url: project.url,
          teamId,
        },
      })

      await syncMilestonesForProject(project.id)
    }

    total += projects.length
    hasNextPage = pageInfo.hasNextPage
    endCursor = pageInfo.endCursor ?? undefined
  }

  console.log(`[sync] Upserted ${total} projects.`)
}

async function syncMilestonesForProject(projectId: string) {
  const project = await linear.project(projectId)
  const milestones = await project.projectMilestones()

  for (const milestone of milestones.nodes) {
    await prisma.milestone.upsert({
      where: { id: milestone.id },
      update: {
        name: milestone.name,
        description: milestone.description ?? null,
        targetDate: milestone.targetDate ? new Date(milestone.targetDate) : null,
        sortOrder: milestone.sortOrder ?? 0,
        projectId,
      },
      create: {
        id: milestone.id,
        name: milestone.name,
        description: milestone.description ?? null,
        targetDate: milestone.targetDate ? new Date(milestone.targetDate) : null,
        sortOrder: milestone.sortOrder ?? 0,
        projectId,
      },
    })
  }
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

async function _syncIssues() {
  console.log('[sync] Fetching issues...')

  let hasNextPage = true
  let endCursor: string | undefined
  let total = 0

  while (hasNextPage) {
    const issues = await linear.issues({
      first: 100,
      after: endCursor,
      filter: {
        // Only fetch issues attached to a project so they're roadmap-relevant
        project: { null: false },
      },
    })

    for (const issue of issues.nodes) {
      const state = await issue.state
      const assignee = await issue.assignee
      const issueLabels = await issue.labels()
      const projectId = (await issue.project)?.id ?? null
      const milestoneId = (await issue.projectMilestone)?.id ?? null

      // Upsert labels
      const labelIds: string[] = []
      for (const label of issueLabels.nodes) {
        await prisma.label.upsert({
          where: { id: label.id },
          update: { name: label.name, color: label.color ?? null },
          create: { id: label.id, name: label.name, color: label.color ?? null },
        })
        labelIds.push(label.id)
      }

      await prisma.issue.upsert({
        where: { id: issue.id },
        update: {
          title: issue.title,
          description: issue.description ?? null,
          state: state?.type ?? 'unstarted',
          stateName: state?.name ?? '',
          stateColor: state?.color ?? null,
          stateType: state?.type ?? null,
          priority: issue.priority ?? 0,
          priorityName: issue.priorityLabel,
          estimate: issue.estimate ?? null,
          dueDate: issue.dueDate ? new Date(issue.dueDate) : null,
          completedAt: issue.completedAt ? new Date(issue.completedAt) : null,
          cancelledAt: issue.cancelledAt ? new Date(issue.cancelledAt) : null,
          url: issue.url,
          projectId,
          milestoneId,
          assigneeId: assignee?.id ?? null,
          assigneeName: assignee?.name ?? null,
          labels: { set: labelIds.map((id) => ({ id })) },
        },
        create: {
          id: issue.id,
          title: issue.title,
          description: issue.description ?? null,
          state: state?.type ?? 'unstarted',
          stateName: state?.name ?? '',
          stateColor: state?.color ?? null,
          stateType: state?.type ?? null,
          priority: issue.priority ?? 0,
          priorityName: issue.priorityLabel,
          estimate: issue.estimate ?? null,
          dueDate: issue.dueDate ? new Date(issue.dueDate) : null,
          completedAt: issue.completedAt ? new Date(issue.completedAt) : null,
          cancelledAt: issue.cancelledAt ? new Date(issue.cancelledAt) : null,
          url: issue.url,
          projectId,
          milestoneId,
          assigneeId: assignee?.id ?? null,
          assigneeName: assignee?.name ?? null,
          labels: { connect: labelIds.map((id) => ({ id })) },
        },
      })
    }

    total += issues.nodes.length
    hasNextPage = issues.pageInfo.hasNextPage
    endCursor = issues.pageInfo.endCursor ?? undefined
  }

  console.log(`[sync] Upserted ${total} issues.`)
}

// ---------------------------------------------------------------------------
// Trigger Astro site rebuilds via deploy hooks
// ---------------------------------------------------------------------------

export async function triggerDeploys() {
  const hooks = [
    process.env.DEPLOY_HOOK_SITE_1,
    process.env.DEPLOY_HOOK_SITE_2,
  ].filter(Boolean) as string[]

  if (hooks.length === 0) {
    console.log('[deploy] No deploy hooks configured, skipping.')
    return
  }

  await Promise.allSettled(
    hooks.map(async (hook) => {
      try {
        const res = await fetch(hook, { method: 'POST' })
        console.log(`[deploy] Hook triggered: ${hook} → ${res.status}`)
      } catch (err) {
        console.error(`[deploy] Hook failed: ${hook}`, err)
      }
    })
  )
}

// ---------------------------------------------------------------------------
// Run directly: pnpm sync
// ---------------------------------------------------------------------------

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  await syncAll()
  await triggerDeploys()
  await prisma.$disconnect()
}
