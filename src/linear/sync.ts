import 'dotenv/config'
import { linear } from './client.js'
import { prisma } from '../db/client.js'

// ---------------------------------------------------------------------------
// Concurrency guard — prevents multiple simultaneous syncs of the same type.
// If a sync is already running when a second request arrives, it sets a
// "pending" flag. After the running sync finishes, one more run is executed.
// This coalesces any number of queued requests into at most one follow-up run.
// ---------------------------------------------------------------------------

type SyncType = 'teams' | 'projects' | 'issues' | 'initiatives' | 'all'

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
      await _syncProjects() // also syncs teams first (FK dependency)
      await _syncIssues()
      await _syncInitiatives()

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

/** Sync only initiatives (and their project associations). */
export async function syncInitiatives(): Promise<void> {
  return runWithGuard('initiatives', _syncInitiatives)
}

// ---------------------------------------------------------------------------
// Single-entity syncs — called from webhook handler when we have an entity ID
// ---------------------------------------------------------------------------

const SINGLE_PROJECT_QUERY = `
  query SyncSingleProject($id: String!) {
    project(id: $id) {
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
  }
`

type SingleProjectQueryResult = {
  project: {
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
  } | null
}

/** Sync a single project (and its milestones) by ID. */
export async function syncSingleProject(id: string): Promise<void> {
  const result = await linear.client.request<SingleProjectQueryResult>(
    SINGLE_PROJECT_QUERY,
    { id },
  )

  const project = result.project
  if (!project) {
    console.log(`[sync] Project ${id} not found in Linear, skipping.`)
    return
  }

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
  console.log(`[sync] Upserted project ${project.id}.`)
}

/** Sync a single issue (and its labels) by ID. */
export async function syncSingleIssue(id: string): Promise<void> {
  const issue = await linear.issue(id)
  if (!issue) {
    console.log(`[sync] Issue ${id} not found in Linear, skipping.`)
    return
  }

  const state = await issue.state
  const assignee = await issue.assignee
  const issueLabels = await issue.labels()
  const projectId = (await issue.project)?.id ?? null
  const milestoneId = (await issue.projectMilestone)?.id ?? null

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
      startedAt: issue.startedAt ?? null,
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
      startedAt: issue.startedAt ?? null,
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

  console.log(`[sync] Upserted issue ${issue.id}.`)
}

const SINGLE_INITIATIVE_QUERY = `
  query SyncSingleInitiative($id: String!) {
    initiative(id: $id) {
      id
      name
      description
      color
      icon
      status
      sortOrder
      targetDate
      slugId
      projects {
        nodes {
          id
          sortOrder
        }
      }
    }
  }
`

type SingleInitiativeQueryResult = {
  initiative: {
    id: string
    name: string
    description: string | null
    color: string | null
    icon: string | null
    status: string
    sortOrder: number
    targetDate: string | null
    slugId: string | null
    projects: { nodes: Array<{ id: string; sortOrder: number }> }
  } | null
}

