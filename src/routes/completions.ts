import type { FastifyInstance } from 'fastify'
import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { usageEvents, users } from '../db/schema.js'

const TOGETHER_API_URL = 'https://api.together.xyz/v1/chat/completions'
const DEFAULT_MODEL = 'MiniMaxAI/MiniMax-M3'

const FREE_CAP = 2_000_000
const PAID_CAP = 25_000_000

interface ToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface Message {
  role: string
  content: unknown
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

interface CompletionBody {
  model?: string
  messages: Message[]
  // Tool-calling params from the client. These MUST be forwarded upstream or
  // the model can't emit edit/create tool calls and can only describe changes
  // in prose instead of applying them.
  tools?: unknown
  tool_choice?: unknown
  temperature?: number
  max_tokens?: number
}

// If the model's output is truncated (e.g. it hits max_tokens mid-edit) or it
// simply emits malformed tool-call JSON, the assistant message ends up with a
// `tool_calls[].function.arguments` string that isn't valid JSON. Together then
// rejects the ENTIRE request with "Input validation error" — which poisons the
// whole session, since that bad message stays in history and every subsequent
// request 400s. Repair such arguments to "{}" so the conversation stays valid;
// the paired tool result (usually an error the client already recorded) lets
// the model recover on the next turn.
function sanitizeToolCallArguments(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) return msg
    let repaired = false
    const tool_calls = msg.tool_calls.map((tc) => {
      const args = tc.function?.arguments
      if (typeof args !== 'string') return tc
      try {
        JSON.parse(args)
        return tc
      } catch {
        repaired = true
        return { ...tc, function: { ...tc.function, arguments: '{}' } }
      }
    })
    return repaired ? { ...msg, tool_calls } : msg
  })
}

export async function completionsRoutes(app: FastifyInstance) {
  app.post('/v1/chat/completions', async (req, reply) => {
    const user = req.user!
    const handlerStart = Date.now()
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
            cta: 'upgrade',
            action_url: 'https://ourcelium.dev/dashboard',
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
            cta: 'topup',
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

    const messages = sanitizeToolCallArguments(body.messages)
    // sanitize returns the same message object when nothing was repaired, so an
    // identity diff on any element means we fixed a malformed tool call.
    if (messages.some((m, i) => m !== body.messages[i])) {
      req.log.warn({ userId: user.id }, 'repaired_malformed_tool_call_arguments')
    }

    const upstreamStart = Date.now()
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
        messages,
        // Forward tool definitions so the model can actually call the
        // edit/create tools the client offers. Without this the agent can
        // only suggest changes, never apply them.
        ...(body.tools ? { tools: body.tools, tool_choice: body.tool_choice ?? 'auto' } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
        stream: true,
        stream_options: { include_usage: true },
      }),
    })
    const upstreamLatencyMs = Date.now() - upstreamStart

    if (!upstream.ok) {
      const detail = await upstream.text()
      return reply.status(upstream.status).send({ error: 'upstream_error', detail })
    }

    // This request emits its own 'completion' log below; tell the global
    // onResponse access-log hook to skip it (it fires for hijacked replies too).
    req.skipAccessLog = true
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
    let ttftMs: number | null = null

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value, { stream: true })
        if (ttftMs === null && text.length > 0) {
          ttftMs = Date.now() - handlerStart
        }
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

      // Structured per-completion metrics. Emitted here (not via the global
      // onResponse hook) because the streaming reply is hijacked, so Fastify's
      // response lifecycle hooks don't fire for it.
      req.log.info(
        {
          user_id: user.id,
          tier: user.tier,
          using_credits: user.usingCredits,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          ttft_ms: ttftMs,
          upstream_latency_ms: upstreamLatencyMs,
          status_code: 200,
        },
        'completion',
      )
    }
  })
}
