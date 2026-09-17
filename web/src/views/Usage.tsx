import { useMemo, useState } from "react"
import { ActivityIcon, RefreshCwIcon } from "lucide-react"

import { AggregateTable } from "@/components/AggregateTable"
import { BarChart } from "@/components/BarChart"
import { RangeSelector, type RangeSelection } from "@/components/RangeSelector"
import { ErrorPanel, Loading, Panel, PendingButton, Stat, ToneBadge } from "@/components/common"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { COPY } from "@/lib/copy.ts"
import {
  formatBucket,
  formatCompact,
  formatCost,
  formatDateTime,
  formatInt,
  formatMs,
  formatRangeLabel,
  formatTps
} from "@/lib/format.ts"
import { parseUsageLog } from "@/lib/log.ts"
import { RANGE_POINTS, WINDOWS, useAdminConfig, useUsage, useUsageLog, useUsageOverview } from "@/lib/queries.ts"
import type { UsageLogRow } from "@/lib/types.ts"

const PAGE_SIZE = 50
const ALL = "__all__"

type Tab = "model" | "provider" | "key"

export function UsageView() {
  const config = useAdminConfig()
  const [windowId, setWindowId] = useState<string>(WINDOWS[1].id)
  const selected = WINDOWS.find((window) => window.id === windowId) ?? WINDOWS[1]

  /** A slice chosen on the chart; cleared whenever the window changes, since the old
      bounds may not lie inside the new one. */
  const [selection, setSelection] = useState<RangeSelection | null>(null)
  const usage = useUsage(selected.windowMs, selected.bucketMs, selection ?? undefined)
  const backdrop = useUsageOverview(selected.windowMs, RANGE_POINTS)
  const summary = usage.data?.summary
  /** What the rendered payload actually covers; falls back to the request while loading. */
  const shown = usage.data === undefined ? null : { from: usage.data.from, to: usage.data.to, bucket_ms: usage.data.bucket_ms }

  const [tab, setTab] = useState<Tab>("model")
  const [model, setModel] = useState("")
  const [providerId, setProviderId] = useState("")
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [page, setPage] = useState(0)

  const logParams = useMemo(
    () => ({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      model: model.length > 0 ? model : undefined,
      provider_id: providerId.length > 0 ? Number(providerId) : undefined,
      errors_only: errorsOnly ? true : undefined
    }),
    [page, model, providerId, errorsOnly]
  )
  const log = useUsageLog(logParams)
  const rows = parseUsageLog(log.data)

  /** Filter changes must restart paging, otherwise the offset points past the new result set. */
  const applyFilter = (change: () => void) => {
    change()
    setPage(0)
  }

  const modelOptions = useMemo(() => {
    if (config.data === undefined) return []
    const names = new Set<string>()
    for (const route of config.data.routes) names.add(route.public_model)
    for (const detail of config.data.providers) for (const discovered of detail.models) names.add(discovered.public_id)
    return [...names].sort((left, right) => left.localeCompare(right))
  }, [config.data])

  const modelItems: ReadonlyArray<{ value: string; label: string }> = [
    { value: ALL, label: COPY.usage.allModels },
    ...modelOptions.map((name) => ({ value: name, label: name }))
  ]
  const providerItems: ReadonlyArray<{ value: string; label: string }> = [
    { value: ALL, label: COPY.usage.allProviders },
    ...(config.data?.providers ?? []).map((detail) => ({
      value: String(detail.provider.id),
      label: detail.provider.name
    }))
  ]

  const totalPages = Math.max(1, Math.ceil((log.data?.total ?? 0) / PAGE_SIZE))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{COPY.usage.title}</h1>
          <p className="text-sm text-muted-foreground">{COPY.usage.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            items={WINDOWS.map((window) => ({ value: window.id, label: window.label }))}
            value={windowId}
            onValueChange={(value) => {
              setWindowId(value ?? WINDOWS[1].id)
              setSelection(null)
              setPage(0)
            }}
          >
            <SelectTrigger className="w-32" aria-label={COPY.usage.window}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {WINDOWS.map((window) => (
                  <SelectItem key={window.id} value={window.id}>
                    {window.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <PendingButton
            variant="outline"
            pending={usage.isFetching}
            pendingLabel={COPY.state.loading}
            onClick={() => void usage.refetch()}
          >
            <RefreshCwIcon data-icon="inline-start" />
            {COPY.action.refresh}
          </PendingButton>
        </div>
      </div>

      <Panel
        // Described from the response, not from the request: the range and the bucket are
        // derived server-side, and `placeholderData` keeps the previous response on screen
        // while the next is in flight — so anything read from local state would label the
        // displayed figures with the *requested* window instead of the one they cover.
        // With no selection the dropdown already names the window exactly, so the friendly
        // label is both shorter and unambiguous. A selection is stated as the absolute range
        // the payload covers, which stays right even while the previous response is on
        // screen under `placeholderData`.
        title={
          selection === null || shown === null
            ? COPY.usage.totalsLast(selected.label)
            : COPY.usage.totalsIn(formatRangeLabel(shown.from, shown.to))
        }
        subtitle={COPY.usage.bucketEvery(formatBucket(shown?.bucket_ms ?? selected.bucketMs))}
        bodyClassName="p-4"
      >
        {usage.isPending ? (
          <Loading label={COPY.state.loadingUsage} />
        ) : usage.isError ? (
          <ErrorPanel error={usage.error} onRetry={() => void usage.refetch()} />
        ) : summary === undefined ? (
          <p className="text-sm text-muted-foreground">{COPY.usage.empty}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
              <Stat label={COPY.metric.requests} value={formatInt(summary.requests)} />
              <Stat
                label={COPY.metric.errors}
                value={formatInt(summary.errors)}
                tone={summary.errors > 0 ? "warn" : "good"}
              />
              <Stat label={COPY.metric.promptTokens} value={formatCompact(summary.prompt_tokens)} />
              <Stat label={COPY.metric.completionTokens} value={formatCompact(summary.completion_tokens)} />
              <Stat label={COPY.metric.cachedTokens} value={formatCompact(summary.cached_tokens)} />
              <Stat label={COPY.usage.reasoningTokens} value={formatCompact(summary.reasoning_tokens)} />
              <Stat
                label={COPY.metric.cost}
                value={formatCost(summary.cost)}
                hint={
                  summary.currencies.length > 1
                    ? COPY.dashboard.costMixedCurrency(summary.currencies.join(" / "))
                    : undefined
                }
              />
              <Stat label={COPY.metric.avgLatency} value={formatMs(summary.avg_latency_ms)} />
              <Stat label={COPY.metric.avgTtft} value={formatMs(summary.avg_ttft_ms)} />
              <Stat
                label={COPY.metric.tps}
                value={formatTps(summary.avg_tps)}
                hint={COPY.metric.tpsHint}
              />
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{COPY.chart.requestsOverTime}</h3>
              <BarChart points={usage.data?.series ?? []} label={COPY.chart.label(selected.label)} />
              {backdrop.data === undefined ? null : (
                <RangeSelector
                  series={backdrop.data.series}
                  from={backdrop.data.from}
                  to={backdrop.data.to}
                  longSpan={selected.windowMs >= 86_400_000}
                  selection={selection}
                  onSelect={setSelection}
                  onReset={() => setSelection(null)}
                />
              )}
            </div>
          </div>
        )}
      </Panel>

      <Panel title={COPY.usage.breakdown}>
        {summary === undefined ? (
          <div className="p-4">
            <p className="text-sm text-muted-foreground">{COPY.usage.empty}</p>
          </div>
        ) : (
          <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="gap-0">
            <div className="border-b p-2">
              <TabsList>
                <TabsTrigger value="model">{COPY.usage.byModel}</TabsTrigger>
                <TabsTrigger value="provider">{COPY.usage.byProvider}</TabsTrigger>
                <TabsTrigger value="key">{COPY.usage.byKey}</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="model">
              <AggregateTable rows={summary.by_model} empty={COPY.usage.noModelTraffic} />
            </TabsContent>
            <TabsContent value="provider">
              <AggregateTable rows={summary.by_provider} empty={COPY.dashboard.noProviderTraffic} />
            </TabsContent>
            <TabsContent value="key">
              <AggregateTable rows={summary.by_key} empty={COPY.usage.noKeyTraffic} />
            </TabsContent>
          </Tabs>
        )}
      </Panel>

      <Panel
        title={COPY.usage.log}
        subtitle={COPY.usage.logHint}
        actions={
          <Button variant="outline" size="sm" onClick={() => void log.refetch()}>
            <RefreshCwIcon data-icon="inline-start" />
            {COPY.action.refresh}
          </Button>
        }
      >
        <div className="flex flex-wrap items-end gap-4 border-b p-4">
          <Field className="w-56">
            <FieldLabel htmlFor="log-model">{COPY.column.model}</FieldLabel>
            <Select
              items={modelItems}
              value={model.length === 0 ? ALL : model}
              onValueChange={(value) => applyFilter(() => setModel(value === null || value === ALL ? "" : value))}
            >
              <SelectTrigger id="log-model" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {modelItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field className="w-48">
            <FieldLabel htmlFor="log-provider">{COPY.column.provider}</FieldLabel>
            <Select
              items={providerItems}
              value={providerId.length === 0 ? ALL : providerId}
              onValueChange={(value) =>
                applyFilter(() => setProviderId(value === null || value === ALL ? "" : value))
              }
            >
              <SelectTrigger id="log-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {providerItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field orientation="horizontal" className="w-auto pb-1">
            <Switch
              id="log-errors"
              checked={errorsOnly}
              onCheckedChange={(next) => applyFilter(() => setErrorsOnly(next))}
            />
            <FieldLabel htmlFor="log-errors">{COPY.usage.onlyErrors}</FieldLabel>
          </Field>
        </div>

        {log.isError ? (
          <ErrorPanel error={log.error} onRetry={() => void log.refetch()} />
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ActivityIcon />
              </EmptyMedia>
              <EmptyTitle>{COPY.state.empty}</EmptyTitle>
              <EmptyDescription>{log.isPending ? COPY.state.loading : COPY.usage.noLog}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{COPY.column.time}</TableHead>
                  <TableHead>{COPY.usage.requestId}</TableHead>
                  <TableHead>{COPY.column.endpoint}</TableHead>
                  <TableHead>{COPY.column.model}</TableHead>
                  <TableHead>{COPY.column.provider}</TableHead>
                  <TableHead className="text-right">{COPY.column.promptTokens}</TableHead>
                  <TableHead className="text-right">{COPY.column.completionTokens}</TableHead>
                  <TableHead className="text-right">{COPY.column.cachedTokens}</TableHead>
                  <TableHead className="text-right">{COPY.column.cost}</TableHead>
                  <TableHead className="text-right">{COPY.column.attempts}</TableHead>
                  <TableHead>{COPY.column.status}</TableHead>
                  <TableHead className="text-right">{COPY.column.latency}</TableHead>
                  <TableHead className="text-right">{COPY.usage.ttft}</TableHead>
                  <TableHead className="text-right">{COPY.column.tps}</TableHead>
                  <TableHead>{COPY.column.clientKey}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <LogRowView key={row.request_id} row={row} />
                ))}
              </TableBody>
              {log.data !== undefined ? (
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={5}>{COPY.usage.filteredTotals(formatInt(log.data.total))}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCompact(log.data.totals.prompt_tokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCompact(log.data.totals.completion_tokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCompact(log.data.totals.cached_tokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatCost(log.data.totals.cost)}</TableCell>
                    <TableCell colSpan={6} />
                  </TableRow>
                </TableFooter>
              ) : null}
            </Table>
          </div>
        )}

        {rows.length === 0 ? null : (
          <div className="flex items-center justify-between gap-3 border-t px-4 py-3 text-sm">
            <span className="text-muted-foreground">
              {COPY.pager.pageOf(page + 1, totalPages)}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                {COPY.action.previous}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                {COPY.action.next}
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </div>
  )
}

function LogRowView({ row }: { row: UsageLogRow }) {
  const failed = row.status >= 400 || row.error_kind !== null
  return (
    <TableRow className={failed ? "bg-destructive/5" : undefined}>
      <TableCell className="text-xs whitespace-nowrap">{formatDateTime(row.ts)}</TableCell>
      <TableCell className="font-mono text-xs" title={row.request_id}>
        {row.request_id.slice(0, 8)}
        {row.stream ? " ⇢" : ""}
      </TableCell>
      <TableCell className="text-xs">{row.endpoint}</TableCell>
      <TableCell className="font-mono text-xs">{row.public_model}</TableCell>
      <TableCell className="text-xs">{row.provider_name ?? "—"}</TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(row.prompt_tokens)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(row.completion_tokens)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(row.cached_tokens)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCost(row.cost)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(row.attempts)}</TableCell>
      <TableCell>
        {failed ? (
          <div className="flex flex-col gap-1">
            <ToneBadge tone="bad">{formatInt(row.status)}</ToneBadge>
            {row.error_kind !== null ? (
              <span className="text-xs text-destructive">{row.error_kind}</span>
            ) : null}
            {row.error_message !== null ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="max-w-48 truncate text-xs text-muted-foreground">
                      {row.error_message}
                    </span>
                  }
                />
                <TooltipContent>{row.error_message}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        ) : (
          <ToneBadge tone="good">{formatInt(row.status)}</ToneBadge>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatMs(row.latency_ms)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatMs(row.ttft_ms)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatTps(row.tps)}</TableCell>
      <TableCell className="text-xs">{row.api_key_name ?? "—"}</TableCell>
    </TableRow>
  )
}
