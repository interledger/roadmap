import "dotenv/config";
import { linear } from "./client.js";
import { prisma } from "../db/client.js";

// ---------------------------------------------------------------------------
// Retry helper — retries transient API errors (5xx / network) with backoff
// ---------------------------------------------------------------------------

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as unknown as Record<string, unknown>).status;
  if (typeof status === "number" && status >= 500) return true;
  // GraphQL Error (Code: 5xx) message from Linear SDK
  if (/GraphQL Error \(Code: 5\d\d\)/.test(err.message)) return true;
  return false;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delayMs = 2000,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientError(err) || attempt === retries) throw err;
      lastErr = err;
      const wait = delayMs * 2 ** attempt;
      console.warn(
        `[sync] Transient API error (attempt ${attempt + 1}/${retries}), retrying in ${wait}ms...`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Concurrency guard — prevents multiple simultaneous syncs of the same type.
// If a sync is already running when a second request arrives, it sets a
// "pending" flag. After the running sync finishes, one more run is executed.
// This coalesces any number of queued requests into at most one follow-up run.
// ---------------------------------------------------------------------------

type SyncType = "teams" | "projects" | "initiatives" | "all";

const syncState = new Map<SyncType, { running: boolean; pending: boolean }>();

function getState(type: SyncType) {
  if (!syncState.has(type))
    syncState.set(type, { running: false, pending: false });
  return syncState.get(type)!;
}

async function runWithGuard(
  type: SyncType,
  fn: () => Promise<void>,
): Promise<void> {
  const state = getState(type);
  if (state.running) {
    state.pending = true;
    return;
  }
  state.running = true;
  state.pending = false;
  try {
    await fn();
  } finally {
    state.running = false;
    if (state.pending) {
      state.pending = false;
      setImmediate(() => runWithGuard(type, fn));
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
  return runWithGuard("all", async () => {
    console.log("[sync] Starting full Linear sync...");

    await prisma.syncMeta.upsert({
      where: { id: 1 },
      update: { status: "running", error: null },
      create: { id: 1, status: "running" },
    });

    try {
      await _syncProjects(); // also syncs teams first (FK dependency)
      await _syncInitiatives();

      await prisma.syncMeta.update({
        where: { id: 1 },
        data: { status: "idle", lastSyncAt: new Date() },
      });

      console.log("[sync] Done.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[sync] Error:", message);

      await prisma.syncMeta.update({
        where: { id: 1 },
        data: { status: "error", error: message },
      });

      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// Individual sync exports (guarded)
// ---------------------------------------------------------------------------

/** Sync only teams. */
export async function syncTeams(): Promise<void> {
  return runWithGuard("teams", _syncTeams);
}

/** Sync only projects and their milestones. */
export async function syncProjects(): Promise<void> {
  return runWithGuard("projects", _syncProjects);
}

/** Sync only initiatives (and their project associations). */
export async function syncInitiatives(): Promise<void> {
  return runWithGuard("initiatives", _syncInitiatives);
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
      completedAt
      progress
      url
      teams {
        nodes { id }
      }
      projectMilestones {
        nodes {
          id
          name
          description
          targetDate
          sortOrder
        }
      }
    }
  }
`;

type SingleProjectQueryResult = {
  project: {
    id: string;
    name: string;
    description: string | null;
    state: string;
    color: string | null;
    icon: string | null;
    startDate: string | null;
    targetDate: string | null;
    completedAt: string | null;
    progress: number;
    url: string;
    teams: { nodes: Array<{ id: string }> };
    projectMilestones: {
      nodes: Array<{
        id: string;
        name: string;
        description: string | null;
        targetDate: string | null;
        sortOrder: number;
      }>;
    };
  } | null;
};

/** Sync a single project (and its milestones) by ID. */
export async function syncSingleProject(id: string): Promise<void> {
  const result = await linear.client.request<SingleProjectQueryResult>(
    SINGLE_PROJECT_QUERY,
    { id },
  );
  console.log(`[sync] Syncing project ${id}...`);
  console.log(`[sync] Project data:`, JSON.stringify(result.project, null, 2));
  const project = result.project;
  if (!project) {
    console.log(`[sync] Project ${id} not found in Linear, skipping.`);
    return;
  }

  const teamId = project.teams.nodes[0]?.id ?? null;

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
      completedAt: project.completedAt ? new Date(project.completedAt) : null,
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
      completedAt: project.completedAt ? new Date(project.completedAt) : null,
      progress: project.progress ?? 0,
      url: project.url,
      teamId,
    },
  });

  const incomingMilestoneIds = new Set(project.projectMilestones.nodes.map((m) => m.id));
  for (const milestone of project.projectMilestones.nodes) {
    await prisma.milestone.upsert({
      where: { id: milestone.id },
      update: {
        name: milestone.name,
        description: milestone.description ?? null,
        targetDate: milestone.targetDate ? new Date(milestone.targetDate) : null,
        sortOrder: milestone.sortOrder ?? 0,
        projectId: project.id,
      },
      create: {
        id: milestone.id,
        name: milestone.name,
        description: milestone.description ?? null,
        targetDate: milestone.targetDate ? new Date(milestone.targetDate) : null,
        sortOrder: milestone.sortOrder ?? 0,
        projectId: project.id,
      },
    });
  }
  await prisma.milestone.deleteMany({
    where: { projectId: project.id, id: { notIn: [...incomingMilestoneIds] } },
  });

  console.log(`[sync] Upserted project ${project.id}.`);
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
`;

type SingleInitiativeQueryResult = {
  initiative: {
    id: string;
    name: string;
    description: string | null;
    color: string | null;
    icon: string | null;
    status: string;
    sortOrder: number;
    targetDate: string | null;
    slugId: string | null;
    projects: { nodes: Array<{ id: string; sortOrder: number }> };
  } | null;
};

/** Sync a single initiative (and its project associations) by ID. */
export async function syncSingleInitiative(id: string): Promise<void> {
  const result = await linear.client.request<SingleInitiativeQueryResult>(
    SINGLE_INITIATIVE_QUERY,
    { id },
  );

  console.log(`[sync] Syncing initiative ${id}...`);
  console.log(
    `[sync] Initiative data:`,
    JSON.stringify(result.initiative, null, 2),
  );
  const initiative = result.initiative;
  if (!initiative) {
    console.log(`[sync] Initiative ${id} not found in Linear, skipping.`);
    return;
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
      targetDate: initiative.targetDate
        ? new Date(initiative.targetDate)
        : null,
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
      targetDate: initiative.targetDate
        ? new Date(initiative.targetDate)
        : null,
      slugId: initiative.slugId ?? null,
    },
  });

  const incomingProjectIds = new Set(
    initiative.projects.nodes.map((p) => p.id),
  );

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
    });
  }

  await prisma.initiativeToProject.deleteMany({
    where: {
      initiativeId: initiative.id,
      projectId: { notIn: [...incomingProjectIds] },
    },
  });

  console.log(`[sync] Upserted initiative ${initiative.id}.`);
}

const SINGLE_MILESTONE_QUERY = `
  query SyncSingleMilestone($id: String!) {
    projectMilestone(id: $id) {
      id
      name
      description
      targetDate
      sortOrder
      project { id }
    }
  }
`;

type SingleMilestoneQueryResult = {
  projectMilestone: {
    id: string;
    name: string;
    description: string | null;
    targetDate: string | null;
    sortOrder: number;
    project: { id: string };
  } | null;
};

/** Sync a single milestone by ID. */
export async function syncSingleMilestone(id: string): Promise<void> {
  const result = await linear.client.request<SingleMilestoneQueryResult>(
    SINGLE_MILESTONE_QUERY,
    { id },
  );

  const milestone = result.projectMilestone;
  if (!milestone) {
    console.log(`[sync] Milestone ${id} not found in Linear, skipping.`);
    return;
  }

  await prisma.milestone.upsert({
    where: { id: milestone.id },
    update: {
      name: milestone.name,
      description: milestone.description ?? null,
      targetDate: milestone.targetDate ? new Date(milestone.targetDate) : null,
      sortOrder: milestone.sortOrder ?? 0,
      projectId: milestone.project.id,
    },
    create: {
      id: milestone.id,
      name: milestone.name,
      description: milestone.description ?? null,
      targetDate: milestone.targetDate ? new Date(milestone.targetDate) : null,
      sortOrder: milestone.sortOrder ?? 0,
      projectId: milestone.project.id,
    },
  });

  console.log(`[sync] Upserted milestone ${milestone.id}.`);
}

// ---------------------------------------------------------------------------
// Single-entity team sync
// ---------------------------------------------------------------------------

const SINGLE_TEAM_QUERY = `
  query SyncSingleTeam($id: String!) {
    team(id: $id) {
      id
      name
      key
      description
      color
      children { id }
    }
  }
`;

type SingleTeamQueryResult = {
  team: {
    id: string;
    name: string;
    key: string;
    description: string | null;
    color: string | null;
    children: Array<{ id: string }>;
  } | null;
};

/** Sync a single team by ID. */
export async function syncSingleTeam(id: string): Promise<void> {
  const result = await linear.client.request<SingleTeamQueryResult, { id: string }>(
    SINGLE_TEAM_QUERY,
    { id },
  );
  console.log(`[sync] Syncing team ${id}...`);
  console.log(`[sync] Team data:`, JSON.stringify(result.team, null, 2));
  const team = result.team;
  if (!team) {
    console.log(`[sync] Team ${id} not found in Linear, skipping.`);
    return;
  }

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
  });

  // Sync children relationships.
  const childIds = team.children.map((c) => c.id);
  for (const childId of childIds) {
    await prisma.teamChildren.upsert({
      where: { parentId_childId: { parentId: team.id, childId } },
      update: {},
      create: { parentId: team.id, childId },
    });
  }
  if (childIds.length > 0) {
    await prisma.teamChildren.deleteMany({
      where: { parentId: team.id, childId: { notIn: childIds } },
    });
  } else {
    await prisma.teamChildren.deleteMany({ where: { parentId: team.id } });
  }

  console.log(`[sync] Upserted team ${team.id}.`);
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
        children { id }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

