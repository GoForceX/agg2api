import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { api, errorMessage } from "../lib/api.ts"
import { COPY } from "../lib/copy.ts"
import { formatDateTime, formatInt } from "../lib/format.ts"
import { useAdminConfig, useRefreshAdmin } from "../lib/queries.ts"
import type { ProviderDetail, Route, RouteInput, RouteTarget, RoutingStrategy } from "../lib/types.ts"
import { Badge, Banner, Card, ConfirmButton, ErrorPanel, Field, Loading, Modal, Toggle } from "../components/ui.tsx"

type StrategyChoice = "inherit" | RoutingStrategy

const STRATEGY_LABEL: Record<StrategyChoice, string> = {
  inherit: COPY.routes.inherit,
  priority: COPY.strategies.priority,
  weighted: COPY.strategies.weighted
}

type TargetDraft = {
  provider_id: string
  upstream_model: string
  priority: string
  enabled: boolean
}

type RouteDraft = {
  public_model: string
  strategy: StrategyChoice
  enabled: boolean
  display_name: string
  targets: TargetDraft[]
}

const EMPTY_ROUTE: RouteDraft = {
  public_model: "",
  strategy: "inherit",
  enabled: true,
  display_name: "",
  targets: []
}

function routeToDraft(route: Route): RouteDraft {
  return {
    public_model: route.public_model,
    strategy: route.strategy ?? "inherit",
    enabled: route.enabled,
    display_name: route.display_name ?? "",
    targets: route.targets.map((target) => ({
      provider_id: String(target.provider_id),
      upstream_model: target.upstream_model,
      priority: String(target.priority),
      enabled: target.enabled
    }))
  }
}

function toTargets(drafts: TargetDraft[], providers: ProviderDetail[]): RouteTarget[] {
  return drafts
    .filter(
      (draft) =>
        draft.upstream_model.trim().length > 0 &&
        providers.some((detail) => detail.provider.id === Number(draft.provider_id))
    )
    .map((draft) => ({
      provider_id: Number(draft.provider_id),
      upstream_model: draft.upstream_model.trim(),
      priority: Number.isFinite(Number(draft.priority)) ? Math.floor(Number(draft.priority)) : 0,
      enabled: draft.enabled
    }))
}

/**
 * Index of the target that serves requests under the `priority` strategy: the
 * highest-priority enabled one. Under `weighted` the priority is a weight and
 * the winner is drawn per request, so there is no single answer — callers check
 * the strategy before showing this. `-1` when nothing is eligible.
 */
function preferredIndex(targets: RouteTarget[]): number {
  let best = -1
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]
    if (target === undefined || !target.enabled) continue
    const bestTarget = best === -1 ? undefined : targets[best]
    if (bestTarget === undefined || target.priority > bestTarget.priority) best = index
  }
  return best
}

