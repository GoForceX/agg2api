import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { api, errorMessage } from "../lib/api.ts"
import { COPY } from "../lib/copy.ts"
import { formatAgo, formatDateTime, formatInt } from "../lib/format.ts"
import { fromLines, toLines } from "../lib/forms.ts"
import { useAdminConfig, useRefreshAdmin } from "../lib/queries.ts"
import type { ApiKeyInput, ApiKeyMasked } from "../lib/types.ts"
import { Badge, Banner, Card, ConfirmButton, ErrorPanel, Field, Loading, Modal, Toggle } from "../components/ui.tsx"

type KeyDraft = {
  name: string
  enabled: boolean
  rate_limit_rpm: string
  allowed_models: string
}

const EMPTY_KEY: KeyDraft = { name: "", enabled: true, rate_limit_rpm: "0", allowed_models: "" }

export function KeysView() {
  const config = useAdminConfig()
  const refresh = useRefreshAdmin()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<ApiKeyMasked | null>(null)
  /** The secret is returned by create only, and never refetched. */
  const [revealed, setRevealed] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const toggleEnabled = useMutation({
    mutationFn: (input: { key: ApiKeyMasked; enabled: boolean }) =>
      api.updateKey(input.key.id, { name: input.key.name, enabled: input.enabled }),
    onSuccess: () => void refresh(),
    onError: (error) => setNotice(errorMessage(error))
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteKey(id),
    onSuccess: () => void refresh(),
    onError: (error) => setNotice(errorMessage(error))
  })

  if (config.isPending) return <Loading label={COPY.state.loadingKeys} />
  if (config.isError) return <ErrorPanel error={config.error} onRetry={() => void config.refetch()} />

  const settings = config.data.settings

  return (
    <div className="stack">
      <div className="view-head">
        <h1>{COPY.keys.title}</h1>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          {COPY.keys.add}
        </button>
      </div>

      {notice !== null ? <Banner message={notice} onDismiss={() => setNotice(null)} /> : null}

      <p className="muted small">
        {settings.require_client_key ? COPY.keys.requireHint : COPY.keys.optionalHint}{" "}
        {COPY.keys.rateLimitHint}
      </p>

      {revealed !== null ? (
        <Card title={COPY.keys.revealTitle} subtitle={COPY.keys.secretOnce} padded>
          <div className="copy-row">
            <input className="input mono" value={revealed} readOnly onFocus={(event) => event.currentTarget.select()} />
          </div>
          <div className="row-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                void navigator.clipboard
                  .writeText(revealed)
                  .catch(() => setNotice(COPY.keys.clipboardUnavailable))
              }}
            >
              {COPY.action.copy}
            </button>
            <button type="button" className="btn" onClick={() => setRevealed(null)}>
              {COPY.keys.doneButton}
            </button>
          </div>
        </Card>
      ) : null}

      <Card title={COPY.keys.countTitle(config.data.keys.length)}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{COPY.field.name}</th>
                <th>{COPY.field.secret}</th>
                <th>{COPY.field.enabled}</th>
                <th className="num">{COPY.keys.rpm}</th>
                <th>{COPY.field.allowedModels}</th>
                <th className="num">{COPY.keys.totalRequests}</th>
                <th>{COPY.keys.lastUsed}</th>
                <th>{COPY.column.actions}</th>
              </tr>
            </thead>
            <tbody>
              {config.data.keys.length === 0 ? (
                <tr>
                  <td className="empty" colSpan={8}>
                    {COPY.keys.empty}
                  </td>
                </tr>
              ) : null}
              {config.data.keys.map((key) => (
                <tr key={key.id}>
                  <td>
                    <div className="cell-title">{key.name}</div>
                    <div className="muted small">{COPY.keys.createdAt(formatDateTime(key.created_at))}</div>
                  </td>
                  <td className="mono small">{key.masked}</td>
                  <td>
                    <Toggle
                      checked={key.enabled}
                      ariaLabel={COPY.keys.enableToggle(key.name)}
                      onChange={(enabled) => toggleEnabled.mutate({ key, enabled })}
                    />
                  </td>
                  <td className="num">{key.rate_limit_rpm === 0 ? COPY.keys.unlimited : formatInt(key.rate_limit_rpm)}</td>
                  <td>
                    {key.allowed_models.length === 0 ? (
                      <span className="muted small">{COPY.keys.allModels}</span>
                    ) : (
                      <span className="tag-list">
                        {key.allowed_models.map((model) => (
                          <Badge key={model} tone="neutral">
                            {model}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="num">{formatInt(key.total_requests)}</td>
                  <td className="small">{formatAgo(key.last_used_at)}</td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn btn-small" onClick={() => setEditing(key)}>
                        {COPY.action.edit}
                      </button>
                      <ConfirmButton
                        onConfirm={() => remove.mutate(key.id)}
                        label={COPY.action.delete}
                        confirmLabel={COPY.action.confirmDelete}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {creating ? (
        <KeyForm
          title={COPY.keys.add}
          draft={EMPTY_KEY}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false)
            if (created.key !== undefined && created.key.length > 0) setRevealed(created.key)
            void refresh()
          }}
        />
      ) : null}

      {editing !== null ? (
        <KeyForm
          title={COPY.keys.editTitle(editing.name)}
          draft={{
            name: editing.name,
            enabled: editing.enabled,
            rate_limit_rpm: String(editing.rate_limit_rpm),
            allowed_models: toLines(editing.allowed_models)
          }}
          keyId={editing.id}
          onClose={() => setEditing(null)}
          onCreated={() => {
            setEditing(null)
            void refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function KeyForm({
  title,
  draft,
  keyId,
  onClose,
  onCreated
}: {
  title: string
  draft: KeyDraft
  keyId?: number
  onClose: () => void
  onCreated: (created: ApiKeyMasked & { key?: string }) => void
}) {
  const [form, setForm] = useState<KeyDraft>(draft)
  const [error, setError] = useState<string | null>(null)

  const patch = (changes: Partial<KeyDraft>) => setForm((current) => ({ ...current, ...changes }))

  const save = useMutation({
    mutationFn: async () => {
      const name = form.name.trim()
      if (name.length === 0) throw new Error(COPY.validation.nameRequired)
      const rpm = Number(form.rate_limit_rpm.trim())
      const input: ApiKeyInput = {
        name,
        enabled: form.enabled,
        rate_limit_rpm: Number.isFinite(rpm) && rpm >= 0 ? Math.floor(rpm) : 0,
        allowed_models: fromLines(form.allowed_models)
      }
      return keyId === undefined ? api.createKey(input) : api.updateKey(keyId, input)
    },
    onSuccess: onCreated,
    onError: (failure) => setError(errorMessage(failure))
  })

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {COPY.action.cancel}
          </button>
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? COPY.action.saving : keyId === undefined ? COPY.action.create : COPY.action.save}
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
            placeholder={COPY.keys.namePlaceholder}
            onChange={(event) => patch({ name: event.currentTarget.value })}
          />
        </Field>

        <Field label={COPY.field.rateLimit} hint={COPY.keys.rateLimitHint}>
          <input
            className="input"
            type="number"
            min={0}
            value={form.rate_limit_rpm}
            onChange={(event) => patch({ rate_limit_rpm: event.currentTarget.value })}
          />
        </Field>

        <Field label={COPY.field.allowedModels} hint={COPY.keys.allowedModelsHint}>
          <textarea
            className="input mono"
            rows={4}
            value={form.allowed_models}
            placeholder={COPY.keys.modelsPlaceholder}
            spellCheck={false}
            onChange={(event) => patch({ allowed_models: event.currentTarget.value })}
          />
        </Field>
      </div>

      <Toggle checked={form.enabled} label={COPY.field.enabled} onChange={(enabled) => patch({ enabled })} />

      {keyId === undefined ? (
        <p className="muted small">{COPY.keys.secretGenerated}</p>
      ) : (
        <p className="muted small">{COPY.keys.secretImmutable}</p>
      )}
    </Modal>
  )
}
