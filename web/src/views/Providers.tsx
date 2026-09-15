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
          : COPY.providers.discoverResult(
              id,
              result.created.length,
              result.removed.length,
              result.models.length
            )
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
          ? COPY.providers.discoverAllOk(result.results.length)
          : COPY.providers.discoverAllFailed(
              result.results.length,
              failed.length,
              failed.map((entry) => entry.error).join("; ")
            )
      )
      await refresh()
    },
    onError: (error) => setNotice(errorMessage(error))
  })

  const credits = useMutation({
    mutationFn: (id: number) => api.providerCredits(id),
    onSuccess: (result, id) => {
      setCreditsOverride((current) => ({ ...current, [id]: result.credits }))
      if (result.error !== null) setNotice(COPY.providers.creditsFailed(result.error))
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

  if (config.isPending) return <Loading label={COPY.state.loadingProviders} />
  if (config.isError) return <ErrorPanel error={config.error} onRetry={() => void config.refetch()} />

  const settings = config.data.settings
  /** Only the row whose provider is being probed is disabled, not the whole table. */
  const busyWith = (id: number, variables: number | undefined) => variables === id

  return (
    <div className="stack">
      <div className="view-head">
        <h1>{COPY.providers.title}</h1>
        <div className="row-actions">
          <button
            type="button"
            className="btn"
            disabled={discoverAll.isPending}
            onClick={() => discoverAll.mutate()}
          >
            {discoverAll.isPending ? COPY.providers.discoveringAll : COPY.providers.discoverAll}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            {COPY.providers.add}
          </button>
        </div>
      </div>

      {notice !== null ? <Banner message={notice} onDismiss={() => setNotice(null)} /> : null}

      {testResult !== null ? (
        <Banner
          tone={testResult.result.ok ? "good" : "bad"}
          message={
            testResult.result.ok
              ? COPY.providers.testOk(
                  testResult.result.model,
                  formatMs(testResult.result.latency_ms),
                  testResult.result.reply
                )
              : COPY.providers.testFailed(
                  testResult.result.model,
                  testResult.result.error ?? COPY.state.unknown
                )
          }
          onDismiss={() => setTestResult(null)}
        />
      ) : null}

      <Card
        title={COPY.providers.listTitle(config.data.providers.length)}
        subtitle={COPY.providers.settingsLine(
          COPY.strategies[settings.default_strategy],
          formatMs(settings.request_timeout_ms),
          String(settings.discovery_interval_s)
        )}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{COPY.column.provider}</th>
                <th>{COPY.field.kind}</th>
                <th>{COPY.field.baseUrl}</th>
                <th className="num">{COPY.field.priority}</th>
                <th>{COPY.field.enabled}</th>
                <th className="num">{COPY.field.models}</th>
                <th>{COPY.providers.credits}</th>
                <th>{COPY.providers.breaker}</th>
                <th>{COPY.providers.actions}</th>
              </tr>
            </thead>
            <tbody>
              {config.data.providers.length === 0 ? (
                <tr>
                  <td className="empty" colSpan={9}>
                    {COPY.providers.empty}
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
          title={COPY.providers.add}
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
          title={COPY.providers.editTitle(editing.provider.name)}
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
            {detail.routed_models.length > 0
              ? COPY.providers.routedCount(detail.routed_models.length)
              : COPY.providers.notRouted}
          </div>
        </td>
        <td>
          <Badge tone={KIND_TONE[provider.kind]}>{COPY.kinds[provider.kind]}</Badge>
        </td>
        <td className="mono small">{provider.base_url}</td>
        <td className="num">{formatInt(provider.priority)}</td>
        <td>
          <Toggle
            checked={provider.enabled}
            ariaLabel={COPY.providers.enableToggle(provider.name)}
            onChange={onToggleEnabled}
          />
        </td>
        <td className="num">{formatInt(detail.models.length)}</td>
        <td>
          {isWorkbuddy ? (
            <div className="cell-stack">
              <span>{credits === null ? "—" : formatCompact(credits.total)}</span>
              {credits !== null ? (
                <span className="muted small">
                  {COPY.providers.healthyAccounts(credits.healthy)}
                  {credits.fetched_at > 0
                    ? ` · ${COPY.providers.creditsFetched(formatDateTime(credits.fetched_at))}`
                    : ""}
                </span>
              ) : null}
              {credits?.error !== null && credits !== null ? (
                <span className="small danger">{credits.error}</span>
              ) : null}
              <div className="row-actions">
                <button type="button" className="btn btn-small" disabled={busy} onClick={onCredits}>
                  {COPY.providers.refreshCredits}
                </button>
                <button type="button" className="btn btn-small" onClick={onToggleExpand}>
                  {isExpanded ? COPY.providers.hideAccounts : COPY.providers.accounts}
                </button>
              </div>
            </div>
          ) : (
            <span className="muted small">{COPY.state.none}</span>
          )}
        </td>
        <td>
          <div className="cell-stack">
            <Badge tone={open ? "bad" : status.consecutive_failures > 0 ? "warn" : "good"}>
              {breakerLabel(status.open_until, status.consecutive_failures)}
            </Badge>
            <span className="muted small">
              {status.last_success_at > 0
                ? COPY.providers.lastSuccessAt(formatDateTime(status.last_success_at))
                : COPY.providers.noSuccess}
            </span>
            {status.last_error !== null ? <span className="small danger">{status.last_error}</span> : null}
          </div>
        </td>
        <td>
          <div className="row-actions">
            <button type="button" className="btn btn-small" onClick={onEdit}>
              {COPY.action.edit}
            </button>
            <button type="button" className="btn btn-small" disabled={busy} onClick={onTest}>
              {COPY.action.test}
            </button>
            <button type="button" className="btn btn-small" disabled={busy} onClick={onDiscover}>
              {COPY.action.discover}
            </button>
            <ConfirmButton
              onConfirm={onDelete}
              label={COPY.action.delete}
              confirmLabel={COPY.action.confirmDelete}
            />
          </div>
        </td>
      </tr>
      {isExpanded ? (
        <tr className="detail-row">
          <td colSpan={9}>
            {credits === null ? (
              <p className="muted padded">{COPY.providers.noCreditSnapshot}</p>
            ) : (
              <div className="detail-panel">
                <div className="stat-grid">
                  <div className="stat">
                    <span className="stat-label">{COPY.providers.creditsTotal}</span>
                    <span className="stat-value">{formatCompact(credits.total)}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">{COPY.providers.healthyAccountsLabel}</span>
                    <span className="stat-value">{formatInt(credits.healthy)}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">{COPY.providers.accounts}</span>
                    <span className="stat-value">{formatInt(credits.accounts.length)}</span>
                  </div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{COPY.providers.accountColumns.uid}</th>
                        <th>{COPY.providers.accountColumns.nickname}</th>
                        <th>{COPY.providers.accountColumns.realm}</th>
                        <th className="num">{COPY.providers.accountColumns.credits}</th>
                        <th>{COPY.providers.accountColumns.state}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {credits.accounts.length === 0 ? (
                        <tr>
                          <td className="empty" colSpan={5}>
                            {COPY.providers.noAccounts}
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
                              <Badge tone="bad">{account.disabled_reason ?? COPY.providers.disabled}</Badge>
                            ) : account.cooling === true ? (
                              <Badge tone="warn">{COPY.providers.cooling}</Badge>
                            ) : (
                              <Badge tone="good">{COPY.state.ok}</Badge>
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
      if (input.name.length === 0) throw new Error(COPY.validation.nameRequired)
      if (input.base_url.length === 0) throw new Error(COPY.validation.baseUrlRequired)
      if (providerId === undefined && (input.api_key === undefined || input.api_key.length === 0)) {
        throw new Error(COPY.providers.apiKeyRequired)
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
            {COPY.action.cancel}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? COPY.action.saving : providerId === undefined ? COPY.action.create : COPY.action.save}
          </button>
        </>
      }
    >
      {error !== null ? <Banner tone="bad" message={error} onDismiss={() => setError(null)} /> : null}

      <div className="form-grid">
        <Field label={COPY.field.name}>
          <input
            className="input"
            value={form.name}
            placeholder={COPY.providers.namePlaceholder}
            onChange={(event) => patch({ name: event.currentTarget.value })}
          />
        </Field>

        <Field label={COPY.field.kind} hint={COPY.providers.kindHint}>
          <select
            className="input"
            value={form.kind}
            onChange={(event) => patch({ kind: event.currentTarget.value as ProviderKind })}
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {COPY.kinds[kind]}
              </option>
            ))}
          </select>
        </Field>

        <Field label={COPY.field.baseUrl} hint={COPY.providers.baseUrlHint}>
          <input
            className="input mono"
            value={form.base_url}
            placeholder={COPY.providers.baseUrlPlaceholder}
            spellCheck={false}
            onChange={(event) => patch({ base_url: event.currentTarget.value })}
          />
        </Field>

        <Field
          label={COPY.field.apiKey}
          hint={
            maskedKey === null || maskedKey.length === 0
              ? COPY.providers.apiKeyNewHint
              : COPY.providers.apiKeyHint
          }
        >
          <input
            className="input mono"
            type="password"
            value={form.api_key}
            placeholder={maskedKey ?? COPY.providers.apiKeyPlaceholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setKeyTouched(true)
              patch({ api_key: event.currentTarget.value })
            }}
          />
        </Field>

        <Field label={COPY.field.priority} hint={COPY.providers.priorityHint}>
          <input
            className="input"
            type="number"
            value={form.priority}
            onChange={(event) => patch({ priority: event.currentTarget.value })}
          />
        </Field>

        <Field label={COPY.providers.maxRetries} hint={COPY.providers.maxRetriesHint}>
          <input
            className="input"
            type="number"
            min={0}
            value={form.max_retries}
            onChange={(event) => patch({ max_retries: event.currentTarget.value })}
          />
        </Field>

        <Field label={COPY.field.inputPrice} hint={COPY.providers.priceHint}>
          <input
            className="input"
            value={form.input_price}
            placeholder={COPY.providers.numberPlaceholder}
            onChange={(event) => patch({ input_price: event.currentTarget.value })}
          />
        </Field>

        <Field label={COPY.field.outputPrice} hint={COPY.providers.priceHint}>
          <input
            className="input"
            value={form.output_price}
            placeholder={COPY.providers.numberPlaceholder}
            onChange={(event) => patch({ output_price: event.currentTarget.value })}
          />
        </Field>

        <Field label={COPY.field.currency}>
          <input
            className="input"
            value={form.currency}
            placeholder={COPY.providers.currencyPlaceholder}
            onChange={(event) => patch({ currency: event.currentTarget.value })}
          />
        </Field>

        <div className="form-span">
          <Toggle
            checked={form.enabled}
            label={COPY.field.enabled}
            onChange={(enabled) => patch({ enabled })}
          />
        </div>

        <div className="form-span">
          <span className="field-label">{COPY.field.headers}</span>
          <PairEditor
            entries={form.headers}
            onChange={(headers) => patch({ headers })}
            keyPlaceholder={COPY.providers.headerNamePlaceholder}
            valuePlaceholder={COPY.providers.headerValuePlaceholder}
            emptyHint={COPY.providers.headersHint}
          />
        </div>

        <div className="form-span">
          <span className="field-label">{COPY.providers.modelRename}</span>
          <PairEditor
            entries={form.model_rename}
            onChange={(model_rename) => patch({ model_rename })}
            keyPlaceholder={COPY.field.upstreamModel}
            valuePlaceholder={COPY.field.publicModel}
            emptyHint={COPY.providers.modelRenameHint}
          />
        </div>

        <Field label={COPY.field.allowedModels} hint={COPY.providers.modelAllowHint}>
          <textarea
            className="input mono"
            rows={4}
            value={form.model_allow}
            placeholder={COPY.providers.modelAllowPlaceholder}
            spellCheck={false}
            onChange={(event) => patch({ model_allow: event.currentTarget.value })}
          />
        </Field>

        <Field label={COPY.providers.modelDeny} hint={COPY.providers.modelDenyHint}>
          <textarea
            className="input mono"
            rows={4}
            value={form.model_deny}
            placeholder={COPY.providers.modelDenyPlaceholder}
            spellCheck={false}
            onChange={(event) => patch({ model_deny: event.currentTarget.value })}
          />
        </Field>
      </div>

      <p className="muted small">
        {COPY.providers.priceNote(form.currency.trim().length > 0 ? form.currency.trim() : "USD")}
      </p>
    </Modal>
  )
}
