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
  startedAt: string | null
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
  childrenIds: string[]
  projectCount: number
}

export interface RoadmapInitiative {
  id: string
  name: string
  description: string | null
  color: string | null
  icon: string | null
  status: string
  sortOrder: number
  startDate: string | null
  targetDate: string | null
  slugId: string | null
  projectIds: string[]
}

// ---------------------------------------------------------------------------
// Board types — pre-joined hierarchy for RoadmapBoard Astro component
// Structure: BoardRow (initiative) → BoardProject → BoardMilestone
// ---------------------------------------------------------------------------

export interface BoardMilestone {
  id: string
  name: string
  sortOrder: number
  startDate: string | null   // inherited from parent project
  targetDate: string | null
  color: string | null        // inherited from parent project
}

export interface BoardProject {
  id: string
  name: string
  color: string | null
  state: string
  icon: string | null
  progress: number
  startDate: string | null
  targetDate: string | null
  url: string | null
  milestones: BoardMilestone[]
}

export interface BoardRow {
  id: string
  name: string
  description: string | null
  color: string | null        // row background tint
  icon: string | null
  status: string
  startDate: string | null
  targetDate: string | null
  projects: BoardProject[]
}

export interface RoadmapSnapshot {
  generatedAt: string
  lastSyncAt: string | null
  teams: RoadmapTeam[]
  projects: RoadmapProject[]
  initiatives: RoadmapInitiative[]
  board: BoardRow[]
}