type TeamsQueryResult = {
  teams: {
    nodes: Array<{
      id: string;
      name: string;
      key: string;
      description: string | null;
      color: string | null;
      children: Array<{ id: string }>;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

async function _syncTeams() {
  console.log("[sync] Fetching teams...");

  let hasNextPage = true;
  let endCursor: string | undefined;
  const allTeams: TeamsQueryResult["teams"]["nodes"] = [];

  while (hasNextPage) {
    const result = await linear.client.request<TeamsQueryResult>(TEAMS_QUERY, {
      first: 50,
      after: endCursor ?? null,
    });

    const { nodes: teams, pageInfo } = result.teams;
    allTeams.push(...teams);

    hasNextPage = pageInfo.hasNextPage;
    endCursor = pageInfo.endCursor ?? undefined;
  }

  // Pass 1: upsert all team records first so FK references are valid in pass 2.
  for (const team of allTeams) {
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
    });
  }

  // Pass 2: sync TeamChildren join records for each parent team.
  // Only reference child IDs that were actually synced to avoid FK violations
  // (Linear may return children that are archived or otherwise excluded).
  const syncedIds = new Set(allTeams.map((t) => t.id));

  for (const team of allTeams) {
    const childIds = team.children.map((c) => c.id).filter((id) => syncedIds.has(id));

    // Upsert each child relationship.
    for (const childId of childIds) {
      await prisma.teamChildren.upsert({
        where: { parentId_childId: { parentId: team.id, childId } },
        update: {},
        create: { parentId: team.id, childId },
      });
    }

    // Remove stale children no longer present in Linear.
    if (childIds.length > 0) {
      await prisma.teamChildren.deleteMany({
        where: { parentId: team.id, childId: { notIn: childIds } },
      });
    } else {
      await prisma.teamChildren.deleteMany({ where: { parentId: team.id } });
    }
  }

  console.log(`[sync] Upserted ${allTeams.length} teams.`);
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
        completedAt
        progress
        url
        teams {
          nodes { id }
        }
        projectMilestones {
          nodes {
            id
            name
            description
            targetDate
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
`;

type ProjectsQueryResult = {
  projects: {
    nodes: Array<{
      id: string;
      name: string;
      description: string | null;
      state: string;
      color: string | null;
      icon: string | null;
      startDate: string | null;
      targetDate: string | null;
      completedAt: string | null;
      progress: number;
      url: string;
      teams: { nodes: Array<{ id: string }> };
      projectMilestones: {
        nodes: Array<{
          id: string;
          name: string;
          description: string | null;
          targetDate: string | null;
          sortOrder: number;
        }>;
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

async function _syncProjects() {
  // Teams must exist before projects due to the FK constraint on teamId
  await _syncTeams();

  console.log("[sync] Fetching projects...");

  let hasNextPage = true;
  let endCursor: string | undefined;
  let total = 0;

  while (hasNextPage) {
    const result = await linear.client.request<ProjectsQueryResult>(
      PROJECTS_QUERY,
      { first: 50, after: endCursor ?? null },
    );

    const { nodes: projects, pageInfo } = result.projects;

    for (const project of projects) {
      const teamId = project.teams.nodes[0]?.id ?? null;

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
          completedAt: project.completedAt ? new Date(project.completedAt) : null,
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
          completedAt: project.completedAt ? new Date(project.completedAt) : null,
          progress: project.progress ?? 0,
          url: project.url,
          teamId,
        },
      });

      // Upsert milestones inline — no extra API call needed
      const incomingMilestoneIds = new Set(project.projectMilestones.nodes.map((m) => m.id));
      for (const milestone of project.projectMilestones.nodes) {
        await prisma.milestone.upsert({
          where: { id: milestone.id },
          update: {
            name: milestone.name,
            description: milestone.description ?? null,
            targetDate: milestone.targetDate ? new Date(milestone.targetDate) : null,
            sortOrder: milestone.sortOrder ?? 0,
            projectId: project.id,
          },
          create: {
            id: milestone.id,
            name: milestone.name,
            description: milestone.description ?? null,
            targetDate: milestone.targetDate ? new Date(milestone.targetDate) : null,
            sortOrder: milestone.sortOrder ?? 0,
            projectId: project.id,
          },
        });
      }
      // Remove milestones that no longer exist in Linear
      await prisma.milestone.deleteMany({
        where: { projectId: project.id, id: { notIn: [...incomingMilestoneIds] } },
      });
    }

    total += projects.length;
    hasNextPage = pageInfo.hasNextPage;
    endCursor = pageInfo.endCursor ?? undefined;
  }

  console.log(`[sync] Upserted ${total} projects.`);
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
`;

type InitiativesQueryResult = {
  initiatives: {
    nodes: Array<{
      id: string;
      name: string;
      description: string | null;
      color: string | null;
      icon: string | null;
      status: string;
      sortOrder: number;
      targetDate: string | null;
      slugId: string | null;
      projects: { nodes: Array<{ id: string; sortOrder: number }> };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

async function _syncInitiatives() {
  console.log("[sync] Fetching initiatives...");

  let hasNextPage = true;
  let endCursor: string | undefined;
  let total = 0;

  while (hasNextPage) {
    const result = await linear.client.request<InitiativesQueryResult>(
      INITIATIVES_QUERY,
      { first: 50, after: endCursor ?? null },
    );

    const { nodes: initiatives, pageInfo } = result.initiatives;

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
          targetDate: initiative.targetDate
            ? new Date(initiative.targetDate)
            : null,
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
          targetDate: initiative.targetDate
            ? new Date(initiative.targetDate)
            : null,
          slugId: initiative.slugId ?? null,
        },
      });

      // Sync project associations — upsert each join row, then prune stale ones
      const incomingProjectIds = new Set(
        initiative.projects.nodes.map((p) => p.id),
      );

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
        });
      }

      // Delete join rows that are no longer present in Linear
      await prisma.initiativeToProject.deleteMany({
        where: {
          initiativeId: initiative.id,
          projectId: { notIn: [...incomingProjectIds] },
        },
      });
    }

    total += initiatives.length;
    hasNextPage = pageInfo.hasNextPage;
    endCursor = pageInfo.endCursor ?? undefined;
  }

  console.log(`[sync] Upserted ${total} initiatives.`);
}

// ---------------------------------------------------------------------------
// Trigger Astro site rebuilds via deploy hooks
// ---------------------------------------------------------------------------

export async function triggerDeploys() {
  const hooks = [
    process.env.DEPLOY_HOOK_SITE_1,
    process.env.DEPLOY_HOOK_SITE_2,
  ].filter(Boolean) as string[];

  if (hooks.length === 0) {
    console.log("[deploy] No deploy hooks configured, skipping.");
    return;
  }

  await Promise.allSettled(
    hooks.map(async (hook) => {
      try {
        const res = await fetch(hook, { method: "POST" });
        console.log(`[deploy] Hook triggered: ${hook} → ${res.status}`);
      } catch (err) {
        console.error(`[deploy] Hook failed: ${hook}`, err);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Run directly: pnpm sync
// ---------------------------------------------------------------------------

if (import.meta.url === new URL(process.argv[1], "file://").href) {
  await syncAll();
  await triggerDeploys();
  await prisma.$disconnect();
}
