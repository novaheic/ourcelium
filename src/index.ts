import crypto from 'crypto'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { applyApiKeyMiddleware } from './middleware/apiKey.js'
import { keysRoutes } from './routes/keys.js'
import { completionsRoutes } from './routes/completions.js'
import { usageRoutes } from './routes/usage.js'
import { billingRoutes } from './routes/billing.js'
import { webhookRoutes } from './routes/webhooks.js'

const app = Fastify({ logger: true })

await app.register(cors, {
  origin: [
    'http://localhost:3001',
    'https://ourcelium.netlify.app',
    'https://ourcelium.dev',
  ],
  methods: ['GET', 'POST'],
})

await app.register(rateLimit, {
  max: 60,
  timeWindow: '1 minute',
  keyGenerator: (req) => {
    const auth = req.headers.authorization
    if (auth?.startsWith('Bearer ')) {
      return crypto.createHash('sha256').update(auth.slice(7)).digest('hex')
    }
    return req.ip
  },
  errorResponseBuilder: (_req, context) => ({
    error: 'rate_limit_exceeded',
    retry_after_seconds: Math.ceil(context.ttl / 1000),
  }),
})

// Applied on root so the hook covers all route plugins
applyApiKeyMiddleware(app)

// Webhook plugin must come before other JSON routes — it registers its own
// raw-body content type parser scoped to this plugin only
await app.register(webhookRoutes)

await app.register(keysRoutes)
await app.register(completionsRoutes)
await app.register(usageRoutes)
await app.register(billingRoutes)

app.get('/health', async () => ({ status: 'ok' }))

// Free-tier period reset: advance period_start/period_end for any free users
// whose period has ended. Runs at startup and every 24h thereafter.
async function resetFreeUserPeriods() {
  try {
    const result = await db.execute(sql`
      UPDATE subscriptions
      SET period_start = period_end,
          period_end   = period_end + INTERVAL '1 month'
      WHERE tier = 'free'
        AND period_end < NOW()
    `)
    const count = (result as any).rowCount ?? 0
    if (count > 0) {
      app.log.info({ count }, 'free_period_reset')
    }
  } catch (err) {
    app.log.error({ err }, 'free_period_reset_error')
  }
}

await resetFreeUserPeriods()
setInterval(resetFreeUserPeriods, 24 * 60 * 60 * 1000)

const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })
