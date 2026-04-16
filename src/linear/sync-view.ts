import "dotenv/config";
import { Prisma } from "@prisma/client";
import { linear } from "./client.js";
import { prisma } from "../db/client.js";

const CUSTOM_VIEW_QUERY = `
  query SyncCustomView($id: String!, $after: String) {
    customView(id: $id) {
      id
      name
      description
      icon
      color
      modelName
      filterData
      owner { id name }
      team { id name key }
      projects(first: 50, after: $after) {
        nodes {
          id
          name
          description
          state
          priority
          startDate
          targetDate
          completedAt
          progress
          url
          sortOrder
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

type ProjectNode = {
  id: string;
  name: string;
  description: string | null;
  state: string;
  priority: number;
  startDate: string | null;
  targetDate: string | null;
  completedAt: string | null;
  progress: number;
  url: string | null;
  sortOrder: number;
};

type ViewMeta = {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  modelName: string | null;
  filterData: Prisma.InputJsonValue | null;
  owner: { id: string; name: string } | null;
  team: { id: string; name: string; key: string } | null;
};

type CustomViewQueryResult = {
  customView:
    | (ViewMeta & {
        projects: {
          nodes: ProjectNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      })
    | null;
};

async function syncView(viewId: string): Promise<void> {
  console.log(`[sync-view] Syncing view ${viewId}...`);

  const allProjects: ProjectNode[] = [];
  let viewMeta: ViewMeta | null = null;
  let hasNextPage = true;
  let endCursor: string | null = null;

  while (hasNextPage) {
    const result = (await linear.client.request(
      CUSTOM_VIEW_QUERY,
      { id: viewId, after: endCursor },
    )) as CustomViewQueryResult;

    if (!result.customView) {
      console.error(`[sync-view] View ${viewId} not found in Linear.`);
      process.exit(1);
    }

    const { projects, ...meta } = result.customView;
    if (!viewMeta) viewMeta = meta;

    allProjects.push(...projects.nodes);
    hasNextPage = projects.pageInfo.hasNextPage;
    endCursor = projects.pageInfo.endCursor;
  }

  console.log(
    `[sync-view] Fetched ${allProjects.length} projects from view "${viewMeta!.name}".`,
  );

  const view = viewMeta!;

  // Upsert the view record
  const viewData = {
    name: view.name,
    description: view.description ?? null,
    icon: view.icon ?? null,
    color: view.color ?? null,
    modelName: view.modelName ?? null,
    filterData: view.filterData ?? Prisma.JsonNull,
    ownerId: view.owner?.id ?? null,
    ownerName: view.owner?.name ?? null,
    teamId: view.team?.id ?? null,
  };

  await prisma.customView.upsert({
    where: { id: viewId },
    update: viewData,
    create: { id: viewId, ...viewData },
  });

  // Upsert each project, then the view-project join record
  const incomingProjectIds: string[] = allProjects.map((p) => p.id);

  for (const project of allProjects) {
    const projectData = {
      name: project.name,
      description: project.description ?? null,
      state: project.state,
      priority: project.priority ?? 0,
      startDate: project.startDate ? new Date(project.startDate) : null,
      targetDate: project.targetDate ? new Date(project.targetDate) : null,
      completedAt: project.completedAt ? new Date(project.completedAt) : null,
      progress: project.progress ?? 0,
      url: project.url ?? null,
    };

    await prisma.project.upsert({
      where: { id: project.id },
      update: projectData,
      create: { id: project.id, ...projectData },
    });

    await prisma.customViewToProject.upsert({
      where: { viewId_projectId: { viewId, projectId: project.id } },
      update: { sortOrder: project.sortOrder ?? 0 },
      create: {
        id: `${viewId}:${project.id}`,
        viewId,
        projectId: project.id,
        sortOrder: project.sortOrder ?? 0,
      },
    });
  }

  // Remove projects no longer in the view
  await prisma.customViewToProject.deleteMany({
    where: {
      viewId,
      projectId: { notIn: incomingProjectIds },
    },
  });

  console.log(
    `[sync-view] Done. Upserted view "${view.name}" with ${allProjects.length} projects.`,
  );
}

async function main() {
  const viewId = process.argv[2];
  if (!viewId) {
    console.error("Usage: pnpm sync:view <view-id>");
    process.exit(1);
  }

  try {
    await syncView(viewId);
  } catch (err) {
    console.error("[sync-view] Error:", err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
