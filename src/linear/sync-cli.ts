import 'dotenv/config'
import { syncAll, syncTeams, syncProjects, syncIssues, triggerDeploys } from './sync.js'
import { prisma } from '../db/client.js'

const target = process.argv[2] // 'teams' | 'projects' | 'issues' | undefined

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
