import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { api, errorMessage } from "../lib/api.ts"
import { COPY } from "../lib/copy.ts"
import { breakerLabel, formatCompact, formatDateTime, formatInt, formatMs } from "../lib/format.ts"
import {
  EMPTY_PROVIDER,
  draftToInput,
  providerToDraft
} from "../lib/forms.ts"
import type { ProviderDraft } from "../lib/forms.ts"
import { useAdminConfig, useRefreshAdmin } from "../lib/queries.ts"
import type { Credits, ProviderDetail, ProviderKind, ProviderTestResult } from "../lib/types.ts"
import {
  Badge,
  Banner,
  Card,
  ConfirmButton,
  ErrorPanel,
  Field,
  Loading,
  Modal,
  PairEditor,
  Toggle
} from "../components/ui.tsx"

const KIND_LABEL: Record<ProviderKind, string> = {
  "openai-chat": "openai-chat",
  "openai-responses": "openai-responses",
  workbuddy2api: "workbuddy2api"
}

const KIND_TONE: Record<ProviderKind, "info" | "neutral" | "warn"> = {
  "openai-chat": "info",
  "openai-responses": "neutral",
  workbuddy2api: "warn"
}

const KINDS: ProviderKind[] = ["openai-chat", "openai-responses", "workbuddy2api"]

