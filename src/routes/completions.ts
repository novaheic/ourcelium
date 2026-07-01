import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { usageEvents, users } from '../db/schema.js'

const TOGETHER_API_URL = 'https://api.together.xyz/v1/chat/completions'
const DEFAULT_MODEL = 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput'

interface CompletionBody {
  model?: string
  messages: { role: string; content: string }[]
}

export async function completionsRoutes(app: FastifyInstance) {
  app.post('/v1/chat/completions', async (req, reply) => {
    const user = req.user!
    const body = req.body as CompletionBody

    const upstream = await fetch(TOGETHER_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: body.model ?? DEFAULT_MODEL,
        messages: body.messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
    })

    if (!upstream.ok) {
      const detail = await upstream.text()
      return reply.status(upstream.status).send({ error: 'upstream_error', detail })
    }

    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })

    const reader = upstream.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let inputTokens = 0
    let outputTokens = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value, { stream: true })
        buffer += text

        // Process complete SSE lines to extract usage from the final chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data !== '[DONE]') {
              try {
                const parsed = JSON.parse(data)
                if (parsed.usage) {
                  inputTokens = parsed.usage.prompt_tokens ?? 0
                  outputTokens = parsed.usage.completion_tokens ?? 0
                }
              } catch {}
            }
          }
        }

        res.write(text)
      }
    } finally {
      res.end()

      const totalTokens = inputTokens + outputTokens
      if (totalTokens > 0) {
        db.insert(usageEvents)
          .values({ userId: user.id, inputTokens, outputTokens, model: body.model ?? DEFAULT_MODEL })
          .execute()
          .catch(console.error)

        if (user.usingCredits) {
          db.update(users)
            .set({ creditsTokens: sql`GREATEST(0, ${users.creditsTokens} - ${totalTokens})` })
            .where(eq(users.id, user.id))
            .execute()
            .catch(console.error)
        }
      }
    }
  })
}
