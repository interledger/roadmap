import 'dotenv/config'
import { syncAll, syncTeams, syncProjects, syncIssues, syncInitiatives, syncSingleInitiative, syncSingleProject, syncSingleMilestone, syncSingleTeam, triggerDeploys } from './sync.js'
import { prisma } from '../db/client.js'

const target = process.argv[2]
const id = process.argv[3]

async function main() {
  switch (target) {
    case 'teams':
      await syncTeams()
      break
    case 'projects':
      await syncProjects()
      break
    case 'issues':
      await syncIssues()
      break
    case 'initiatives':
      await syncInitiatives()
      break
    case 'initiative': {
      if (!id) { console.error('Usage: sync initiative <id>'); process.exit(1) }
      await syncSingleInitiative(id)
      break
    }
    case 'project': {
      if (!id) { console.error('Usage: sync project <id>'); process.exit(1) }
      await syncSingleProject(id)
      break
    }
    case 'milestone': {
      if (!id) { console.error('Usage: sync milestone <id>'); process.exit(1) }
      await syncSingleMilestone(id)
      break
    }
    case 'team': {
      if (!id) { console.error('Usage: sync team <id>'); process.exit(1) }
      await syncSingleTeam(id)
      break
    }
    default:
      await syncAll()
  }
  await triggerDeploys()
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
