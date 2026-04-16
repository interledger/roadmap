// Shape of the JSON snapshot consumed by Astro sites

export interface RoadmapTeam {
  id: string
  name: string
  key: string
  color: string | null
  childrenIds: string[]
  projectCount: number
}

export interface RoadmapMilestone {
  id: string
  name: string
  targetDate: string | null
}

export interface RoadmapProject {
  id: string
  name: string
  description: string | null
  state: string
  color: string | null
  icon: string | null
  priority: number
  progress: number
  sortOrder: number
  startDate: string | null
  targetDate: string | null
  completedAt: string | null
  url: string | null
  team: {
    id: string
    name: string
    key: string
    color: string | null
  } | null
  milestones: RoadmapMilestone[]
}

export interface RoadmapSnapshot {
  generatedAt: string
  lastSyncAt: string | null
  teams: RoadmapTeam[]
  projects: RoadmapProject[]
}
