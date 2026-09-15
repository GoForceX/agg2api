import { useMemo, useState } from "react"
import { COPY } from "../lib/copy.ts"
import { formatCompact, formatCost, formatDateTime, formatInt, formatMs } from "../lib/format.ts"
import { parseUsageLog } from "../lib/log.ts"
import { WINDOWS, useAdminConfig, useUsage, useUsageLog } from "../lib/queries.ts"
import type { UsageLogRow } from "../lib/types.ts"
import { BarChart } from "../components/BarChart.tsx"
import { AggregateTable } from "./Dashboard.tsx"
import { Badge, Card, ErrorPanel, Field, Loading, Pagination, Stat, Toggle } from "../components/ui.tsx"

const PAGE_SIZE = 50

type Tab = "model" | "provider" | "key"

const TAB_LABEL: Record<Tab, string> = {
  model: COPY.usage.byModel,
  provider: COPY.usage.byProvider,
  key: COPY.usage.byKey
}

export function UsageView() {
  const config = useAdminConfig()
  const [windowId, setWindowId] = useState<string>(WINDOWS[1].id)
  const selected = WINDOWS.find((window) => window.id === windowId) ?? WINDOWS[1]

  const usage = useUsage(selected.windowMs, selected.bucketMs)
  const summary = usage.data?.summary

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

  return (
    <div className="stack">
      <div className="view-head">
        <h1>{COPY.usage.title}</h1>
        <div className="row-actions">
          <label className="inline-field">
            <span className="field-label">{COPY.usage.window}</span>
            <select
              className="input"
              value={windowId}
              onChange={(event) => {
                setWindowId(event.currentTarget.value)
                setPage(0)
              }}
            >
              {WINDOWS.map((window) => (
                <option key={window.id} value={window.id}>
                  {window.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn" onClick={() => void usage.refetch()}>
            {COPY.action.refresh}
          </button>
        </div>
      </div>

      <Card
        title={COPY.usage.totalsLast(selected.label)}
        subtitle={COPY.usage.bucketEvery(formatMs(selected.bucketMs))}
        padded
      >
        {usage.isPending ? (
          <Loading label={COPY.state.loadingUsage} />
        ) : usage.isError ? (
          <ErrorPanel error={usage.error} onRetry={() => void usage.refetch()} />
        ) : summary === undefined ? (
          <p className="muted">{COPY.usage.empty}</p>
        ) : (
          <>
            <div className="stat-grid">
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
              <Stat label={COPY.metric.cost} value={formatCost(summary.cost)} />
              <Stat label={COPY.metric.avgLatency} value={formatMs(summary.avg_latency_ms)} />
              <Stat label={COPY.metric.avgTtft} value={formatMs(summary.avg_ttft_ms)} />
            </div>
            <h3 className="section-title">{COPY.usage.requestsOverTime}</h3>
            <BarChart points={usage.data?.series ?? []} label={COPY.usage.chartLabel(selected.label)} />
          </>
        )}
      </Card>

      <Card
        title={COPY.usage.breakdown}
        actions={
          <div className="tabs" role="tablist">
            {(["model", "provider", "key"] as Tab[]).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? "tab tab-active" : "tab"}
                onClick={() => setTab(id)}
              >
                {TAB_LABEL[id]}
              </button>
            ))}
          </div>
        }
        padded
      >
        {summary === undefined ? (
          <p className="muted">{COPY.usage.empty}</p>
        ) : tab === "model" ? (
          <AggregateTable rows={summary.by_model} empty={COPY.usage.noModelTraffic} />
        ) : tab === "provider" ? (
          <AggregateTable rows={summary.by_provider} empty={COPY.dashboard.noProviderTraffic} />
        ) : (
          <AggregateTable rows={summary.by_key} empty={COPY.usage.noKeyTraffic} />
        )}
      </Card>

      <Card
        title={COPY.usage.log}
        subtitle={COPY.usage.logHint}
        actions={
          <button type="button" className="btn btn-small" onClick={() => void log.refetch()}>
            {COPY.action.refresh}
          </button>
        }
      >
        <div className="filter-bar">
          <Field label={COPY.column.model}>
            <select
              className="input"
              value={model}
              onChange={(event) => applyFilter(() => setModel(event.currentTarget.value))}
            >
              <option value="">{COPY.usage.allModels}</option>
              {modelOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Field>

          <Field label={COPY.column.provider}>
            <select
              className="input"
              value={providerId}
              onChange={(event) => applyFilter(() => setProviderId(event.currentTarget.value))}
            >
              <option value="">{COPY.usage.allProviders}</option>
              {(config.data?.providers ?? []).map((detail) => (
                <option key={detail.provider.id} value={String(detail.provider.id)}>
                  {detail.provider.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="filter-toggle">
            <Toggle
              checked={errorsOnly}
              label={COPY.usage.onlyErrors}
              onChange={(next) => applyFilter(() => setErrorsOnly(next))}
            />
          </div>
        </div>

        {log.isError ? (
          <ErrorPanel error={log.error} onRetry={() => void log.refetch()} />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{COPY.column.time}</th>
                    <th>{COPY.usage.requestId}</th>
                    <th>{COPY.column.endpoint}</th>
                    <th>{COPY.column.model}</th>
                    <th>{COPY.column.provider}</th>
                    <th className="num">{COPY.column.promptTokens}</th>
                    <th className="num">{COPY.column.completionTokens}</th>
                    <th className="num">{COPY.column.cachedTokens}</th>
                    <th className="num">{COPY.column.cost}</th>
                    <th className="num">{COPY.column.attempts}</th>
                    <th>{COPY.column.status}</th>
                    <th className="num">{COPY.column.latency}</th>
                    <th className="num">{COPY.usage.ttft}</th>
                    <th>{COPY.column.clientKey}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td className="empty" colSpan={14}>
                        {log.isPending ? COPY.state.loading : COPY.usage.noLog}
                      </td>
                    </tr>
                  ) : null}
                  {rows.map((row) => (
                    <LogRowView key={row.request_id} row={row} />
                  ))}
                </tbody>
                {log.data !== undefined ? (
                  <tfoot>
                    <tr>
                      <td colSpan={5}>{COPY.usage.filteredTotals(formatInt(log.data.total))}</td>
                      <td className="num">{formatCompact(log.data.totals.prompt_tokens)}</td>
                      <td className="num">{formatCompact(log.data.totals.completion_tokens)}</td>
                      <td className="num">{formatCompact(log.data.totals.cached_tokens)}</td>
                      <td className="num">{formatCost(log.data.totals.cost)}</td>
                      <td colSpan={5} />
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={log.data?.total ?? 0}
              onPage={setPage}
            />
          </>
        )}
      </Card>
    </div>
  )
}

function LogRowView({ row }: { row: UsageLogRow }) {
  const failed = row.status >= 400 || row.error_kind !== null
  return (
    <tr className={failed ? "row-failed" : undefined}>
      <td className="small">{formatDateTime(row.ts)}</td>
      <td className="mono small" title={row.request_id}>
        {row.request_id.slice(0, 8)}
        {row.stream ? " ⇢" : ""}
      </td>
      <td className="small">{row.endpoint}</td>
      <td className="mono small">{row.public_model}</td>
      <td className="small">{row.provider_name ?? "—"}</td>
      <td className="num">{formatInt(row.prompt_tokens)}</td>
      <td className="num">{formatInt(row.completion_tokens)}</td>
      <td className="num">{formatInt(row.cached_tokens)}</td>
      <td className="num">{formatCost(row.cost)}</td>
      <td className="num">{formatInt(row.attempts)}</td>
      <td>
        {failed ? (
          <span className="cell-stack">
            <Badge tone="bad">{formatInt(row.status)}</Badge>
            {row.error_kind !== null ? <span className="small danger">{row.error_kind}</span> : null}
            {row.error_message !== null ? (
              <span className="muted small" title={row.error_message}>
                {row.error_message}
              </span>
            ) : null}
          </span>
        ) : (
          <Badge tone="good">{formatInt(row.status)}</Badge>
        )}
      </td>
      <td className="num">{formatMs(row.latency_ms)}</td>
      <td className="num">{formatMs(row.ttft_ms)}</td>
      <td className="small">{row.api_key_name ?? "—"}</td>
    </tr>
  )
}
