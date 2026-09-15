import { useMemo, useState } from "react"
import { formatCompact, formatCost, formatDateTime, formatInt, formatMs } from "../lib/format.ts"
import { parseUsageLog } from "../lib/log.ts"
import { WINDOWS, useAdminConfig, useUsage, useUsageLog } from "../lib/queries.ts"
import type { UsageLogRow } from "../lib/types.ts"
import { BarChart } from "../components/BarChart.tsx"
import { AggregateTable } from "./Dashboard.tsx"
import { Badge, Card, ErrorPanel, Field, Loading, Pagination, Stat, Toggle } from "../components/ui.tsx"

const PAGE_SIZE = 50

type Tab = "model" | "provider" | "key"

const TAB_LABEL: Record<Tab, string> = { model: "By model", provider: "By provider", key: "By key" }

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
        <h1>Usage</h1>
        <div className="row-actions">
          <label className="inline-field">
            <span className="field-label">Window</span>
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
            Refresh
          </button>
        </div>
      </div>

      <Card title={`Totals · last ${selected.label}`} subtitle={`Bucketed every ${formatMs(selected.bucketMs)}`} padded>
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
              <Stat label="Errors" value={formatInt(summary.errors)} tone={summary.errors > 0 ? "warn" : "good"} />
              <Stat label="Prompt tokens" value={formatCompact(summary.prompt_tokens)} />
              <Stat label="Completion tokens" value={formatCompact(summary.completion_tokens)} />
              <Stat label="Cached tokens" value={formatCompact(summary.cached_tokens)} />
              <Stat label="Reasoning tokens" value={formatCompact(summary.reasoning_tokens)} />
              <Stat label="Cost" value={formatCost(summary.cost)} />
              <Stat label="Avg latency" value={formatMs(summary.avg_latency_ms)} />
              <Stat label="Avg TTFT" value={formatMs(summary.avg_ttft_ms)} />
            </div>
            <h3 className="section-title">Requests over time</h3>
            <BarChart points={usage.data?.series ?? []} label={`Requests per bucket over the last ${selected.label}`} />
          </>
        )}
      </Card>

      <Card
        title="Breakdown"
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
          <p className="muted">No usage data.</p>
        ) : tab === "model" ? (
          <AggregateTable rows={summary.by_model} empty="No model traffic in this window." />
        ) : tab === "provider" ? (
          <AggregateTable rows={summary.by_provider} empty="No provider traffic in this window." />
        ) : (
          <AggregateTable rows={summary.by_key} empty="No key traffic in this window." />
        )}
      </Card>

      <Card
        title="Request log"
        subtitle="Newest first, filtered by the controls below"
        actions={
          <button type="button" className="btn btn-small" onClick={() => void log.refetch()}>
            Refresh
          </button>
        }
      >
        <div className="filter-bar">
          <Field label="Model">
            <select
              className="input"
              value={model}
              onChange={(event) => applyFilter(() => setModel(event.currentTarget.value))}
            >
              <option value="">all models</option>
              {modelOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Provider">
            <select
              className="input"
              value={providerId}
              onChange={(event) => applyFilter(() => setProviderId(event.currentTarget.value))}
            >
              <option value="">all providers</option>
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
              label="Errors only"
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
                    <th>Time</th>
                    <th>Request</th>
                    <th>Endpoint</th>
                    <th>Model</th>
                    <th>Provider</th>
                    <th className="num">Prompt</th>
                    <th className="num">Completion</th>
                    <th className="num">Cached</th>
                    <th className="num">Cost</th>
                    <th className="num">Attempts</th>
                    <th>Status</th>
                    <th className="num">Latency</th>
                    <th className="num">TTFT</th>
                    <th>Key</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td className="empty" colSpan={14}>
                        {log.isPending ? "Loading…" : "No requests match these filters."}
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
                      <td colSpan={5}>Filtered totals · {formatInt(log.data.total)} rows</td>
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
