import { formatCompact, formatCost, formatDuration, formatInt, formatMs, formatPercent } from "../lib/format.ts"
import { DEFAULT_WINDOW, useOverview, useUsage } from "../lib/queries.ts"
import type { UsageAggregate } from "../lib/types.ts"
import { BarChart } from "../components/BarChart.tsx"
import { Badge, Card, ErrorPanel, Loading, ProgressBar, Stat } from "../components/ui.tsx"

export function DashboardView() {
  const overview = useOverview()
  const usage = useUsage(DEFAULT_WINDOW.windowMs, DEFAULT_WINDOW.bucketMs)

  if (overview.isPending) return <Loading label="Loading overview" />
  if (overview.isError) return <ErrorPanel error={overview.error} onRetry={() => void overview.refetch()} />

  const data = overview.data
  const summary = usage.data?.summary
  const series = usage.data?.series ?? []
  const errorRate = summary !== undefined && summary.requests > 0 ? summary.errors / summary.requests : null

  return (
    <div className="stack">
      <h1>Dashboard</h1>

      <div className="stat-grid">
        <Stat
          label="Providers"
          value={`${formatInt(data.providers_enabled)} / ${formatInt(data.providers_total)}`}
          hint="enabled / total"
        />
        <Stat
          label="Breakers open"
          value={formatInt(data.providers_open)}
          tone={data.providers_open > 0 ? "bad" : "good"}
          hint="providers cooling down"
        />
        <Stat label="Models" value={formatInt(data.models)} hint="discovered and published" />
        <Stat label="Routes" value={formatInt(data.routes)} hint="public model mappings" />
        <Stat label="Keys" value={formatInt(data.keys)} hint="client keys" />
        <Stat
          label="Credits"
          value={formatCompact(data.credits_total)}
          hint="workbuddy2api upstreams"
          tone={data.credits_total <= 0 ? "warn" : undefined}
        />
        <Stat
          label="Session affinity"
          value={
            data.sessions.lookups === 0
              ? "—"
              : `${formatInt(Math.round((data.sessions.hits / data.sessions.lookups) * 100))}%`
          }
          hint={
            data.sessions.tracked === 0
              ? "no sessions pinned"
              : `${formatInt(data.sessions.tracked)} pinned · ${formatInt(data.sessions.hits)} reused`
          }
        />
        <Stat label="Uptime" value={formatDuration(data.uptime_s)} hint="since last start" />
      </div>

      <Card
        title={`Traffic · last ${DEFAULT_WINDOW.label}`}
        subtitle="Totals across every provider for the default window"
        actions={
          <button type="button" className="btn btn-small" onClick={() => void usage.refetch()}>
            Refresh
          </button>
        }
        padded
      >
        {usage.isPending ? (
          <Loading label="Loading usage" />
        ) : usage.isError ? (
          <ErrorPanel error={usage.error} onRetry={() => void usage.refetch()} />
        ) : summary === undefined ? (
          <p className="muted">No usage data.</p>
        ) : (
          <>
            <div className="stat-grid">
              <Stat label="Requests" value={formatInt(summary.requests)} />
              <Stat
                label="Errors"
                value={formatInt(summary.errors)}
                tone={summary.errors > 0 ? "warn" : "good"}
                hint={errorRate === null ? "no traffic" : `${formatPercent(errorRate)} of requests`}
              />
              <Stat label="Prompt tokens" value={formatCompact(summary.prompt_tokens)} />
              <Stat label="Completion tokens" value={formatCompact(summary.completion_tokens)} />
              <Stat label="Cost" value={formatCost(summary.cost)} hint="reported by providers" />
              <Stat label="Avg latency" value={formatMs(summary.avg_latency_ms)} />
              <Stat label="Avg TTFT" value={formatMs(summary.avg_ttft_ms)} hint="time to first token" />
            </div>

            <div className="cache-block">
              <div className="cache-head">
                <span className="stat-label">Prompt cache rate</span>
                <span className="stat-value">{formatPercent(summary.cache_rate)}</span>
              </div>
              <ProgressBar
                ratio={summary.cache_rate}
                label={`Prompt cache hit rate ${formatPercent(summary.cache_rate)}`}
              />
              <p className="muted small">
                {formatCompact(summary.cached_tokens)} of {formatCompact(summary.prompt_tokens)} prompt tokens served from
                provider cache.
              </p>
            </div>

            <h3 className="section-title">Requests over time</h3>
            <BarChart points={series} label={`Requests per bucket over the last ${DEFAULT_WINDOW.label}`} />
          </>
        )}
      </Card>

      <Card title="By provider" subtitle="Window totals per upstream" padded>
        {usage.isPending ? (
          <Loading label="Loading usage" />
        ) : summary === undefined ? (
          <p className="muted">No usage data.</p>
        ) : (
          <AggregateTable rows={summary.by_provider} empty="No provider traffic in this window." />
        )}
      </Card>
    </div>
  )
}

export function AggregateTable({ rows, empty }: { rows: UsageAggregate[]; empty: string }) {
  if (rows.length === 0) return <p className="muted">{empty}</p>
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th className="num">Requests</th>
            <th className="num">Errors</th>
            <th className="num">Prompt</th>
            <th className="num">Completion</th>
            <th className="num">Cache rate</th>
            <th className="num">Cost</th>
            <th className="num">Avg latency</th>
            <th className="num">Avg TTFT</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rate = row.prompt_tokens > 0 ? row.cached_tokens / row.prompt_tokens : null
            return (
              <tr key={row.key}>
                <td className="mono">{row.key.length > 0 ? row.key : "—"}</td>
                <td className="num">{formatInt(row.requests)}</td>
                <td className="num">{row.errors > 0 ? <Badge tone="warn">{formatInt(row.errors)}</Badge> : formatInt(row.errors)}</td>
                <td className="num">{formatCompact(row.prompt_tokens)}</td>
                <td className="num">{formatCompact(row.completion_tokens)}</td>
                <td className="num">{formatPercent(rate)}</td>
                <td className="num">{formatCost(row.cost)}</td>
                <td className="num">{formatMs(row.avg_latency_ms)}</td>
                <td className="num">{formatMs(row.avg_ttft_ms)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
