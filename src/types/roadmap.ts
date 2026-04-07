// Shape of the JSON snapshot consumed by Astro sites

export interface RoadmapLabel {
  id: string
  name: string
  color: string | null
}

export interface RoadmapIssue {
  id: string
  title: string
  state: string
  stateName: string
  stateColor: string | null
  priority: number
  priorityName: string | null
  estimate: number | null
  dueDate: string | null
  completedAt: string | null
  assigneeName: string | null
  url: string | null
  labels: RoadmapLabel[]
}

export interface RoadmapMilestone {
  id: string
  name: string
  description: string | null
  targetDate: string | null
  sortOrder: number
  issues: RoadmapIssue[]
}

export interface RoadmapProject {
  id: string
  name: string
  description: string | null
  state: string
  color: string | null
  icon: string | null
  progress: number
  startDate: string | null
  targetDate: string | null
  url: string | null
  team: {
    id: string
    name: string
    key: string
    color: string | null
  } | null
  milestones: RoadmapMilestone[]
  issues: RoadmapIssue[]  // issues not attached to a milestone
}

export interface RoadmapTeam {
  id: string
  name: string
  key: string
  color: string | null
  projectCount: number
}

export interface RoadmapSnapshot {
  generatedAt: string
  lastSyncAt: string | null
  teams: RoadmapTeam[]
  projects: RoadmapProject[]
}
