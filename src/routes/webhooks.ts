import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import type Stripe from 'stripe'
import { db } from '../db/client.js'
import { users, subscriptions } from '../db/schema.js'
import { stripe } from '../lib/stripe.js'

function getTokensForPrice(priceId: string): number | null {
  const map: Record<string, number> = {}
  if (process.env.STRIPE_TOPUP_S_PRICE_ID) map[process.env.STRIPE_TOPUP_S_PRICE_ID] = 10_000_000
  if (process.env.STRIPE_TOPUP_M_PRICE_ID) map[process.env.STRIPE_TOPUP_M_PRICE_ID] = 20_000_000
  if (process.env.STRIPE_TOPUP_L_PRICE_ID) map[process.env.STRIPE_TOPUP_L_PRICE_ID] = 40_000_000
  return map[priceId] ?? null
}

async function handleSubscriptionUpdate(sub: Stripe.Subscription) {
  const [userRecord] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.stripeCustomerId, sub.customer as string))
    .limit(1)

  if (!userRecord) return

  const periodStart = new Date(sub.current_period_start * 1000)
  const periodEnd = new Date(sub.current_period_end * 1000)
  const tier: 'free' | 'paid' =
    sub.status === 'active' || sub.status === 'trialing' ? 'paid' : 'free'

  await db
    .update(subscriptions)
    .set({ tier, periodStart, periodEnd, stripeSubId: sub.id })
    .where(eq(subscriptions.userId, userRecord.id))
}

async function downgradeBySubId(stripeSubId: string) {
  await db
    .update(subscriptions)
    .set({ tier: 'free', stripeSubId: null })
    .where(eq(subscriptions.stripeSubId, stripeSubId))
}

async function handleTopup(session: Stripe.Checkout.Session) {
  const userId = parseInt(session.client_reference_id!, 10)
  if (isNaN(userId)) return

  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 })
  const priceId = lineItems.data[0]?.price?.id
  if (!priceId) return

  const tokens = getTokensForPrice(priceId)
  if (!tokens) return

  await db
    .update(users)
    .set({ creditsTokens: sql`${users.creditsTokens} + ${tokens}` })
    .where(eq(users.id, userId))
}

export async function webhookRoutes(app: FastifyInstance) {
  // Stripe requires the raw body for signature verification.
  // This content type parser is scoped to this plugin so it doesn't affect other routes.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })

  app.post('/v1/webhooks/stripe', async (req, reply) => {
    const signature = req.headers['stripe-signature'] as string | undefined
    if (!signature) {
      return reply.status(400).send({ error: 'missing_signature' })
    }

    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(
        req.body as Buffer,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!,
      )
    } catch {
      return reply.status(400).send({ error: 'invalid_signature' })
    }

    try {
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          await handleSubscriptionUpdate(event.data.object as Stripe.Subscription)
          break
        }

        case 'invoice.paid': {
          const invoice = event.data.object as Stripe.Invoice
          if (invoice.subscription) {
            const sub = await stripe.subscriptions.retrieve(invoice.subscription as string)
            await handleSubscriptionUpdate(sub)
          }
          break
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object as Stripe.Invoice
          if (invoice.subscription) {
            await downgradeBySubId(invoice.subscription as string)
          }
          break
        }

        case 'customer.subscription.deleted': {
          await downgradeBySubId((event.data.object as Stripe.Subscription).id)
          break
        }

        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session
          if (!session.client_reference_id) break

          if (session.mode === 'subscription') {
            // Ensure user.stripe_customer_id is set (covers the case where no customer existed at checkout)
            const userId = parseInt(session.client_reference_id, 10)
            if (!isNaN(userId)) {
              await db
                .update(users)
                .set({ stripeCustomerId: session.customer as string })
                .where(eq(users.id, userId))
            }
          } else if (session.mode === 'payment') {
            await handleTopup(session)
          }
          break
        }
      }
    } catch (err) {
      req.log.error({ err, eventType: event.type }, 'stripe_webhook_handler_error')
      return reply.status(500).send({ error: 'handler_error' })
    }

    return reply.send({ received: true })
  })
}
