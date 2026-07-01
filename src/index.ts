import crypto from 'crypto'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { applyApiKeyMiddleware } from './middleware/apiKey.js'
import { keysRoutes } from './routes/keys.js'
import { completionsRoutes } from './routes/completions.js'
import { usageRoutes } from './routes/usage.js'

const app = Fastify({ logger: true })

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

// Applied directly on root so the hook covers all route plugins
applyApiKeyMiddleware(app)

await app.register(keysRoutes)
await app.register(completionsRoutes)
await app.register(usageRoutes)

app.get('/health', async () => ({ status: 'ok' }))

const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })
