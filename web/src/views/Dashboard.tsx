import { COPY } from "../lib/copy.ts"
import { formatCredits, formatCompact, formatCost, formatDuration, formatInt, formatMs, formatPercent } from "../lib/format.ts"
import { DEFAULT_WINDOW, useOverview, useUsage } from "../lib/queries.ts"
import type { UsageAggregate } from "../lib/types.ts"
import { BarChart } from "../components/BarChart.tsx"
import { Badge, Card, ErrorPanel, Loading, ProgressBar, Stat } from "../components/ui.tsx"

export function DashboardView() {
  const overview = useOverview()
  const usage = useUsage(DEFAULT_WINDOW.windowMs, DEFAULT_WINDOW.bucketMs)

  if (overview.isPending) return <Loading label={COPY.state.loadingOverview} />
  if (overview.isError) return <ErrorPanel error={overview.error} onRetry={() => void overview.refetch()} />

  const data = overview.data
  const summary = usage.data?.summary
  const series = usage.data?.series ?? []
  const errorRate = summary !== undefined && summary.requests > 0 ? summary.errors / summary.requests : null

  return (
    <div className="stack">
      <h1>{COPY.dashboard.title}</h1>

      <div className="stat-grid">
        <Stat
          label={COPY.dashboard.providers}
          value={`${formatInt(data.providers_enabled)} / ${formatInt(data.providers_total)}`}
          hint={COPY.dashboard.providersRatio}
        />
        <Stat
          label={COPY.dashboard.breakersOpen}
          value={formatInt(data.providers_open)}
          tone={data.providers_open > 0 ? "bad" : "good"}
          hint={COPY.dashboard.breakersHint}
        />
        <Stat label={COPY.dashboard.models} value={formatInt(data.models)} hint={COPY.dashboard.modelsHint} />
        <Stat label={COPY.dashboard.routes} value={formatInt(data.routes)} hint={COPY.dashboard.routesHint} />
        <Stat label={COPY.dashboard.keys} value={formatInt(data.keys)} hint={COPY.dashboard.keysHint} />
        <Stat
          label={COPY.dashboard.credits}
          value={formatCredits(data.credits_total)}
          hint={COPY.dashboard.creditsHint}
          tone={data.credits_total <= 0 ? "warn" : undefined}
        />
        <Stat
          label={COPY.dashboard.sessions}
          value={
            data.sessions.lookups === 0
              ? "—"
              : `${formatInt(Math.round((data.sessions.hits / data.sessions.lookups) * 100))}%`
          }
          hint={
            data.sessions.tracked === 0
              ? COPY.dashboard.sessionsHint(data.sessions.tracked)
              : COPY.dashboard.sessionsReuse(data.sessions.tracked, data.sessions.hits)
          }
        />
        <Stat label={COPY.dashboard.uptime} value={formatDuration(data.uptime_s)} hint={COPY.dashboard.uptimeHint} />
      </div>

      <Card
        title={COPY.dashboard.trafficTitle(DEFAULT_WINDOW.label)}
        subtitle={COPY.dashboard.trafficSubtitle}
        actions={
          <button type="button" className="btn btn-small" onClick={() => void usage.refetch()}>
            {COPY.action.refresh}
          </button>
        }
        padded
      >
        {usage.isPending ? (
          <Loading label={COPY.state.loadingUsage} />
        ) : usage.isError ? (
          <ErrorPanel error={usage.error} onRetry={() => void usage.refetch()} />
        ) : summary === undefined ? (
          <p className="muted">{COPY.dashboard.noUsage}</p>
        ) : (
          <>
            <div className="stat-grid">
              <Stat label={COPY.metric.requests} value={formatInt(summary.requests)} />
              <Stat
                label={COPY.metric.errors}
                value={formatInt(summary.errors)}
                tone={summary.errors > 0 ? "warn" : "good"}
                hint={errorRate === null ? COPY.dashboard.noTraffic : COPY.dashboard.errorRateHint(formatPercent(errorRate))}
              />
              <Stat label={COPY.metric.promptTokens} value={formatCompact(summary.prompt_tokens)} />
              <Stat label={COPY.metric.completionTokens} value={formatCompact(summary.completion_tokens)} />
              <Stat label={COPY.metric.cost} value={formatCost(summary.cost)} hint={COPY.dashboard.costHint} />
              <Stat label={COPY.metric.avgLatency} value={formatMs(summary.avg_latency_ms)} />
              <Stat label={COPY.metric.avgTtft} value={formatMs(summary.avg_ttft_ms)} hint={COPY.dashboard.ttftHint} />
            </div>

            <div className="cache-block">
              <div className="cache-head">
                <span className="stat-label">{COPY.metric.cacheRate}</span>
                <span className="stat-value">{formatPercent(summary.cache_rate)}</span>
              </div>
              <ProgressBar
                ratio={summary.cache_rate}
                label={COPY.dashboard.cacheBarLabel(formatPercent(summary.cache_rate))}
              />
              <p className="muted small">
                {COPY.dashboard.cacheNote(
                  formatCompact(summary.cached_tokens),
                  formatCompact(summary.prompt_tokens)
                )}
              </p>
            </div>

            <h3 className="section-title">{COPY.chart.requestsOverTime}</h3>
            <BarChart points={series} label={COPY.chart.label(DEFAULT_WINDOW.label)} />
          </>
        )}
      </Card>

      <Card title={COPY.dashboard.byProvider} subtitle={COPY.dashboard.byProviderHint} padded>
        {usage.isPending ? (
          <Loading label={COPY.state.loadingUsage} />
        ) : summary === undefined ? (
          <p className="muted">{COPY.dashboard.noUsage}</p>
        ) : (
          <AggregateTable rows={summary.by_provider} empty={COPY.dashboard.noProviderTraffic} />
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
            <th>{COPY.dashboard.aggregateKey}</th>
            <th className="num">{COPY.column.requests}</th>
            <th className="num">{COPY.column.errors}</th>
            <th className="num">{COPY.column.promptTokens}</th>
            <th className="num">{COPY.column.completionTokens}</th>
            <th className="num">{COPY.column.cacheRate}</th>
            <th className="num">{COPY.column.cost}</th>
            <th className="num">{COPY.column.avgLatency}</th>
            <th className="num">{COPY.column.avgTtft}</th>
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
