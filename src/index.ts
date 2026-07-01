import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'

const app = Fastify({ logger: true })

await app.register(rateLimit, {
  max: 60,
  timeWindow: '1 minute',
  keyGenerator: (req) => req.headers['x-api-key-hash'] as string ?? req.ip,
})

app.get('/health', async () => ({ status: 'ok' }))

const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })
