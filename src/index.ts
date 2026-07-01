import crypto from 'crypto'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { apiKeyMiddleware } from './middleware/apiKey.js'
import { keysRoutes } from './routes/keys.js'

const app = Fastify({ logger: true })

await app.register(rateLimit, {
  max: 60,
  timeWindow: '1 minute',
  // Rate limit per API key (hashed), falling back to IP for unauthenticated requests
  keyGenerator: (req) => {
    const auth = req.headers.authorization
    if (auth?.startsWith('Bearer ')) {
      return crypto.createHash('sha256').update(auth.slice(7)).digest('hex')
    }
    return req.ip
  },
})

await app.register(apiKeyMiddleware)
await app.register(keysRoutes)

app.get('/health', async () => ({ status: 'ok' }))

const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })
