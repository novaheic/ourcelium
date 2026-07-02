import type { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { apiKeys, users, subscriptions } from '../db/schema.js'

declare module 'fastify' {
  interface FastifyRequest {
    user: {
      id: number
      tier: 'free' | 'paid'
      creditsTokens: number
      usingCredits: boolean
      periodStart: Date
      periodEnd: Date
    } | null
    // Set by the completions route once it emits its own 'completion' log, so
    // the global onResponse access-log hook doesn't log a redundant line.
    skipAccessLog?: boolean
  }
}

export function applyApiKeyMiddleware(app: FastifyInstance) {
  app.decorateRequest('user', null)

  app.addHook('preHandler', async (req, reply) => {
    // Skip auth for these endpoints — they use their own auth schemes
    if (
      !req.url.startsWith('/v1/') ||
      req.url === '/v1/keys' ||
      req.url.startsWith('/v1/webhooks/')
    ) return

    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'invalid_api_key' })
    }

    const keyHash = crypto.createHash('sha256').update(authHeader.slice(7)).digest('hex')

    const [keyRecord] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1)

    if (!keyRecord) {
      return reply.status(401).send({ error: 'invalid_api_key' })
    }

    const [userRecord] = await db
      .select({
        id: users.id,
        creditsTokens: users.creditsTokens,
        tier: subscriptions.tier,
        periodStart: subscriptions.periodStart,
        periodEnd: subscriptions.periodEnd,
      })
      .from(users)
      .innerJoin(subscriptions, eq(subscriptions.userId, users.id))
      .where(eq(users.id, keyRecord.userId))
      .limit(1)

    if (!userRecord) {
      return reply.status(401).send({ error: 'invalid_api_key' })
    }

    // Non-blocking last_used_at update
    db.update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, keyRecord.id))
      .execute()
      .catch(() => {})

    req.user = {
      id: userRecord.id,
      tier: userRecord.tier as 'free' | 'paid',
      creditsTokens: userRecord.creditsTokens,
      usingCredits: false,
      periodStart: userRecord.periodStart,
      periodEnd: userRecord.periodEnd,
    }
  })
}
