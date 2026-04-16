import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createHmac, timingSafeEqual } from 'crypto'
import { syncAll, syncTeams, syncProjects, syncInitiatives, syncSingleProject, syncSingleInitiative, triggerDeploys } from '../linear/sync.js'
import { prisma } from '../db/client.js'

// Linear sends webhooks for these action types
const RELEVANT_ACTIONS = new Set([
  'create',
  'update',
  'remove',
])

// These resource types affect the roadmap
const RELEVANT_TYPES = new Set([
  'Project',
  'ProjectMilestone',
  'Initiative',
  'InitiativeToProject',
])

function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  const secret = process.env.API_SECRET
  const auth = request.headers['authorization']
  if (secret && auth !== `Bearer ${secret}`) {
    reply.status(401).send({ error: 'Unauthorized' })
    return false
  }
  return true
}

export async function webhookRoutes(app: FastifyInstance) {
  /**
   * POST /webhook/linear
   *
   * Receives Linear webhook events.
   * Linear signs each request with HMAC-SHA256 using your webhook secret.
   * We verify the signature before processing.
   *
   * Webhook events are routed to the minimal targeted sync rather than a full
   * syncAll(), reducing Linear API load significantly:
   *   Project / Milestone → syncSingleProject()
   *   Initiative          → syncSingleInitiative()
   */
  app.post(
    '/webhook/linear',
    {
      config: {
        // Fastify needs the raw body for HMAC verification
        rawBody: true,
      },
    },
    async (request, reply) => {
      // --- Signature verification ---
      const secret = process.env.LINEAR_WEBHOOK_SECRET
      if (!secret) {
        app.log.error('LINEAR_WEBHOOK_SECRET is not set')
        return reply.status(500).send({ error: 'Webhook secret not configured' })
      }

      const signature = request.headers['linear-signature'] as string | undefined
      if (!signature) {
        return reply.status(401).send({ error: 'Missing Linear-Signature header' })
      }

      const rawBody = (request as any).rawBody as Buffer
      const expectedSig = createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex')

      const sigBuffer = Buffer.from(signature)
      const expectedBuffer = Buffer.from(expectedSig)

      if (
        sigBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(sigBuffer, expectedBuffer)
      ) {
        app.log.warn('Invalid webhook signature')
        return reply.status(401).send({ error: 'Invalid signature' })
      }

      // --- Parse payload ---
      const payload = request.body as {
        type?: string
        action?: string
        data?: { id?: string; projectId?: string; initiativeId?: string }
      }

      const { type, action, data } = payload

      app.log.info({ type, action }, 'Linear webhook received')

      // Acknowledge immediately — Linear expects a fast 200
      reply.status(200).send({ received: true })

      // Route to the most targeted sync available based on what changed
      if (
        type && RELEVANT_TYPES.has(type) &&
        action && RELEVANT_ACTIONS.has(action)
      ) {
        let syncFn: () => Promise<void>

        if (type === 'Project') {
          syncFn = data?.id ? () => syncSingleProject(data.id!) : syncProjects
        } else if (type === 'ProjectMilestone') {
          let projectId = data?.projectId
          if (!projectId && data?.id) {
            const found = await prisma.milestone.findUnique({
              where: { id: data.id },
              select: { projectId: true },
            })
            projectId = found?.projectId ?? undefined
          }
          syncFn = projectId ? () => syncSingleProject(projectId!) : syncProjects
        } else if (type === 'Initiative') {
          syncFn = data?.id ? () => syncSingleInitiative(data.id!) : syncInitiatives
        } else if (type === 'InitiativeToProject') {
          syncFn = data?.initiativeId ? () => syncSingleInitiative(data.initiativeId!) : syncInitiatives
        } else {
          syncFn = syncAll
        }

        app.log.info({ type, action, entityId: data?.id }, 'Triggering targeted sync...')

        syncFn()
          .then(() => triggerDeploys())
          .catch((err) => {
            app.log.error({ err }, 'Sync failed after webhook')
          })
      }
    }
  )

  /**
   * POST /api/sync
   *
   * Manually trigger a full sync. Protected by API_SECRET header.
   *
   * curl -X POST https://your-service.com/api/sync \
   *   -H "Authorization: Bearer YOUR_API_SECRET"
   */
  app.post('/api/sync', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    reply.status(202).send({ message: 'Sync started' })
    syncAll()
      .then(() => triggerDeploys())
      .catch((err) => {
        app.log.error({ err }, 'Manual sync failed')
      })
  })

  /**
   * POST /api/sync/teams
   *
   * Manually trigger a teams-only sync.
   */
  app.post('/api/sync/teams', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    reply.status(202).send({ message: 'Teams sync started' })
    syncTeams()
      .then(() => triggerDeploys())
      .catch((err) => {
        app.log.error({ err }, 'Teams sync failed')
      })
  })

  /**
   * POST /api/sync/projects
   *
   * Manually trigger a projects + milestones sync.
   */
  app.post('/api/sync/projects', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    reply.status(202).send({ message: 'Projects sync started' })
    syncProjects()
      .then(() => triggerDeploys())
      .catch((err) => {
        app.log.error({ err }, 'Projects sync failed')
      })
  })

}
