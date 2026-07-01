import type { FastifyInstance } from 'fastify'
import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { subscriptions, usageEvents, users } from '../db/schema.js'

const TOKEN_CAP = { free: 2_000_000, paid: 25_000_000 }

export async function usageRoutes(app: FastifyInstance) {
  app.get('/v1/usage', async (req, reply) => {
    const user = req.user!

    const [sub] = await db
      .select({
        tier: subscriptions.tier,
        periodStart: subscriptions.periodStart,
        periodEnd: subscriptions.periodEnd,
      })
      .from(subscriptions)
      .where(eq(subscriptions.userId, user.id))
      .limit(1)

    if (!sub) {
      return reply.status(500).send({ error: 'no_subscription' })
    }

    const [usage] = await db
      .select({
        usedTokens: sql<number>`COALESCE(SUM(${usageEvents.inputTokens} + ${usageEvents.outputTokens}), 0)`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.userId, user.id),
          gte(usageEvents.createdAt, sub.periodStart)
        )
      )

    const [userRecord] = await db
      .select({ creditsTokens: users.creditsTokens })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    const tier = sub.tier as 'free' | 'paid'
    const cap = TOKEN_CAP[tier]
    const usedTokens = Number(usage.usedTokens)

    return reply.send({
      used_tokens: usedTokens,
      cap,
      credits_tokens: userRecord.creditsTokens,
      reset_at: sub.periodEnd.toISOString(),
      tier,
      at_warning: usedTokens >= cap * 0.8,
    })
  })
}
