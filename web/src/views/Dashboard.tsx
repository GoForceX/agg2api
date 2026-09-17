import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react"

import { AggregateTable } from "@/components/AggregateTable"
import { BarChart } from "@/components/BarChart"
import { CacheMeter, ErrorPanel, Loading, Panel, PendingButton, Stat, ToneBadge } from "@/components/common"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { COPY } from "@/lib/copy.ts"
import {
  formatCompact,
  formatCost,
  formatCredits,
  formatDuration,
  formatInt,
  formatMs,
  formatPercent
} from "@/lib/format.ts"
import { DEFAULT_WINDOW, useOverview, useUsage } from "@/lib/queries.ts"

export function DashboardView() {
  const overview = useOverview()
  const usage = useUsage(DEFAULT_WINDOW.windowMs, DEFAULT_WINDOW.bucketMs)

  if (overview.isPending) return <Loading label={COPY.state.loadingOverview} />
  if (overview.isError) return <ErrorPanel error={overview.error} onRetry={() => void overview.refetch()} />

  const data = overview.data
  const summary = usage.data?.summary
  const series = usage.data?.series ?? []
  const errorRate = summary !== undefined && summary.requests > 0 ? summary.errors / summary.requests : null
  /**
   * `overview.routes` counts route rows, not servable ones, so it cannot be used to
   * predict a 404 — a route whose targets all point at deleted providers still counts.
   * Only the provider half of the readiness check is decidable from this payload;
   * `/healthz` owns the full answer.
   */
  const degraded = data.providers_enabled === 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{COPY.dashboard.title}</h1>
          <p className="text-sm text-muted-foreground">{COPY.dashboard.subtitle}</p>
        </div>
        <PendingButton
          variant="outline"
          size="sm"
          pending={usage.isFetching}
          pendingLabel={COPY.state.loading}
          onClick={() => void usage.refetch()}
        >
          <RefreshCwIcon data-icon="inline-start" />
          {COPY.action.refresh}
        </PendingButton>
      </div>

      {/* An instance that cannot serve a single request must not look idle-healthy. */}
      {degraded ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>{COPY.dashboard.degraded}</AlertTitle>
          <AlertDescription>
            {COPY.dashboard.degradedHint(COPY.dashboard.noEnabledProvider)}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-4">
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

      <Panel
        title={COPY.dashboard.trafficTitle(DEFAULT_WINDOW.label)}
        subtitle={COPY.dashboard.trafficSubtitle}
        bodyClassName="p-4"
      >
        {usage.isPending ? (
          <Loading label={COPY.state.loadingUsage} />
        ) : usage.isError ? (
          <ErrorPanel error={usage.error} onRetry={() => void usage.refetch()} />
        ) : summary === undefined ? (
          <p className="text-sm text-muted-foreground">{COPY.dashboard.noUsage}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label={COPY.metric.requests} value={formatInt(summary.requests)} />
              <Stat
                label={COPY.metric.errors}
                value={formatInt(summary.errors)}
                tone={summary.errors > 0 ? "warn" : "good"}
                hint={
                  errorRate === null ? COPY.dashboard.noTraffic : COPY.dashboard.errorRateHint(formatPercent(errorRate))
                }
              />
              <Stat label={COPY.metric.promptTokens} value={formatCompact(summary.prompt_tokens)} />
              <Stat label={COPY.metric.completionTokens} value={formatCompact(summary.completion_tokens)} />
              <Stat
                label={COPY.metric.cost}
                value={formatCost(summary.cost)}
                // A total summed across currencies is not a single amount; say so rather
                // than showing one bare number the operator would read as comparable.
                hint={
                  summary.currencies.length > 1
                    ? COPY.dashboard.costMixedCurrency(summary.currencies.join(" / "))
                    : COPY.dashboard.costHint
                }
              />
              <Stat label={COPY.metric.avgLatency} value={formatMs(summary.avg_latency_ms)} />
              <Stat label={COPY.metric.avgTtft} value={formatMs(summary.avg_ttft_ms)} hint={COPY.dashboard.ttftHint} />
            </div>

            <CacheMeter
              ratio={summary.cache_rate}
              label={COPY.dashboard.cacheBarLabel(formatPercent(summary.cache_rate))}
              note={COPY.dashboard.cacheNote(
                formatCompact(summary.cached_tokens),
                formatCompact(summary.prompt_tokens)
              )}
            />

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{COPY.chart.requestsOverTime}</h3>
              <BarChart points={series} label={COPY.chart.label(DEFAULT_WINDOW.label)} />
            </div>
          </div>
        )}
      </Panel>

      <Panel
        title={COPY.dashboard.byProvider}
        subtitle={COPY.dashboard.byProviderHint}
        actions={summary === undefined ? undefined : <ToneBadge tone="info">{formatInt(summary.by_provider.length)}</ToneBadge>}
      >
        {usage.isPending ? (
          <Loading label={COPY.state.loadingUsage} />
        ) : summary === undefined ? (
          <div className="p-4">
            <p className="text-sm text-muted-foreground">{COPY.dashboard.noUsage}</p>
          </div>
        ) : (
          <AggregateTable rows={summary.by_provider} empty={COPY.dashboard.noProviderTraffic} />
        )}
      </Panel>
    </div>
  )
}