/** Sync a single initiative (and its project associations) by ID. */
export async function syncSingleInitiative(id: string): Promise<void> {
  const result = await linear.client.request<SingleInitiativeQueryResult>(
    SINGLE_INITIATIVE_QUERY,
    { id },
  )

  const initiative = result.initiative
  if (!initiative) {
    console.log(`[sync] Initiative ${id} not found in Linear, skipping.`)
    return
  }

  await prisma.initiative.upsert({
    where: { id: initiative.id },
    update: {
      name: initiative.name,
      description: initiative.description ?? null,
      color: initiative.color ?? null,
      icon: initiative.icon ?? null,
      status: initiative.status.toLowerCase(),
      sortOrder: initiative.sortOrder ?? 0,
      targetDate: initiative.targetDate ? new Date(initiative.targetDate) : null,
      slugId: initiative.slugId ?? null,
    },
    create: {
      id: initiative.id,
      name: initiative.name,
      description: initiative.description ?? null,
      color: initiative.color ?? null,
      icon: initiative.icon ?? null,
      status: initiative.status.toLowerCase(),
      sortOrder: initiative.sortOrder ?? 0,
      targetDate: initiative.targetDate ? new Date(initiative.targetDate) : null,
      slugId: initiative.slugId ?? null,
    },
  })

  const incomingProjectIds = new Set(initiative.projects.nodes.map((p) => p.id))

  for (const projectNode of initiative.projects.nodes) {
    await prisma.initiativeToProject.upsert({
      where: {
        initiativeId_projectId: {
          initiativeId: initiative.id,
          projectId: projectNode.id,
        },
      },
      update: { sortOrder: projectNode.sortOrder ?? 0 },
      create: {
        id: `${initiative.id}:${projectNode.id}`,
        initiativeId: initiative.id,
        projectId: projectNode.id,
        sortOrder: projectNode.sortOrder ?? 0,
      },
    })
  }

  await prisma.initiativeToProject.deleteMany({
    where: {
      initiativeId: initiative.id,
      projectId: { notIn: [...incomingProjectIds] },
    },
  })

  console.log(`[sync] Upserted initiative ${initiative.id}.`)
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

const TEAMS_QUERY = `
  query SyncTeams($first: Int!, $after: String) {
    teams(first: $first, after: $after) {
      nodes {
        id
        name
        key
        description
        color
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

type TeamsQueryResult = {
  teams: {
    nodes: Array<{
      id: string
      name: string
      key: string
      description: string | null
      color: string | null
    }>
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
  }
}

async function _syncTeams() {
  console.log('[sync] Fetching teams...')

  let hasNextPage = true
  let endCursor: string | undefined
  let total = 0

  while (hasNextPage) {
    const result = await linear.client.request<TeamsQueryResult>(
      TEAMS_QUERY,
      { first: 50, after: endCursor ?? null },
    )

    const { nodes: teams, pageInfo } = result.teams

    for (const team of teams) {
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

    total += teams.length
    hasNextPage = pageInfo.hasNextPage
    endCursor = pageInfo.endCursor ?? undefined
  }

  console.log(`[sync] Upserted ${total} teams.`)
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
  // Teams must exist before projects due to the FK constraint on teamId
  await _syncTeams()

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
          startedAt: issue.startedAt ?? null,
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
          startedAt: issue.startedAt ?? null,
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
// Initiatives
// ---------------------------------------------------------------------------

const INITIATIVES_QUERY = `
  query SyncInitiatives($first: Int!, $after: String) {
    initiatives(first: $first, after: $after) {
      nodes {
        id
        name
        description
        color
        icon
        status
        sortOrder
        targetDate
        slugId
        projects {
          nodes {
            id
            sortOrder
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

type InitiativesQueryResult = {
  initiatives: {
    nodes: Array<{
      id: string
      name: string
      description: string | null
      color: string | null
      icon: string | null
      status: string
      sortOrder: number
      targetDate: string | null
      slugId: string | null
      projects: { nodes: Array<{ id: string; sortOrder: number }> }
    }>
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
  }
}

async function _syncInitiatives() {
  console.log('[sync] Fetching initiatives...')

  let hasNextPage = true
  let endCursor: string | undefined
  let total = 0

  while (hasNextPage) {
    const result = await linear.client.request<InitiativesQueryResult>(
      INITIATIVES_QUERY,
      { first: 50, after: endCursor ?? null },
    )

    const { nodes: initiatives, pageInfo } = result.initiatives

    for (const initiative of initiatives) {
      await prisma.initiative.upsert({
        where: { id: initiative.id },
        update: {
          name: initiative.name,
          description: initiative.description ?? null,
          color: initiative.color ?? null,
          icon: initiative.icon ?? null,
          status: initiative.status.toLowerCase(),
          sortOrder: initiative.sortOrder ?? 0,
          targetDate: initiative.targetDate ? new Date(initiative.targetDate) : null,
          slugId: initiative.slugId ?? null,
        },
        create: {
          id: initiative.id,
          name: initiative.name,
          description: initiative.description ?? null,
          color: initiative.color ?? null,
          icon: initiative.icon ?? null,
          status: initiative.status.toLowerCase(),
          sortOrder: initiative.sortOrder ?? 0,
          targetDate: initiative.targetDate ? new Date(initiative.targetDate) : null,
          slugId: initiative.slugId ?? null,
        },
      })

      // Sync project associations — upsert each join row, then prune stale ones
      const incomingProjectIds = new Set(initiative.projects.nodes.map((p) => p.id))

      for (const projectNode of initiative.projects.nodes) {
        await prisma.initiativeToProject.upsert({
          where: {
            initiativeId_projectId: {
              initiativeId: initiative.id,
              projectId: projectNode.id,
            },
          },
          update: { sortOrder: projectNode.sortOrder ?? 0 },
          create: {
            id: `${initiative.id}:${projectNode.id}`,
            initiativeId: initiative.id,
            projectId: projectNode.id,
            sortOrder: projectNode.sortOrder ?? 0,
          },
        })
      }

      // Delete join rows that are no longer present in Linear
      await prisma.initiativeToProject.deleteMany({
        where: {
          initiativeId: initiative.id,
          projectId: { notIn: [...incomingProjectIds] },
        },
      })
    }

    total += initiatives.length
    hasNextPage = pageInfo.hasNextPage
    endCursor = pageInfo.endCursor ?? undefined
  }

  console.log(`[sync] Upserted ${total} initiatives.`)
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
