import type { FastifyInstance } from "fastify";
import { prisma } from "../db/client.js";
import type { RoadmapSnapshot, RoadmapProject } from "../types/roadmap.js";

const ROADMAP_VIEW_ID = "27df73bc-50ec-4fc1-bbb2-d906236a5bbc"; // Community Roadmap view ID
//const ROADMAP_VIEW_ID = "4d167dd8-71a8-4258-9cfa-8f332d9c500d"; // Community Roadmap view ID
export async function roadmapRoutes(app: FastifyInstance) {
  /**
   * GET /api/roadmap.json
   *
   * Returns the full roadmap snapshot. This is what Astro sites fetch
   * at build time (SSG) or on each request (SSR).
   */
  app.get("/api/roadmap.json", async (_request, reply) => {
    const [teams, viewProjects, syncMeta] = await Promise.all([
      prisma.team.findMany({
        orderBy: { name: "asc" },
        include: { childTeams: true },
      }),
      prisma.customViewToProject.findMany({
        where: { viewId: ROADMAP_VIEW_ID },
        orderBy: { sortOrder: "asc" },
        include: {
          project: {
            include: {
              team: true,
              milestones: {
                orderBy: { sortOrder: "asc" },
                select: { id: true, name: true, targetDate: true },
              },
            },
          },
        },
      }),
      prisma.syncMeta.findUnique({ where: { id: 1 } }),
    ]);

    const projects: RoadmapProject[] = viewProjects
      .filter((link) => !link.project.name.includes("(Archived) "))
      .map((link) => {
        const p = link.project;
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          state: p.state,
          color: p.color,
          icon: p.icon,
          priority: p.priority,
          progress: p.progress,
          sortOrder: link.sortOrder,
          startDate: p.startDate?.toISOString() ?? null,
          targetDate: p.targetDate?.toISOString() ?? null,
          completedAt: p.completedAt?.toISOString() ?? null,
          url: p.url,
          team: p.team
            ? {
                id: p.team.id,
                name: p.team.name,
                key: p.team.key,
                color: p.team.color,
              }
            : null,
          milestones: p.milestones.map((m) => ({
            id: m.id,
            name: m.name,
            targetDate: m.targetDate?.toISOString() ?? null,
          })),
        };
      });

    const snapshot: RoadmapSnapshot = {
      generatedAt: new Date().toISOString(),
      lastSyncAt: syncMeta?.lastSyncAt.toISOString() ?? null,
      teams: teams.map((t) => ({
        id: t.id,
        name: t.name,
        key: t.key,
        color: t.color,
        childrenIds: t.childTeams.map((c) => c.childId),
        projectCount: projects.filter((p) => p.team?.id === t.id).length,
      })),
      projects,
    };

    reply.header("Content-Type", "application/json");
    reply.header("Cache-Control", "public, max-age=60");
    return snapshot;
  });

  /**
   * GET /api/status
   * Quick health check — shows sync status and last sync time.
   */
  app.get("/api/status", async () => {
    const meta = await prisma.syncMeta.findUnique({ where: { id: 1 } });
    const counts = await Promise.all([
      prisma.team.count(),
      prisma.project.count(),
      prisma.customViewToProject.count({ where: { viewId: ROADMAP_VIEW_ID } }),
    ]);

    return {
      status: meta?.status ?? "idle",
      lastSyncAt: meta?.lastSyncAt ?? null,
      error: meta?.error ?? null,
      counts: {
        teams: counts[0],
        projects: counts[1],
        viewProjects: counts[2],
      },
    };
  });
}