export function ProvidersView() {
  const config = useAdminConfig()
  const refresh = useRefreshAdmin()
  const [editing, setEditing] = useState<ProviderDetail | null>(null)
  const [creating, setCreating] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ id: number; result: ProviderTestResult } | null>(null)
  /** A freshly fetched credit snapshot wins over the one embedded in `/config`. */
  const [creditsOverride, setCreditsOverride] = useState<Record<number, Credits | null>>({})

  const toggleEnabled = useMutation({
    mutationFn: (input: { id: number; enabled: boolean }) => api.updateProvider(input.id, { enabled: input.enabled }),
    onSuccess: () => void refresh(),
    onError: (error) => setNotice(errorMessage(error))
  })

  const discover = useMutation({
    mutationFn: (id: number) => api.discoverProvider(id),
    onSuccess: async (result, id) => {
      setNotice(
        result.error !== null
          ? `${result.error}`
          : `Provider ${id}: +${result.created.length} created, -${result.removed.length} removed, ${result.models.length} total.`
      )
      await refresh()
    },
    onError: (error) => setNotice(errorMessage(error))
  })

  const discoverAll = useMutation({
    mutationFn: api.discoverAll,
    onSuccess: async (result) => {
      const failed = result.results.filter((entry) => entry.error !== null)
      setNotice(
        failed.length === 0
          ? `Discovered across ${result.results.length} providers.`
          : `${result.results.length} providers, ${failed.length} failed: ${failed.map((entry) => entry.error).join("; ")}`
      )
      await refresh()
    },
    onError: (error) => setNotice(errorMessage(error))
  })

  const credits = useMutation({
    mutationFn: (id: number) => api.providerCredits(id),
    onSuccess: (result, id) => {
      setCreditsOverride((current) => ({ ...current, [id]: result.credits }))
      if (result.error !== null) setNotice(`Credits: ${result.error}`)
      void refresh()
    },
    onError: (error) => setNotice(errorMessage(error))
  })

  const test = useMutation({
    mutationFn: (input: { id: number; model?: string }) => api.testProvider(input.id, input.model),
    onSuccess: (result, input) => setTestResult({ id: input.id, result }),
    onError: (error) => setNotice(errorMessage(error))
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteProvider(id),
    onSuccess: () => void refresh(),
    onError: (error) => setNotice(errorMessage(error))
  })

  if (config.isPending) return <Loading label="Loading providers" />
  if (config.isError) return <ErrorPanel error={config.error} onRetry={() => void config.refetch()} />

  const settings = config.data.settings
  /** Only the row whose provider is being probed is disabled, not the whole table. */
  const busyWith = (id: number, variables: number | undefined) => variables === id

  return (
    <div className="stack">
      <div className="view-head">
        <h1>Providers</h1>
        <div className="row-actions">
          <button
            type="button"
            className="btn"
            disabled={discoverAll.isPending}
            onClick={() => discoverAll.mutate()}
          >
            {discoverAll.isPending ? "Discovering…" : "Discover all"}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            New provider
          </button>
        </div>
      </div>

      {notice !== null ? <Banner message={notice} onDismiss={() => setNotice(null)} /> : null}

      {testResult !== null ? (
        <Banner
          tone={testResult.result.ok ? "good" : "bad"}
          message={
            testResult.result.ok
              ? `Test ok · ${testResult.result.model} · ${formatMs(testResult.result.latency_ms)} · “${testResult.result.reply}”`
              : `Test failed · ${testResult.result.model}: ${testResult.result.error ?? "unknown error"}`
          }
          onDismiss={() => setTestResult(null)}
        />
      ) : null}

      <Card
        title={`${config.data.providers.length} providers`}
        subtitle={`Default strategy: ${settings.default_strategy} · request timeout ${formatMs(settings.request_timeout_ms)} · discovery every ${settings.discovery_interval_s}s`}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Kind</th>
                <th>Base URL</th>
                <th className="num">Priority</th>
                <th>Enabled</th>
                <th className="num">Models</th>
                <th>Credits</th>
                <th>Breaker</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {config.data.providers.length === 0 ? (
                <tr>
                  <td className="empty" colSpan={9}>
                    No providers yet. Create one to start discovering models.
                  </td>
                </tr>
              ) : null}
              {config.data.providers.map((detail) => {
                const provider = detail.provider
                const snapshot = creditsOverride[provider.id] !== undefined ? creditsOverride[provider.id] : detail.credits
                return (
                  <ProviderRow
                    key={provider.id}
                    detail={detail}
                    credits={snapshot ?? null}
                    isExpanded={expanded === provider.id}
                    busy={busyWith(provider.id, discover.variables) || busyWith(provider.id, credits.variables)}
                    onToggleExpand={() => setExpanded(expanded === provider.id ? null : provider.id)}
                    onToggleEnabled={(enabled) => toggleEnabled.mutate({ id: provider.id, enabled })}
                    onEdit={() => setEditing(detail)}
                    onDiscover={() => discover.mutate(provider.id)}
                    onCredits={() => credits.mutate(provider.id)}
                    onTest={() => test.mutate({ id: provider.id })}
                    onDelete={() => remove.mutate(provider.id)}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {creating ? (
        <ProviderForm
          title="New provider"
          draft={EMPTY_PROVIDER}
          maskedKey={null}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false)
            void refresh()
          }}
        />
      ) : null}

      {editing !== null ? (
        <ProviderForm
          title={`Edit ${editing.provider.name}`}
          draft={providerToDraft(editing.provider)}
          maskedKey={editing.provider.api_key}
          providerId={editing.provider.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function ProviderRow({
  detail,
  credits,
  isExpanded,
  busy,
  onToggleExpand,
  onToggleEnabled,
  onEdit,
  onDiscover,
  onCredits,
  onTest,
  onDelete
}: {
  detail: ProviderDetail
  credits: Credits | null
  isExpanded: boolean
  busy: boolean
  onToggleExpand: () => void
  onToggleEnabled: (enabled: boolean) => void
  onEdit: () => void
  onDiscover: () => void
  onCredits: () => void
  onTest: () => void
  onDelete: () => void
}) {
  const provider = detail.provider
  const status = detail.status
  const open = status.open_until > Date.now()
  const isWorkbuddy = provider.kind === "workbuddy2api"

  return (
    <>
      <tr>
        <td>
          <div className="cell-title">{provider.name}</div>
          <div className="muted small">
            {detail.routed_models.length > 0 ? `${detail.routed_models.length} routed models` : "not routed"}
          </div>
        </td>
        <td>
          <Badge tone={KIND_TONE[provider.kind]}>{KIND_LABEL[provider.kind]}</Badge>
        </td>
        <td className="mono small">{provider.base_url}</td>
        <td className="num">{formatInt(provider.priority)}</td>
        <td>
          <Toggle checked={provider.enabled} ariaLabel={`Enable ${provider.name}`} onChange={onToggleEnabled} />
        </td>
        <td className="num">{formatInt(detail.models.length)}</td>
        <td>
          {isWorkbuddy ? (
            <div className="cell-stack">
              <span>{credits === null ? "—" : formatCompact(credits.total)}</span>
              {credits !== null ? (
                <span className="muted small">
                  {formatInt(credits.healthy)} healthy
                  {credits.fetched_at > 0 ? ` · ${formatDateTime(credits.fetched_at)}` : ""}
                </span>
              ) : null}
              {credits?.error !== null && credits !== null ? (
                <span className="small danger">{credits.error}</span>
              ) : null}
              <div className="row-actions">
                <button type="button" className="btn btn-small" disabled={busy} onClick={onCredits}>
                  Refresh credits
                </button>
                <button type="button" className="btn btn-small" onClick={onToggleExpand}>
                  {isExpanded ? "Hide accounts" : "Accounts"}
                </button>
              </div>
            </div>
          ) : (
            <span className="muted small">n/a</span>
          )}
        </td>
        <td>
          <div className="cell-stack">
            <Badge tone={open ? "bad" : status.consecutive_failures > 0 ? "warn" : "good"}>
              {breakerLabel(status.open_until, status.consecutive_failures)}
            </Badge>
            <span className="muted small">
              {status.last_success_at > 0 ? `ok ${formatDateTime(status.last_success_at)}` : "no success yet"}
            </span>
            {status.last_error !== null ? <span className="small danger">{status.last_error}</span> : null}
          </div>
        </td>
        <td>
          <div className="row-actions">
            <button type="button" className="btn btn-small" onClick={onEdit}>
              Edit
            </button>
            <button type="button" className="btn btn-small" disabled={busy} onClick={onTest}>
              Test
            </button>
            <button type="button" className="btn btn-small" disabled={busy} onClick={onDiscover}>
              Discover
            </button>
            <ConfirmButton onConfirm={onDelete} label="Delete" confirmLabel="Confirm delete" />
          </div>
        </td>
      </tr>
      {isExpanded ? (
        <tr className="detail-row">
          <td colSpan={9}>
            {credits === null ? (
              <p className="muted padded">No credit snapshot yet — press “Refresh credits”.</p>
            ) : (
              <div className="detail-panel">
                <div className="stat-grid">
                  <div className="stat">
                    <span className="stat-label">Total</span>
                    <span className="stat-value">{formatCompact(credits.total)}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Healthy accounts</span>
                    <span className="stat-value">{formatInt(credits.healthy)}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Accounts</span>
                    <span className="stat-value">{formatInt(credits.accounts.length)}</span>
                  </div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>UID</th>
                        <th>Nickname</th>
                        <th>Realm</th>
                        <th className="num">Credits</th>
                        <th>State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {credits.accounts.length === 0 ? (
                        <tr>
                          <td className="empty" colSpan={5}>
                            The upstream reported no accounts.
                          </td>
                        </tr>
                      ) : null}
                      {credits.accounts.map((account) => (
                        <tr key={account.uid}>
                          <td className="mono small">{account.uid}</td>
                          <td>{account.nickname ?? "—"}</td>
                          <td>{account.realm ?? "—"}</td>
                          <td className="num">{formatCompact(account.credits)}</td>
                          <td>
                            {account.disabled === true ? (
                              <Badge tone="bad">{account.disabled_reason ?? "disabled"}</Badge>
                            ) : account.cooling === true ? (
                              <Badge tone="warn">cooling</Badge>
                            ) : (
                              <Badge tone="good">ready</Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  )
}

function ProviderForm({
  title,
  draft,
  maskedKey,
  providerId,
  onClose,
  onSaved
}: {
  title: string
  draft: ProviderDraft
  maskedKey: string | null
  providerId?: number
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<ProviderDraft>(draft)
  const /** The stored secret is only replaced once the operator types into the field. */
    [keyTouched, setKeyTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const patch = (changes: Partial<ProviderDraft>) => setForm((current) => ({ ...current, ...changes }))

  const save = useMutation({
    mutationFn: async () => {
      const input = draftToInput(form, keyTouched)
      if (input.name.length === 0) throw new Error("Name is required")
      if (input.base_url.length === 0) throw new Error("Base URL is required")
      if (providerId === undefined && (input.api_key === undefined || input.api_key.length === 0)) {
        throw new Error("API key is required for a new provider")
      }
      return providerId === undefined ? api.createProvider(input) : api.updateProvider(providerId, input)
    },
    onSuccess: onSaved,
    onError: (failure) => setError(errorMessage(failure))
  })

  return (
    <Modal
      title={title}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : providerId === undefined ? "Create" : "Save"}
          </button>
        </>
      }
    >
      {error !== null ? <Banner tone="bad" message={error} onDismiss={() => setError(null)} /> : null}

      <div className="form-grid">
        <Field label="Name">
          <input
            className="input"
            value={form.name}
            placeholder="my-provider"
            onChange={(event) => patch({ name: event.currentTarget.value })}
          />
        </Field>

        <Field label="Kind" hint="Upstream protocol family">
          <select
            className="input"
            value={form.kind}
            onChange={(event) => patch({ kind: event.currentTarget.value as ProviderKind })}
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Base URL" hint="Origin without a trailing slash">
          <input
            className="input mono"
            value={form.base_url}
            placeholder="https://api.openai.com"
            spellCheck={false}
            onChange={(event) => patch({ base_url: event.currentTarget.value })}
          />
        </Field>

        <Field
          label="API key"
          hint={
            maskedKey === null || maskedKey.length === 0
              ? "Sent as the provider credential; required on create."
              : "Leave untouched to keep the stored key; typing replaces it."
          }
        >
          <input
            className="input mono"
            type="password"
            value={form.api_key}
            placeholder={maskedKey ?? "sk-…"}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setKeyTouched(true)
              patch({ api_key: event.currentTarget.value })
            }}
          />
        </Field>

        <Field label="Priority" hint="Higher wins under priority; the weight under weighted">
          <input
            className="input"
            type="number"
            value={form.priority}
            onChange={(event) => patch({ priority: event.currentTarget.value })}
          />
        </Field>

        <Field label="Max retries" hint="Retryable attempts inside this provider before failover">
          <input
            className="input"
            type="number"
            min={0}
            value={form.max_retries}
            onChange={(event) => patch({ max_retries: event.currentTarget.value })}
          />
        </Field>

        <Field label="Input price" hint="Per 1M prompt tokens; blank = unpriced">
          <input
            className="input"
            value={form.input_price}
            placeholder="0"
            onChange={(event) => patch({ input_price: event.currentTarget.value })}
          />
        </Field>

        <Field label="Output price" hint="Per 1M completion tokens; blank = unpriced">
          <input
            className="input"
            value={form.output_price}
            placeholder="0"
            onChange={(event) => patch({ output_price: event.currentTarget.value })}
          />
        </Field>

        <Field label="Currency">
          <input
            className="input"
            value={form.currency}
            placeholder="USD"
            onChange={(event) => patch({ currency: event.currentTarget.value })}
          />
        </Field>

        <div className="form-span">
          <Toggle checked={form.enabled} label="Enabled" onChange={(enabled) => patch({ enabled })} />
        </div>

        <div className="form-span">
          <span className="field-label">Headers</span>
          <PairEditor
            entries={form.headers}
            onChange={(headers) => patch({ headers })}
            keyPlaceholder="header name"
            valuePlaceholder="value"
            emptyHint="No extra headers. Add one for upstream version pins or auth quirks."
          />
        </div>

        <div className="form-span">
          <span className="field-label">Model rename</span>
          <PairEditor
            entries={form.model_rename}
            onChange={(model_rename) => patch({ model_rename })}
            keyPlaceholder="upstream model id"
            valuePlaceholder="public model id"
            emptyHint="No renames. Left side is the upstream id, right side the public id."
          />
        </div>

        <Field label="Model allowlist" hint="One glob per line; empty allows everything">
          <textarea
            className="input mono"
            rows={4}
            value={form.model_allow}
            placeholder={"gpt-*\no1-*"}
            spellCheck={false}
            onChange={(event) => patch({ model_allow: event.currentTarget.value })}
          />
        </Field>

        <Field label="Model denylist" hint="One glob per line; applied after the allowlist">
          <textarea
            className="input mono"
            rows={4}
            value={form.model_deny}
            placeholder={"*-preview\n*-audio-*"}
            spellCheck={false}
            onChange={(event) => patch({ model_deny: event.currentTarget.value })}
          />
        </Field>
      </div>

      <p className="muted small">
        Prices are per 1M tokens; usage cost totals are reported in{" "}
        {form.currency.trim().length > 0 ? form.currency.trim() : "USD"}.
      </p>
    </Modal>
  )
}
