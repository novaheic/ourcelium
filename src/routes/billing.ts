import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { stripe } from '../lib/stripe.js'

const DASHBOARD_URL = 'https://ourcelium.dev/dashboard'

const PACK_PRICE_IDS: Record<string, string> = {
  S: process.env.STRIPE_TOPUP_S_PRICE_ID ?? '',
  M: process.env.STRIPE_TOPUP_M_PRICE_ID ?? '',
  L: process.env.STRIPE_TOPUP_L_PRICE_ID ?? '',
}

export async function billingRoutes(app: FastifyInstance) {
  app.post('/v1/billing/upgrade', async (req, reply) => {
    const user = req.user!

    const [userRecord] = await db
      .select({ stripeCustomerId: users.stripeCustomerId })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: userRecord.stripeCustomerId ?? undefined,
      line_items: [{ price: process.env.STRIPE_PRO_PRICE_ID!, quantity: 1 }],
      client_reference_id: String(user.id),
      success_url: `${DASHBOARD_URL}?upgraded=1`,
      cancel_url: DASHBOARD_URL,
    })

    return reply.send({ url: session.url })
  })

  app.post('/v1/billing/topup', async (req, reply) => {
    const user = req.user!

    if (user.tier !== 'paid') {
      return reply.status(403).send({ error: 'upgrade_required' })
    }

    const body = req.body as { pack?: string }
    const priceId = body.pack ? PACK_PRICE_IDS[body.pack] : undefined

    if (!priceId) {
      return reply.status(400).send({ error: 'invalid_pack', valid: ['S', 'M', 'L'] })
    }

    const [userRecord] = await db
      .select({ stripeCustomerId: users.stripeCustomerId })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: userRecord.stripeCustomerId ?? undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: String(user.id),
      metadata: { pack: body.pack! },
      success_url: `${DASHBOARD_URL}?topup=1`,
      cancel_url: DASHBOARD_URL,
    })

    return reply.send({ url: session.url })
  })

  app.get('/v1/billing/portal', async (req, reply) => {
    const user = req.user!

    const [userRecord] = await db
      .select({ stripeCustomerId: users.stripeCustomerId })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    if (!userRecord.stripeCustomerId) {
      return reply.status(400).send({ error: 'no_billing_account' })
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: userRecord.stripeCustomerId,
      return_url: DASHBOARD_URL,
    })

    return reply.send({ url: session.url })
  })
}