export function RoutesView() {
  const config = useAdminConfig()
  const refresh = useRefreshAdmin()
  const [editing, setEditing] = useState<Route | null>(null)
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const remove = useMutation({
    mutationFn: (publicModel: string) => api.deleteRoute(publicModel),
    onSuccess: () => void refresh(),
    onError: (error) => setNotice(errorMessage(error))
  })

  const toggleEnabled = useMutation({
    mutationFn: (input: { route: Route; enabled: boolean }) =>
      api.updateRoute(input.route.public_model, {
        public_model: input.route.public_model,
        enabled: input.enabled,
        targets: input.route.targets
      }),
    onSuccess: () => void refresh(),
    onError: (error) => setNotice(errorMessage(error))
  })

  const sync = useMutation({
    mutationFn: api.syncRoutes,
    onSuccess: async (result) => {
      setNotice(COPY.routes.syncResult(result.created.length, result.updated.length, result.removed.length))
      await refresh()
    },
    onError: (error) => setNotice(errorMessage(error))
  })

  if (config.isPending) return <Loading label={COPY.state.loadingRoutes} />
  if (config.isError) return <ErrorPanel error={config.error} onRetry={() => void config.refetch()} />

  const providers = config.data.providers
  const defaultStrategy = config.data.settings.default_strategy

  return (
    <div className="stack">
      <div className="view-head">
        <h1>Routes</h1>
        <div className="row-actions">
          <button type="button" className="btn" disabled={sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? "Syncing…" : "Sync from discovery"}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            New route
          </button>
        </div>
      </div>

      {notice !== null ? <Banner message={notice} onDismiss={() => setNotice(null)} /> : null}

      <p className="muted small">
        Gateway default strategy is <strong>{defaultStrategy}</strong>; routes set to <em>inherit</em> follow it.
        Under <em>priority</em> the highest-priority enabled target serves every request; under <em>weighted</em> the
        priority acts as a weight, so any enabled target may win.
      </p>

      {config.data.routes.length === 0 ? (
        <Card>
          <p className="muted padded">No routes yet. Sync from discovery or add one by hand.</p>
        </Card>
      ) : null}

      {config.data.routes.map((route) => (
        <RouteCard
          key={route.public_model}
          route={route}
          defaultStrategy={defaultStrategy}
          providers={providers}
          onEdit={() => setEditing(route)}
          onToggleEnabled={(enabled) => toggleEnabled.mutate({ route, enabled })}
          onDelete={() => remove.mutate(route.public_model)}
        />
      ))}

      {creating ? (
        <RouteForm
          title="New route"
          draft={EMPTY_ROUTE}
          providers={providers}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false)
            void refresh()
          }}
        />
      ) : null}

      {editing !== null ? (
        <RouteForm
          title={`Edit ${editing.public_model}`}
          draft={routeToDraft(editing)}
          providers={providers}
          existing
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

function RouteCard({
  route,
  defaultStrategy,
  providers,
  onEdit,
  onToggleEnabled,
  onDelete
}: {
  route: Route
  defaultStrategy: RoutingStrategy
  providers: ProviderDetail[]
  onEdit: () => void
  onToggleEnabled: (enabled: boolean) => void
  onDelete: () => void
}) {
  const effective = route.strategy ?? defaultStrategy
  const preferred = effective === "priority" ? preferredIndex(route.targets) : -1
  const serving = preferred === -1 ? null : (route.targets[preferred] ?? null)
  const providerName = (id: number) => providers.find((detail) => detail.provider.id === id)?.provider.name ?? `#${id}`

  return (
    <Card
      title={route.display_name !== null && route.display_name.length > 0 ? route.display_name : route.public_model}
      subtitle={`${route.public_model} · ${route.targets.length} target${route.targets.length === 1 ? "" : "s"} · updated ${formatDateTime(route.updated_at)}`}
      actions={
        <>
          <Toggle checked={route.enabled} label="Enabled" onChange={onToggleEnabled} />
          <button type="button" className="btn btn-small" onClick={onEdit}>
            Edit
          </button>
          <ConfirmButton onConfirm={onDelete} label="Delete" confirmLabel="Confirm delete" />
        </>
      }
      padded
    >
      <div className="route-meta">
        <span>
          Strategy <Badge tone={route.strategy === null ? "neutral" : "info"}>{STRATEGY_LABEL[route.strategy ?? "inherit"]}</Badge>
        </span>
        {route.strategy === null ? <span className="muted small">resolves to {defaultStrategy}</span> : null}
        <span className="muted small">
          {effective === "priority"
            ? serving === null
              ? "no enabled target — the route will 404"
              : `serving via ${providerName(serving.provider_id)} → ${serving.upstream_model}`
            : `${route.targets.filter((target) => target.enabled).length} eligible targets, weighted by priority`}
        </span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Preferred</th>
              <th>Provider</th>
              <th>Upstream model</th>
              <th className="num">Priority</th>
              <th>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {route.targets.length === 0 ? (
              <tr>
                <td className="empty" colSpan={5}>
                  No targets.
                </td>
              </tr>
            ) : null}
            {route.targets.map((target, index) => {
              const isServing = effective === "priority" && index === preferred
              return (
                <tr key={`${target.provider_id}-${target.upstream_model}-${index}`}>
                  <td>{isServing ? <Badge tone="good">serving</Badge> : <span className="muted">—</span>}</td>
                  <td>{providerName(target.provider_id)}</td>
                  <td className="mono small">{target.upstream_model}</td>
                  <td className="num">{formatInt(target.priority)}</td>
                  <td>{target.enabled ? <Badge tone="good">yes</Badge> : <Badge tone="neutral">no</Badge>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function RouteForm({
  title,
  draft,
  providers,
  existing,
  onClose,
  onSaved
}: {
  title: string
  draft: RouteDraft
  providers: ProviderDetail[]
  existing?: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<RouteDraft>(draft)
  const [error, setError] = useState<string | null>(null)

  const patch = (changes: Partial<RouteDraft>) => setForm((current) => ({ ...current, ...changes }))

  const save = useMutation({
    mutationFn: async () => {
      const publicModel = form.public_model.trim()
      if (publicModel.length === 0) throw new Error("Public model is required")
      const input: RouteInput = {
        public_model: publicModel,
        strategy: form.strategy === "inherit" ? null : form.strategy,
        enabled: form.enabled,
        display_name: form.display_name.trim().length > 0 ? form.display_name.trim() : null,
        targets: toTargets(form.targets, providers)
      }
      return existing === true ? api.updateRoute(publicModel, input) : api.createRoute(input)
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
            {save.isPending ? "Saving…" : existing === true ? "Save" : "Create"}
          </button>
        </>
      }
    >
      {error !== null ? <Banner tone="bad" message={error} onDismiss={() => setError(null)} /> : null}

      <div className="form-grid">
        <Field label="Public model" hint="The id clients send, e.g. gpt-4o">
          <input
            className="input mono"
            value={form.public_model}
            disabled={existing === true}
            spellCheck={false}
            onChange={(event) => patch({ public_model: event.currentTarget.value })}
          />
        </Field>

        <Field label="Display name" hint="Optional label shown in this console">
          <input
            className="input"
            value={form.display_name}
            onChange={(event) => patch({ display_name: event.currentTarget.value })}
          />
        </Field>

        <Field label="Strategy">
          <select
            className="input"
            value={form.strategy}
            onChange={(event) => patch({ strategy: event.currentTarget.value as StrategyChoice })}
          >
            <option value="inherit">inherit default</option>
            <option value="priority">priority</option>
            <option value="weighted">weighted</option>
          </select>
        </Field>

        <div className="form-span">
          <Toggle checked={form.enabled} label="Enabled" onChange={(enabled) => patch({ enabled })} />
        </div>
      </div>

      <h3 className="section-title">Targets</h3>
      <TargetEditor targets={form.targets} providers={providers} onChange={(targets) => patch({ targets })} />
    </Modal>
  )
}

function TargetEditor({
  targets,
  providers,
  onChange
}: {
  targets: TargetDraft[]
  providers: ProviderDetail[]
  onChange: (next: TargetDraft[]) => void
}) {
  const update = (index: number, changes: Partial<TargetDraft>) => {
    onChange(targets.map((target, at) => (at === index ? { ...target, ...changes } : target)))
  }

  return (
    <div className="stack">
      {targets.length === 0 ? (
        <p className="muted small">No targets. A route without targets returns 404 for that model.</p>
      ) : null}
      {targets.map((target, index) => {
        const selected = providers.find((detail) => String(detail.provider.id) === target.provider_id)
        const models = selected?.models ?? []
        const upstreamKnown = models.some((model) => model.upstream_id === target.upstream_model)
        return (
          <div className="target-row" key={index}>
            <select
              className="input"
              value={target.provider_id}
              onChange={(event) => update(index, { provider_id: event.currentTarget.value, upstream_model: "" })}
            >
              <option value="">select provider</option>
              {providers.map((detail) => (
                <option key={detail.provider.id} value={String(detail.provider.id)}>
                  {detail.provider.name}
                  {detail.provider.enabled ? "" : " (disabled)"}
                </option>
              ))}
            </select>

            <select
              className="input mono"
              value={target.upstream_model}
              disabled={selected === undefined}
              onChange={(event) => update(index, { upstream_model: event.currentTarget.value })}
            >
              <option value="">
                {selected === undefined ? "select a provider first" : models.length === 0 ? "no discovered models" : "select model"}
              </option>
              {/* Preserve a value that discovery no longer reports so editing never silently drops it. */}
              {target.upstream_model.length > 0 && !upstreamKnown ? (
                <option value={target.upstream_model}>{target.upstream_model} (not discovered)</option>
              ) : null}
              {models.map((model) => (
                <option key={model.upstream_id} value={model.upstream_id}>
                  {model.upstream_id}
                  {model.public_id === model.upstream_id ? "" : ` → ${model.public_id}`}
                </option>
              ))}
            </select>

            <input
              className="input"
              type="number"
              value={target.priority}
              aria-label="Priority"
              onChange={(event) => update(index, { priority: event.currentTarget.value })}
            />

            <Toggle
              checked={target.enabled}
              label="On"
              onChange={(enabled) => update(index, { enabled })}
            />

            <button
              type="button"
              className="icon-btn"
              aria-label="Remove target"
              onClick={() => onChange(targets.filter((_, at) => at !== index))}
            >
              ✕
            </button>
          </div>
        )
      })}
      <button
        type="button"
        className="btn btn-small"
        onClick={() => onChange([...targets, { provider_id: "", upstream_model: "", priority: "0", enabled: true }])}
      >
        Add target
      </button>
    </div>
  )
}
