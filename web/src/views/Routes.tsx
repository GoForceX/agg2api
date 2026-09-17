import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { InfoIcon, PlusIcon, RefreshCwIcon, RouteIcon, TrashIcon } from "lucide-react"

import {
  ConfirmDelete,
  ErrorBanner,
  ErrorPanel,
  Loading,
  NumberInput,
  Panel,
  PendingButton,
  ToneBadge
} from "@/components/common"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, errorMessage } from "@/lib/api.ts"
import { COPY } from "@/lib/copy.ts"
import { formatDateTime, formatInt } from "@/lib/format.ts"
import { useAdminConfig, useRefreshAdmin } from "@/lib/queries.ts"
import type { ModelCapabilities, ProviderDetail, Route, RouteInput, RouteTarget, RoutingStrategy } from "@/lib/types.ts"

type StrategyChoice = "inherit" | RoutingStrategy

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

const STRATEGY_ITEMS: ReadonlyArray<{ value: StrategyChoice; label: string }> = [
  { value: "inherit", label: COPY.routes.inherit },
  { value: "priority", label: COPY.strategies.priority },
  { value: "weighted", label: COPY.strategies.weighted }
]

const SOURCE_LABEL: Record<ModelCapabilities["source"], string> = {
  upstream: COPY.routes.sourceUpstream,
  "models.dev": COPY.routes.sourceModelsDev,
  "models.dev-nearest": COPY.routes.sourceNearest
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
  const routes = config.data.routes
  /** A route with no enabled target cannot serve anything, whatever its own flag says. */
  const brokenRoutes = routes.filter((route) => !route.targets.some((target) => target.enabled)).length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{COPY.routes.title}</h1>
          <p className="text-sm text-muted-foreground">
            {COPY.routes.strategyLegend(COPY.strategies[defaultStrategy])}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PendingButton
            variant="outline"
            pending={sync.isPending}
            pendingLabel={COPY.action.syncing}
            onClick={() => sync.mutate()}
          >
            <RefreshCwIcon data-icon="inline-start" />
            {COPY.action.sync}
          </PendingButton>
          <Button onClick={() => setCreating(true)}>
            <PlusIcon data-icon="inline-start" />
            {COPY.routes.add}
          </Button>
        </div>
      </div>

      {notice !== null ? <ErrorBanner message={notice} onDismiss={() => setNotice(null)} /> : null}

      {brokenRoutes > 0 ? (
        <Alert>
          <InfoIcon />
          <AlertTitle>{COPY.routes.brokenTitle(brokenRoutes)}</AlertTitle>
          <AlertDescription>{COPY.routes.brokenHint}</AlertDescription>
        </Alert>
      ) : null}

      {routes.length === 0 ? (
        <Panel>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <RouteIcon />
              </EmptyMedia>
              <EmptyTitle>{COPY.state.empty}</EmptyTitle>
              <EmptyDescription>{COPY.routes.empty}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </Panel>
      ) : null}

      <div className="flex flex-col gap-4">
        {routes.map((route) => (
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
      </div>

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
  const name = route.display_name !== null && route.display_name.length > 0 ? route.display_name : route.public_model

  return (
    <Panel
      title={name}
      subtitle={COPY.routes.cardSubtitle(route.public_model, route.targets.length, formatDateTime(route.updated_at))}
      actions={
        <>
          <ToneBadge tone={route.strategy === null ? "neutral" : "info"}>
            {STRATEGY_ITEMS.find((item) => item.value === (route.strategy ?? "inherit"))?.label ?? ""}
          </ToneBadge>
          {route.strategy === null ? (
            <span className="text-xs text-muted-foreground">
              {COPY.routes.resolvedTo(COPY.strategies[defaultStrategy])}
            </span>
          ) : null}
          <Switch
            checked={route.enabled}
            aria-label={COPY.routes.enableToggle(route.public_model)}
            onCheckedChange={onToggleEnabled}
          />
          <Button variant="outline" size="sm" onClick={onEdit}>
            {COPY.action.edit}
          </Button>
          <ConfirmDelete
            label={COPY.action.delete}
            title={COPY.routes.deleteTitle(route.public_model)}
            description={COPY.routes.deleteConfirm}
            onConfirm={onDelete}
          />
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
        <span>
          {effective === "priority"
            ? serving === null
              ? COPY.routes.noTargets
              : COPY.routes.servingVia(providerName(serving.provider_id), serving.upstream_model)
            : COPY.routes.weightedEligible(route.targets.filter((target) => target.enabled).length)}
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{COPY.routes.preferredColumn}</TableHead>
            <TableHead>{COPY.column.provider}</TableHead>
            <TableHead>{COPY.field.upstreamModel}</TableHead>
            <TableHead className="text-right">{COPY.field.priority}</TableHead>
            <TableHead>{COPY.field.enabled}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {route.targets.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                {COPY.routes.targetsEmpty}
              </TableCell>
            </TableRow>
          ) : null}
          {route.targets.map((target, index) => {
            const isServing = effective === "priority" && index === preferred
            return (
              <TableRow key={`${target.provider_id}-${target.upstream_model}-${index}`}>
                <TableCell>
                  {isServing ? <ToneBadge tone="good">{COPY.routes.serving}</ToneBadge> : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>{providerName(target.provider_id)}</TableCell>
                <TableCell className="font-mono text-xs">{target.upstream_model}</TableCell>
                <TableCell className="text-right tabular-nums">{formatInt(target.priority)}</TableCell>
                <TableCell>
                  {target.enabled ? (
                    <ToneBadge tone="good">{COPY.state.yes}</ToneBadge>
                  ) : (
                    <ToneBadge tone="neutral">{COPY.state.no}</ToneBadge>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Panel>
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
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{COPY.routes.subtitle}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          {error !== null ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}

          <FieldGroup>
            <div className="grid gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="route-model">{COPY.field.publicModel}</FieldLabel>
                <Input
                  id="route-model"
                  className="font-mono"
                  value={form.public_model}
                  disabled={existing === true}
                  spellCheck={false}
                  onChange={(event) => patch({ public_model: event.currentTarget.value })}
                />
                <FieldDescription>{COPY.routes.publicModelHint}</FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="route-display">{COPY.routes.displayName}</FieldLabel>
                <Input
                  id="route-display"
                  value={form.display_name}
                  onChange={(event) => patch({ display_name: event.currentTarget.value })}
                />
                <FieldDescription>{COPY.routes.displayNameHint}</FieldDescription>
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="route-strategy">{COPY.field.strategy}</FieldLabel>
              <Select
                items={STRATEGY_ITEMS}
                value={form.strategy}
                onValueChange={(value) => patch({ strategy: value as StrategyChoice })}
              >
                <SelectTrigger id="route-strategy" className="w-full md:w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {STRATEGY_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>{COPY.routes.targetsHint}</FieldDescription>
            </Field>

            <Field orientation="horizontal">
              <Switch
                id="route-enabled"
                checked={form.enabled}
                onCheckedChange={(enabled) => patch({ enabled })}
              />
              <FieldLabel htmlFor="route-enabled">{COPY.field.enabled}</FieldLabel>
            </Field>
          </FieldGroup>

          <Separator />

          <h3 className="text-sm font-medium">{COPY.field.targets}</h3>
          <TargetEditor targets={form.targets} providers={providers} onChange={(targets) => patch({ targets })} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {COPY.action.cancel}
            </Button>
            <PendingButton type="submit" pending={save.isPending} pendingLabel={COPY.action.saving}>
              {existing === true ? COPY.action.save : COPY.action.create}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
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
    return <span className="text-xs text-muted-foreground">{COPY.routes.capabilitiesUnknown}</span>
  }
  const tags = capabilities.input.filter((modality) => modality !== "text")
  if (capabilities.tool_call === true) tags.push(COPY.routes.capabilityTools)
  if (capabilities.reasoning === true) tags.push(COPY.routes.capabilityReasoning)
  if (capabilities.structured_output === true) tags.push(COPY.routes.capabilityStructured)
  return (
    <span className="text-xs text-muted-foreground">
      {SOURCE_LABEL[capabilities.source]}
      {tags.length > 0 ? ` · ${tags.join(" · ")}` : ""}
    </span>
  )
}

const NO_PROVIDER = "__none__"

function TargetEditor({
  targets,
  providers,
  onChange
}: {
  targets: TargetDraft[]
  providers: ProviderDetail[]
  onChange: (next: TargetDraft[]) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      {targets.length === 0 ? <p className="text-sm text-muted-foreground">{COPY.routes.targetsEmptyHint}</p> : null}
      {targets.map((target, index) => {
        const selected = providers.find((detail) => String(detail.provider.id) === target.provider_id)
        const models = selected?.models ?? []
        const upstreamKnown = models.some((model) => model.upstream_id === target.upstream_model)
        const update = (changes: Partial<TargetDraft>) =>
          onChange(targets.map((entry, at) => (at === index ? { ...entry, ...changes } : entry)))
        const providerItems: ReadonlyArray<{ value: string; label: string }> = [
          { value: NO_PROVIDER, label: COPY.routes.selectProvider },
          ...providers.map((detail) => ({
            value: String(detail.provider.id),
            label: `${detail.provider.name}${detail.provider.enabled ? "" : COPY.routes.disabledSuffix}`
          }))
        ]
        const modelItems: ReadonlyArray<{ value: string; label: string }> = [
          {
            value: "",
            label:
              selected === undefined
                ? COPY.routes.selectProviderFirst
                : models.length === 0
                  ? COPY.routes.noDiscoveredModels
                  : COPY.routes.selectModel
          },
          // A value discovery no longer reports is preserved, so editing cannot drop it.
          ...(target.upstream_model.length > 0 && !upstreamKnown
            ? [{ value: target.upstream_model, label: COPY.routes.notDiscovered(target.upstream_model) }]
            : []),
          ...models.map((model) => ({
            value: model.upstream_id,
            label:
              model.public_id === model.upstream_id
                ? model.upstream_id
                : `${model.upstream_id} → ${model.public_id}`
          }))
        ]
        return (
          <div
            className="grid items-center gap-2 rounded-lg border p-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,10rem)_auto_auto]"
            key={index}
          >
            <Select
              items={providerItems}
              value={target.provider_id.length === 0 ? NO_PROVIDER : target.provider_id}
              onValueChange={(value) =>
                // Changing the provider invalidates the model: ids are per provider.
                update({ provider_id: value === null || value === NO_PROVIDER ? "" : value, upstream_model: "" })
              }
            >
              <SelectTrigger className="w-full" aria-label={COPY.field.provider}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {providerItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>

            <Select
              items={modelItems}
              value={target.upstream_model}
              disabled={selected === undefined}
              onValueChange={(value) => update({ upstream_model: value ?? "" })}
            >
              <SelectTrigger className="w-full font-mono" aria-label={COPY.field.upstreamModel}>
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

            <CapabilityHint
              capabilities={models.find((model) => model.upstream_id === target.upstream_model)?.capabilities ?? null}
            />

            <NumberInput
              aria-label={COPY.field.priority}
              className="w-20"
              value={target.priority}
              onChange={(value) => update({ priority: value })}
            />

            <div className="flex items-center gap-2">
              <Switch
                checked={target.enabled}
                aria-label={COPY.field.enabled}
                onCheckedChange={(enabled) => update({ enabled })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={COPY.routes.removeTarget}
                onClick={() => onChange(targets.filter((_, at) => at !== index))}
              >
                <TrashIcon />
              </Button>
            </div>
          </div>
        )
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() =>
          onChange([...targets, { provider_id: "", upstream_model: "", priority: "0", enabled: true }])
        }
      >
        <PlusIcon data-icon="inline-start" />
        {COPY.routes.addTarget}
      </Button>
    </div>
  )
}
