import type { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users, apiKeys, subscriptions } from '../db/schema.js'
import { supabaseAdmin } from '../lib/supabase.js'

export async function keysRoutes(app: FastifyInstance) {
  app.post('/v1/keys', async (req, reply) => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'missing_token' })
    }
    const token = authHeader.slice(7)

    // Validate token + get fresh user data in one call (handles RS256 and legacy HS256)
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)
    if (error || !user) {
      return reply.status(401).send({ error: 'invalid_token' })
    }
    const sub = user.id

    // Idempotent: return existing key immediately
    if (user.user_metadata?.api_key) {
      return reply.send({ key: user.user_metadata.api_key })
    }

    // Upsert user row
    const [userRecord] = await db
      .insert(users)
      .values({ supabaseUserId: sub, email: user.email! })
      .onConflictDoUpdate({
        target: users.supabaseUserId,
        set: { email: user.email! },
      })
      .returning()

    // Create free subscription if one doesn't exist yet
    const [existingSub] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userRecord.id))
      .limit(1)

    if (!existingSub) {
      const now = new Date()
      const periodEnd = new Date(now)
      periodEnd.setMonth(periodEnd.getMonth() + 1)
      await db.insert(subscriptions).values({
        userId: userRecord.id,
        tier: 'free',
        periodStart: now,
        periodEnd,
        periodResetAnchor: Math.min(now.getDate(), 28),
      })
    }

    // Generate key — orc_ prefix makes it identifiable in logs
    const key = `orc_${crypto.randomBytes(24).toString('hex')}`
    const keyHash = crypto.createHash('sha256').update(key).digest('hex')

    try {
      await db.insert(apiKeys).values({ userId: userRecord.id, keyHash })
      await supabaseAdmin.auth.admin.updateUserById(sub, {
        user_metadata: { api_key: key },
      })
      return reply.send({ key })
    } catch (err: any) {
      // Unique constraint on user_id: concurrent request won the race
      if (err.code === '23505') {
        const { data: { user: freshUser } } = await supabaseAdmin.auth.admin.getUserById(sub)
        return reply.send({ key: freshUser!.user_metadata.api_key })
      }
      throw err
    }
  })
}
