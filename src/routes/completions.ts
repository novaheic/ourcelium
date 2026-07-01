import type { FastifyInstance } from 'fastify'
import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { usageEvents, users } from '../db/schema.js'

const TOGETHER_API_URL = 'https://api.together.xyz/v1/chat/completions'
const DEFAULT_MODEL = 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput'

const FREE_CAP = 2_000_000
const PAID_CAP = 25_000_000

interface CompletionBody {
  model?: string
  messages: { role: string; content: string }[]
}

export async function completionsRoutes(app: FastifyInstance) {
  app.post('/v1/chat/completions', async (req, reply) => {
    const user = req.user!
    const cap = user.tier === 'free' ? FREE_CAP : PAID_CAP

    // --- Cap enforcement (before proxying) ---
    const [usageRow] = await db
      .select({ total: sql<number>`COALESCE(SUM(input_tokens + output_tokens), 0)` })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.userId, user.id),
          gte(usageEvents.createdAt, user.periodStart),
        ),
      )

    const usedTokens = Number(usageRow.total)

    if (usedTokens >= cap) {
      if (user.tier === 'free') {
        return reply
          .status(429)
          .header('Retry-After', Math.ceil((user.periodEnd.getTime() - Date.now()) / 1000))
          .send({
            error: 'usage_limit_reached',
            reset_at: user.periodEnd.toISOString(),
            action_url: 'https://ourcelium.dev/pricing',
          })
      }
      // Paid: allow if credits available, else 429
      if (user.creditsTokens > 0) {
        user.usingCredits = true
      } else {
        return reply
          .status(429)
          .header('Retry-After', Math.ceil((user.periodEnd.getTime() - Date.now()) / 1000))
          .send({
            error: 'usage_limit_reached',
            reset_at: user.periodEnd.toISOString(),
            action_url: 'https://ourcelium.dev/dashboard',
          })
      }
    }

    // Abuse detection: >90% of cap consumed within 48h of period start
    if (usedTokens >= cap * 0.9) {
      const periodAgeMs = Date.now() - user.periodStart.getTime()
      if (periodAgeMs < 48 * 60 * 60 * 1000) {
        req.log.warn(
          { userId: user.id, usedTokens, cap, periodAgeHours: periodAgeMs / 3_600_000 },
          'suspicious_usage',
        )
      }
    }

    // --- Proxy ---
    const body = req.body as CompletionBody

    const upstream = await fetch(TOGETHER_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Phase 0 is single-model: always use the gateway's model regardless
        // of what the client sends, so arbitrary Together models can't be
        // billed to our upstream account.
        model: DEFAULT_MODEL,
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

        // Extract usage from SSE chunks — Together sends it on the final chunk
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
          .values({ userId: user.id, inputTokens, outputTokens, model: DEFAULT_MODEL })
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
