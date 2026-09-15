import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { api, errorMessage } from "../lib/api.ts"
import { COPY } from "../lib/copy.ts"
import { formatDateTime, formatInt } from "../lib/format.ts"
import { useAdminConfig, useRefreshAdmin } from "../lib/queries.ts"
import type { ModelCapabilities, ProviderDetail, Route, RouteInput, RouteTarget, RoutingStrategy } from "../lib/types.ts"
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
        <h1>{COPY.routes.title}</h1>
        <div className="row-actions">
          <button type="button" className="btn" disabled={sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? COPY.action.syncing : COPY.action.sync}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            {COPY.routes.add}
          </button>
        </div>
      </div>

      {notice !== null ? <Banner message={notice} onDismiss={() => setNotice(null)} /> : null}

      <p className="muted small">{COPY.routes.strategyLegend(COPY.strategies[defaultStrategy])}</p>

      {config.data.routes.length === 0 ? (
        <Card>
          <p className="muted padded">{COPY.routes.empty}</p>
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
          title={COPY.routes.add}
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
          title={COPY.routes.editTitle(editing.public_model)}
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
      subtitle={COPY.routes.cardSubtitle(
        route.public_model,
        route.targets.length,
        formatDateTime(route.updated_at)
      )}
      actions={
        <>
          <Toggle checked={route.enabled} label={COPY.field.enabled} onChange={onToggleEnabled} />
          <button type="button" className="btn btn-small" onClick={onEdit}>
            {COPY.action.edit}
          </button>
          <ConfirmButton
            onConfirm={onDelete}
            label={COPY.action.delete}
            confirmLabel={COPY.action.confirmDelete}
          />
        </>
      }
      padded
    >
      <div className="route-meta">
        <span>
          {COPY.column.strategy}{" "}
          <Badge tone={route.strategy === null ? "neutral" : "info"}>
            {STRATEGY_LABEL[route.strategy ?? "inherit"]}
          </Badge>
        </span>
        {route.strategy === null ? (
          <span className="muted small">{COPY.routes.resolvedTo(COPY.strategies[defaultStrategy])}</span>
        ) : null}
        <span className="muted small">
          {effective === "priority"
            ? serving === null
              ? COPY.routes.noTargets
              : COPY.routes.servingVia(providerName(serving.provider_id), serving.upstream_model)
            : COPY.routes.weightedEligible(
                route.targets.filter((target) => target.enabled).length
              )}
        </span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{COPY.routes.preferredColumn}</th>
              <th>{COPY.column.provider}</th>
              <th>{COPY.field.upstreamModel}</th>
              <th className="num">{COPY.field.priority}</th>
              <th>{COPY.field.enabled}</th>
            </tr>
          </thead>
          <tbody>
            {route.targets.length === 0 ? (
              <tr>
                <td className="empty" colSpan={5}>
                  {COPY.routes.targetsEmpty}
                </td>
              </tr>
            ) : null}
            {route.targets.map((target, index) => {
              const isServing = effective === "priority" && index === preferred
              return (
                <tr key={`${target.provider_id}-${target.upstream_model}-${index}`}>
                  <td>
                    {isServing ? <Badge tone="good">{COPY.routes.serving}</Badge> : <span className="muted">—</span>}
                  </td>
                  <td>{providerName(target.provider_id)}</td>
                  <td className="mono small">{target.upstream_model}</td>
                  <td className="num">{formatInt(target.priority)}</td>
                  <td>
                    {target.enabled ? (
                      <Badge tone="good">{COPY.state.yes}</Badge>
                    ) : (
                      <Badge tone="neutral">{COPY.state.no}</Badge>
                    )}
                  </td>
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
      if (publicModel.length === 0) throw new Error(COPY.validation.modelRequired)
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
            {COPY.action.cancel}
          </button>
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? COPY.action.saving : existing === true ? COPY.action.save : COPY.action.create}
          </button>
        </>
      }
    >
      {error !== null ? <Banner tone="bad" message={error} onDismiss={() => setError(null)} /> : null}

      <div className="form-grid">
        <Field label={COPY.field.publicModel} hint={COPY.routes.publicModelHint}>
          <input
            className="input mono"
            value={form.public_model}
            disabled={existing === true}
            spellCheck={false}
            onChange={(event) => patch({ public_model: event.currentTarget.value })}
          />
        </Field>

        <Field label={COPY.routes.displayName} hint={COPY.routes.displayNameHint}>
          <input
            className="input"
            value={form.display_name}
            onChange={(event) => patch({ display_name: event.currentTarget.value })}
          />
        </Field>

        <Field label={COPY.field.strategy} hint={COPY.routes.targetsHint}>
          <select
            className="input"
            value={form.strategy}
            onChange={(event) => patch({ strategy: event.currentTarget.value as StrategyChoice })}
          >
            <option value="inherit">{COPY.routes.inherit}</option>
            <option value="priority">{COPY.strategies.priority}</option>
            <option value="weighted">{COPY.strategies.weighted}</option>
          </select>
        </Field>

        <div className="form-span">
          <Toggle checked={form.enabled} label={COPY.field.enabled} onChange={(enabled) => patch({ enabled })} />
        </div>
      </div>

      <h3 className="section-title">{COPY.field.targets}</h3>
      <TargetEditor targets={form.targets} providers={providers} onChange={(targets) => patch({ targets })} />
    </Modal>
  )
}

const SOURCE_LABEL: Record<ModelCapabilities["source"], string> = {
  upstream: COPY.routes.sourceUpstream,
  "models.dev": COPY.routes.sourceModelsDev,
  "models.dev-nearest": COPY.routes.sourceNearest
}

/**
 * What the selected model accepts, and where that answer came from.
 *
 * The source is shown rather than just the capabilities: a claim the provider made about
 * itself and one inferred from a third-party catalogue are not equally trustworthy, and
 * an operator deciding whether to route image traffic here needs to know which they have.
 */
function CapabilityHint({ capabilities }: { capabilities: ModelCapabilities | null }) {
  if (capabilities === null) {
    return <span className="muted small">{COPY.routes.capabilitiesUnknown}</span>
  }
  const tags = capabilities.input.filter((modality) => modality !== "text")
  if (capabilities.tool_call === true) tags.push(COPY.routes.capabilityTools)
  if (capabilities.reasoning === true) tags.push(COPY.routes.capabilityReasoning)
  if (capabilities.structured_output === true) tags.push(COPY.routes.capabilityStructured)
  return (
    <span className="muted small">
      {SOURCE_LABEL[capabilities.source]}
      {tags.length > 0 ? ` · ${tags.join(" · ")}` : ""}
    </span>
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
        <p className="muted small">{COPY.routes.targetsEmptyHint}</p>
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
              <option value="">{COPY.routes.selectProvider}</option>
              {providers.map((detail) => (
                <option key={detail.provider.id} value={String(detail.provider.id)}>
                  {detail.provider.name}
                  {detail.provider.enabled ? "" : COPY.routes.disabledSuffix}
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
                {selected === undefined
                  ? COPY.routes.selectProviderFirst
                  : models.length === 0
                    ? COPY.routes.noDiscoveredModels
                    : COPY.routes.selectModel}
              </option>
              {/* Preserve a value that discovery no longer reports so editing never silently drops it. */}
              {target.upstream_model.length > 0 && !upstreamKnown ? (
                <option value={target.upstream_model}>{COPY.routes.notDiscovered(target.upstream_model)}</option>
              ) : null}
              {models.map((model) => (
                <option key={model.upstream_id} value={model.upstream_id}>
                  {model.upstream_id}
                  {model.public_id === model.upstream_id ? "" : ` → ${model.public_id}`}
                </option>
              ))}
            </select>

            <CapabilityHint capabilities={models.find((model) => model.upstream_id === target.upstream_model)?.capabilities ?? null} />

            <input
              className="input"
              type="number"
              value={target.priority}
              aria-label={COPY.field.priority}
              onChange={(event) => update(index, { priority: event.currentTarget.value })}
            />

            <Toggle
              checked={target.enabled}
              label={COPY.field.enabled}
              onChange={(enabled) => update(index, { enabled })}
            />

            <button
              type="button"
              className="icon-btn"
              aria-label={COPY.routes.removeTarget}
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
        {COPY.routes.addTarget}
      </button>
    </div>
  )
}
