import type { FastifyBaseLogger } from 'fastify'

const AXIOM_APL_URL = 'https://api.axiom.co/v1/datasets/_apl?format=tabular'

const num = (v: unknown): number => (v == null ? 0 : Number(v))

// Runs an APL query over [startTime, endTime] and returns the first result row
// as { fieldName: value }, or null on failure. Axiom's tabular response is
// column-oriented: tables[0].columns[i] holds the values for tables[0].fields[i].
async function runAplRow(
  apl: string,
  startTime: string,
  endTime: string,
  token: string,
  log: FastifyBaseLogger,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(AXIOM_APL_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apl, startTime, endTime }),
    })
    if (!res.ok) {
      log.warn({ status: res.status, body: await res.text() }, 'axiom_query_failed')
      return null
    }
    const data = (await res.json()) as {
      tables?: { fields?: { name: string }[]; columns?: unknown[][] }[]
    }
    const table = data.tables?.[0]
    if (!table?.fields || !table.columns) return {}
    const row: Record<string, unknown> = {}
    table.fields.forEach((f, i) => {
      row[f.name] = table.columns![i]?.[0] ?? null
    })
    return row
  } catch (err) {
    log.warn({ err }, 'axiom_query_error')
    return null
  }
}

export interface AxiomMetrics {
  ttft: { p50: number; p95: number } | null
  errorRatePct: number | null
  topups: { count: number; revenue_eur: number } | null
}

// Pulls latency, error-rate, and revenue metrics from Axiom. Returns nulls if
// AXIOM_QUERY_TOKEN/AXIOM_DATASET aren't configured, so /admin still works
// (DB metrics only) before Axiom querying is wired up.
export async function fetchAxiomMetrics(log: FastifyBaseLogger): Promise<AxiomMetrics> {
  const token = process.env.AXIOM_QUERY_TOKEN
  const dataset = process.env.AXIOM_DATASET
  if (!token || !dataset) {
    return { ttft: null, errorRatePct: null, topups: null }
  }

  const now = new Date()
  const iso = (d: Date) => d.toISOString()
  const h24 = iso(new Date(now.getTime() - 24 * 3600 * 1000))
  const d30 = iso(new Date(now.getTime() - 30 * 24 * 3600 * 1000))
  const ds = `['${dataset}']`

  const ttftRow = await runAplRow(
    `${ds} | where msg == "completion" | summarize p50 = percentile(ttft_ms, 50), p95 = percentile(ttft_ms, 95)`,
    h24, iso(now), token, log,
  )
  const errRow = await runAplRow(
    `${ds} | where isnotnull(status_code) | summarize total = count(), errors = countif(status_code >= 500)`,
    h24, iso(now), token, log,
  )
  const topupRow = await runAplRow(
    `${ds} | where msg == "topup" | summarize count = count(), revenue_cents = sum(amount_cents)`,
    d30, iso(now), token, log,
  )

  const ttft = ttftRow ? { p50: num(ttftRow.p50), p95: num(ttftRow.p95) } : null

  let errorRatePct: number | null = null
  if (errRow) {
    const total = num(errRow.total)
    errorRatePct = total > 0 ? (100 * num(errRow.errors)) / total : 0
  }

  const topups = topupRow
    ? { count: num(topupRow.count), revenue_eur: num(topupRow.revenue_cents) / 100 }
    : null

  return { ttft, errorRatePct, topups }
}
