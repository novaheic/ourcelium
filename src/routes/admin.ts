import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { fetchAxiomMetrics } from '../lib/axiomQuery.js'

export async function adminRoutes(app: FastifyInstance) {
  app.get('/admin/metrics', async (req, reply) => {
    // Auth: Bearer token must match ADMIN_SECRET (server-to-server; the Next.js
    // /admin page calls this from its server side, never the browser).
    const expected = process.env.ADMIN_SECRET
    if (!expected || req.headers.authorization !== `Bearer ${expected}`) {
      return reply.status(401).send({ error: 'unauthorized' })
    }

    // ---- Business metrics from Postgres ----

    // Tokens served over the last day / week / month
    const tokensRes = await db.execute(sql`
      SELECT
        COALESCE(SUM(input_tokens + output_tokens) FILTER (WHERE created_at >= now() - interval '1 day'), 0)   AS day,
        COALESCE(SUM(input_tokens + output_tokens) FILTER (WHERE created_at >= now() - interval '7 days'), 0)  AS week,
        COALESCE(SUM(input_tokens + output_tokens) FILTER (WHERE created_at >= now() - interval '30 days'), 0) AS month
      FROM usage_events
    `)
    const tokensRow = tokensRes.rows[0] as { day: string; week: string; month: string }

    // Total registered users per tier
    const tierRes = await db.execute(sql`
      SELECT tier, COUNT(*)::int AS count FROM subscriptions GROUP BY tier
    `)
    const usersByTier = { free: 0, paid: 0 }
    for (const r of tierRes.rows as { tier: 'free' | 'paid'; count: number }[]) {
      usersByTier[r.tier] = Number(r.count)
    }

    // Active users (had usage in the last 30 days) split by tier
    const activeRes = await db.execute(sql`
      SELECT s.tier, COUNT(DISTINCT ue.user_id)::int AS count
      FROM usage_events ue
      JOIN subscriptions s ON s.user_id = ue.user_id
      WHERE ue.created_at >= now() - interval '30 days'
      GROUP BY s.tier
    `)
    const activeUsersByTier = { free: 0, paid: 0 }
    for (const r of activeRes.rows as { tier: 'free' | 'paid'; count: number }[]) {
      activeUsersByTier[r.tier] = Number(r.count)
    }

    // p95 / p99 of per-user token usage (last 30 days)
    const pctRes = await db.execute(sql`
      WITH per_user AS (
        SELECT user_id, SUM(input_tokens + output_tokens) AS total
        FROM usage_events
        WHERE created_at >= now() - interval '30 days'
        GROUP BY user_id
      )
      SELECT
        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY total), 0)::bigint AS p95,
        COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY total), 0)::bigint AS p99
      FROM per_user
    `)
    const pctRow = pctRes.rows[0] as { p95: string; p99: string }

    // Top 20 users by token usage (last 30 days)
    const topRes = await db.execute(sql`
      SELECT u.email, SUM(ue.input_tokens + ue.output_tokens)::bigint AS tokens
      FROM usage_events ue
      JOIN users u ON u.id = ue.user_id
      WHERE ue.created_at >= now() - interval '30 days'
      GROUP BY u.email
      ORDER BY tokens DESC
      LIMIT 20
    `)
    const topUsers = (topRes.rows as { email: string; tokens: string }[]).map((r) => ({
      email: r.email,
      tokens: Number(r.tokens),
    }))

    // ---- Operational metrics from Axiom (latency, errors, revenue) ----
    const axiom = await fetchAxiomMetrics(app.log)

    return reply.send({
      tokens_served: {
        day: Number(tokensRow.day),
        week: Number(tokensRow.week),
        month: Number(tokensRow.month),
      },
      users_by_tier: usersByTier,
      active_users_by_tier: activeUsersByTier,
      tokens_per_user: { p95: Number(pctRow.p95), p99: Number(pctRow.p99) },
      top_users: topUsers,
      ttft_ms: axiom.ttft, // { p50, p95 } over last 24h, or null
      error_rate_pct: axiom.errorRatePct, // 5xx rate % over last 24h, or null
      topups: axiom.topups, // { count, revenue_eur } over last 30d, or null
    })
  })
}
