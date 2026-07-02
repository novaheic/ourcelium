import type { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users, apiKeys, subscriptions } from '../db/schema.js'
import { supabaseAdmin } from '../lib/supabase.js'
import { stripe } from '../lib/stripe.js'

export async function keysRoutes(app: FastifyInstance) {
  app.post('/v1/keys', async (req, reply) => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'missing_token' })
    }
    const token = authHeader.slice(7)

    // Validate token + get fresh user data (handles RS256 and legacy HS256)
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)
    if (error || !user) {
      return reply.status(401).send({ error: 'invalid_token' })
    }
    const sub = user.id

    // Always upsert user + subscription rows — ensures DB is consistent even
    // if user_metadata was set from a different environment (e.g. local dev)
    const [userRecord] = await db
      .insert(users)
      .values({ supabaseUserId: sub, email: user.email! })
      .onConflictDoUpdate({
        target: users.supabaseUserId,
        set: { email: user.email! },
      })
      .returning()

    // Create Stripe customer if this user doesn't have one yet
    if (!userRecord.stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email!,
        metadata: { ourcelium_user_id: String(userRecord.id) },
      })
      await db
        .update(users)
        .set({ stripeCustomerId: customer.id })
        .where(eq(users.id, userRecord.id))
      userRecord.stripeCustomerId = customer.id
    }

    // Create free subscription if one doesn't exist yet
    const [existingSub] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userRecord.id))
      .limit(1)

    if (!existingSub) {
      const now = new Date()
      const anchor = Math.min(now.getDate(), 28)
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, anchor)
      await db.insert(subscriptions).values({
        userId: userRecord.id,
        tier: 'free',
        periodStart: now,
        periodEnd,
        periodResetAnchor: anchor,
      })
    }

    // If a key exists in user_metadata, verify it's actually in this DB.
    // It won't be if the user previously signed in against a different DB (e.g. local dev Docker).
    if (user.user_metadata?.api_key) {
      const existingKey = user.user_metadata.api_key
      const existingHash = crypto.createHash('sha256').update(existingKey).digest('hex')
      const [keyRecord] = await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, existingHash))
        .limit(1)
      if (keyRecord) {
        return reply.send({ key: existingKey })
      }
      // Key not in DB — fall through to generate and store a fresh one
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
      // Unique constraint on user_id: a concurrent request won the race and
      // created the key. The plaintext key lives only in Supabase user_metadata
      // (the DB stores just the hash), so we must read it back from there. The
      // winner writes that metadata *after* inserting the key row, so at the
      // instant we land here it may not be set yet — retry briefly until it is,
      // rather than returning a blank key.
      if (err.code === '23505') {
        for (let attempt = 0; attempt < 5; attempt++) {
          const { data: { user: freshUser } } = await supabaseAdmin.auth.admin.getUserById(sub)
          const racedKey = freshUser?.user_metadata?.api_key
          if (racedKey) {
            return reply.send({ key: racedKey })
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        // The winner always sets metadata immediately after inserting the key
        // row, so this is effectively unreachable — surface a retryable error
        // instead of handing back an undefined key.
        return reply.status(503).send({ error: 'key_issuance_conflict' })
      }
      throw err
    }
  })
}
