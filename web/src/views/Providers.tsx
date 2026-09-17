import { Fragment, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import {
  ChevronRightIcon,
  PackageIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  WifiIcon
} from "lucide-react"

import {
  ConfirmDelete,
  ErrorBanner,
  ErrorPanel,
  Loading,
  NumberInput,
  PairEditor,
  Panel,
  PendingButton,
  Stat,
  ToneBadge,
  type Tone
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api, errorMessage } from "@/lib/api.ts"
import { COPY } from "@/lib/copy.ts"
import { breakerState, formatCredits, formatDateTime, formatDuration, formatInt, formatMs } from "@/lib/format.ts"
import { EMPTY_PROVIDER, draftToInput, providerToDraft } from "@/lib/forms.ts"
import type { ProviderDraft } from "@/lib/forms.ts"
import { useAdminConfig, useRefreshAdmin } from "@/lib/queries.ts"
import type { Credits, ProviderDetail, ProviderKind, ProviderTestResult } from "@/lib/types.ts"

const KIND_TONE: Record<ProviderKind, Tone> = {
  "openai-chat": "info",
  "openai-responses": "neutral",
  workbuddy2api: "warn"
}

const KIND_ITEMS: ReadonlyArray<{ value: ProviderKind; label: string }> = [
  { value: "openai-chat", label: COPY.kinds["openai-chat"] },
  { value: "openai-responses", label: COPY.kinds["openai-responses"] },
  { value: "workbuddy2api", label: COPY.kinds.workbuddy2api }
]

export function ProvidersView() {
  const config = useAdminConfig()
  const refresh = useRefreshAdmin()
  const [editing, setEditing] = useState<ProviderDetail | null>(null)
  const [creating, setCreating] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ id: number; name: string; result: ProviderTestResult } | null>(null)
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
          ? `${COPY.providers.discoverFailed}：${result.error}`
          : COPY.providers.discoverResult(id, result.created.length, result.removed.length, result.models.length)
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
    mutationFn: (input: { id: number; name: string; model?: string }) =>
      api.testProvider(input.id, input.model),
    onSuccess: (result, input) => setTestResult({ id: input.id, name: input.name, result }),
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
  const providers = config.data.providers
  const modelsTotal = providers.reduce((sum, detail) => sum + detail.models.length, 0)
  const openBreakers = providers.filter(
    (detail) => breakerState(detail.status.open_until).state === "open"
  ).length
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{COPY.providers.title}</h1>
          <p className="text-sm text-muted-foreground">
            {COPY.providers.settingsLine(
              COPY.strategies[settings.default_strategy],
              formatMs(settings.request_timeout_ms),
              String(settings.discovery_interval_s)
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PendingButton
            variant="outline"
            pending={discoverAll.isPending}
            pendingLabel={COPY.providers.discoveringAll}
            onClick={() => discoverAll.mutate()}
          >
            <SparklesIcon data-icon="inline-start" />
            {COPY.providers.discoverAll}
          </PendingButton>
          <Button onClick={() => setCreating(true)}>
            <PlusIcon data-icon="inline-start" />
            {COPY.providers.add}
          </Button>
        </div>
      </div>

      {notice !== null ? <ErrorBanner message={notice} onDismiss={() => setNotice(null)} /> : null}

      {testResult !== null ? (
        <Alert variant={testResult.result.ok ? "default" : "destructive"}>
          <WifiIcon />
          <AlertTitle>
            {testResult.name} · {testResult.result.model}
          </AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>
              {testResult.result.ok
                ? COPY.providers.testOk(formatMs(testResult.result.latency_ms), testResult.result.reply)
                : COPY.providers.testFailed(testResult.result.error ?? COPY.state.unknown)}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setTestResult(null)}>
              {COPY.action.dismiss}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* An unreachable models.dev silently degrades every inferred capability to null,
          which reads exactly like "these models have no capabilities". Say so. */}
      {config.data.capabilities_index.loaded ? null : (
        <Alert>
          <AlertTitle>{COPY.providers.capabilitiesIndexMissing}</AlertTitle>
          <AlertDescription>
            {config.data.capabilities_index.error ?? COPY.providers.capabilitiesIndexLocation}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={COPY.providers.title} value={formatInt(providers.length)} />
        <Stat
          label={COPY.field.enabled}
          value={`${formatInt(settings ? providers.filter((d) => d.provider.enabled).length : 0)} / ${formatInt(providers.length)}`}
        />
        <Stat label={COPY.field.models} value={formatInt(modelsTotal)} hint={COPY.dashboard.modelsHint} />
        <Stat
          label={COPY.providers.breaker}
          value={formatInt(openBreakers)}
          tone={openBreakers > 0 ? "bad" : "good"}
          hint={COPY.dashboard.breakersHint}
        />
      </div>

      <Panel title={COPY.providers.listTitle(providers.length)}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{COPY.column.provider}</TableHead>
              <TableHead>{COPY.field.kind}</TableHead>
              <TableHead>{COPY.field.baseUrl}</TableHead>
              <TableHead className="text-right">{COPY.field.priority}</TableHead>
              <TableHead>{COPY.field.enabled}</TableHead>
              <TableHead className="text-right">{COPY.field.models}</TableHead>
              <TableHead>{COPY.providers.credits}</TableHead>
              <TableHead>{COPY.providers.breaker}</TableHead>
              <TableHead className="text-right">{COPY.column.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-12">
                  <div className="flex flex-col items-center gap-3 text-center">
                    <PackageIcon className="size-6 text-muted-foreground" />
                    <p className="max-w-md text-sm text-muted-foreground">{COPY.providers.empty}</p>
                    <Button onClick={() => setCreating(true)}>
                      <PlusIcon data-icon="inline-start" />
                      {COPY.providers.add}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : null}
            {providers.map((detail) => {
              const provider = detail.provider
              const snapshot = creditsOverride[provider.id] !== undefined ? creditsOverride[provider.id] : detail.credits
              return (
                <Fragment key={provider.id}>
                  <ProviderRow
                    detail={detail}
                    credits={snapshot ?? null}
                    isExpanded={expanded === provider.id}
                    /* Only the row being probed is disabled, not the whole table. */
                    busy={discover.variables === provider.id || credits.variables === provider.id}
                    onToggleExpand={() => setExpanded(expanded === provider.id ? null : provider.id)}
                    onToggleEnabled={(enabled) => toggleEnabled.mutate({ id: provider.id, enabled })}
                    onEdit={() => setEditing(detail)}
                    onDiscover={() => discover.mutate(provider.id)}
                    onCredits={() => credits.mutate(provider.id)}
                    onTest={() => test.mutate({ id: provider.id, name: provider.name })}
                    onDelete={() => remove.mutate(provider.id)}
                  />
                  {expanded === provider.id ? (
                    <TableRow>
                      <TableCell colSpan={9} className="bg-muted/30 p-0">
                        <CreditDetail credits={snapshot ?? null} />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              )
            })}
          </TableBody>
        </Table>
      </Panel>

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
  const breaker = breakerState(status.open_until)
  const isWorkbuddy = provider.kind === "workbuddy2api"

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col">
          <span className="font-medium">{provider.name}</span>
          <span className="text-xs text-muted-foreground">
            {detail.routed_models.length > 0
              ? COPY.providers.routedCount(detail.routed_models.length)
              : COPY.providers.notRouted}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <ToneBadge tone={KIND_TONE[provider.kind]}>{COPY.kinds[provider.kind]}</ToneBadge>
      </TableCell>
      <TableCell className="max-w-56 truncate font-mono text-xs" title={provider.base_url}>
        {provider.base_url}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(provider.priority)}</TableCell>
      <TableCell>
        <Switch
          checked={provider.enabled}
          aria-label={COPY.providers.enableToggle(provider.name)}
          onCheckedChange={onToggleEnabled}
        />
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(detail.models.length)}</TableCell>
      <TableCell>
        {isWorkbuddy ? (
          <div className="flex flex-col gap-1">
            <span className="tabular-nums">{credits === null ? "—" : formatCredits(credits.total)}</span>
            {credits === null ? null : (
              <span className="text-xs text-muted-foreground">
                {COPY.providers.healthyAccounts(credits.healthy)}
                {credits.fetched_at > 0 ? ` · ${COPY.providers.creditsFetched(formatDateTime(credits.fetched_at))}` : ""}
              </span>
            )}
            {credits?.error != null ? <span className="text-xs text-destructive">{credits.error}</span> : null}
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" disabled={busy} onClick={onCredits}>
                <RefreshCwIcon data-icon="inline-start" />
                {COPY.providers.refreshCredits}
              </Button>
              <Button variant="ghost" size="sm" onClick={onToggleExpand}>
                <ChevronRightIcon
                  data-icon={isExpanded ? "inline-start" : "inline-end"}
                  className={isExpanded ? "rotate-90" : undefined}
                />
                {isExpanded ? COPY.providers.hideAccounts : COPY.providers.accounts}
              </Button>
            </div>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">{COPY.state.none}</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <ToneBadge tone={breaker.state === "open" ? "bad" : status.consecutive_failures > 0 ? "warn" : "good"}>
                  {COPY.providers.breakerState(breaker, status.consecutive_failures, formatDuration)}
                </ToneBadge>
              }
            />
            <TooltipContent>{COPY.providers.breakerHint}</TooltipContent>
          </Tooltip>
          <span className="text-xs text-muted-foreground">
            {status.last_success_at > 0
              ? COPY.providers.lastSuccessAt(formatDateTime(status.last_success_at))
              : COPY.providers.noSuccess}
          </span>
          {status.last_error !== null ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="max-w-48 truncate text-xs text-destructive">{status.last_error}</span>
                }
              />
              <TooltipContent>{status.last_error}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            {COPY.action.edit}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={onTest}>
            <WifiIcon data-icon="inline-start" />
            {COPY.action.test}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={onDiscover}>
            <SparklesIcon data-icon="inline-start" />
            {COPY.action.discover}
          </Button>
          <ConfirmDelete
            label={COPY.action.delete}
            title={COPY.providers.deleteTitle(provider.name)}
            description={COPY.providers.deleteConfirm}
            disabled={busy}
            onConfirm={onDelete}
          />
        </div>
      </TableCell>
    </TableRow>
  )
}

function CreditDetail({ credits }: { credits: Credits | null }) {
  if (credits === null) {
    return <p className="p-4 text-sm text-muted-foreground">{COPY.providers.noCreditSnapshot}</p>
  }
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat
          label={COPY.providers.creditsTotal}
          value={formatCredits(credits.total)}
          tone={credits.total <= 0 ? "warn" : undefined}
        />
        <Stat label={COPY.providers.healthyAccountsLabel} value={formatInt(credits.healthy)} />
        <Stat label={COPY.providers.accounts} value={formatInt(credits.accounts.length)} />
      </div>
      <Separator />
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{COPY.providers.accountColumns.uid}</TableHead>
              <TableHead>{COPY.providers.accountColumns.nickname}</TableHead>
              <TableHead>{COPY.providers.accountColumns.realm}</TableHead>
              <TableHead className="text-right">{COPY.providers.accountColumns.credits}</TableHead>
              <TableHead>{COPY.providers.accountColumns.state}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {credits.accounts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                  {COPY.providers.noAccounts}
                </TableCell>
              </TableRow>
            ) : null}
            {credits.accounts.map((account) => (
              <TableRow key={account.uid}>
                <TableCell className="font-mono text-xs">{account.uid}</TableCell>
                <TableCell>{account.nickname ?? "—"}</TableCell>
                <TableCell>{account.realm ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCredits(account.credits)}</TableCell>
                <TableCell>
                  {account.disabled === true ? (
                    <ToneBadge tone="bad">{account.disabled_reason ?? COPY.providers.disabled}</ToneBadge>
                  ) : account.cooling === true ? (
                    <ToneBadge tone="warn">{COPY.providers.cooling}</ToneBadge>
                  ) : (
                    <ToneBadge tone="good">{COPY.state.ok}</ToneBadge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
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
  /** The stored secret is only replaced once the operator types into the field. */
  const [keyTouched, setKeyTouched] = useState(false)
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
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{COPY.providers.subtitle}</DialogDescription>
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
                <FieldLabel htmlFor="provider-name">{COPY.field.name}</FieldLabel>
                <Input
                  id="provider-name"
                  value={form.name}
                  placeholder={COPY.providers.namePlaceholder}
                  onChange={(event) => patch({ name: event.currentTarget.value })}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="provider-kind">{COPY.field.kind}</FieldLabel>
                <Select
                  items={KIND_ITEMS}
                  value={form.kind}
                  onValueChange={(value) => patch({ kind: (value ?? "openai-chat") as ProviderKind })}
                >
                  <SelectTrigger id="provider-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {KIND_ITEMS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>{COPY.providers.kindHint}</FieldDescription>
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="provider-url">{COPY.field.baseUrl}</FieldLabel>
              <Input
                id="provider-url"
                className="font-mono"
                value={form.base_url}
                placeholder={COPY.providers.baseUrlPlaceholder}
                spellCheck={false}
                onChange={(event) => patch({ base_url: event.currentTarget.value })}
              />
              <FieldDescription>{COPY.providers.baseUrlHint}</FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="provider-key">{COPY.field.apiKey}</FieldLabel>
              <Input
                id="provider-key"
                className="font-mono"
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
              <FieldDescription>
                {maskedKey === null || maskedKey.length === 0
                  ? COPY.providers.apiKeyNewHint
                  : COPY.providers.apiKeyHint}
              </FieldDescription>
            </Field>

            <div className="grid gap-4 md:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="provider-priority">{COPY.field.priority}</FieldLabel>
                <NumberInput
                  id="provider-priority"
                  value={form.priority}
                  onChange={(value) => patch({ priority: value })}
                />
                <FieldDescription>{COPY.providers.priorityHint}</FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="provider-retries">{COPY.providers.maxRetries}</FieldLabel>
                <NumberInput
                  id="provider-retries"
                  min={0}
                  value={form.max_retries}
                  onChange={(value) => patch({ max_retries: value })}
                />
                <FieldDescription>{COPY.providers.maxRetriesHint}</FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="provider-currency">{COPY.field.currency}</FieldLabel>
                <Input
                  id="provider-currency"
                  value={form.currency}
                  placeholder={COPY.providers.currencyPlaceholder}
                  onChange={(event) => patch({ currency: event.currentTarget.value })}
                />
              </Field>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="provider-input-price">{COPY.field.inputPrice}</FieldLabel>
                <Input
                  id="provider-input-price"
                  value={form.input_price}
                  placeholder={COPY.providers.numberPlaceholder}
                  onChange={(event) => patch({ input_price: event.currentTarget.value })}
                />
                <FieldDescription>{COPY.providers.priceHint}</FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="provider-output-price">{COPY.field.outputPrice}</FieldLabel>
                <Input
                  id="provider-output-price"
                  value={form.output_price}
                  placeholder={COPY.providers.numberPlaceholder}
                  onChange={(event) => patch({ output_price: event.currentTarget.value })}
                />
                <FieldDescription>{COPY.providers.priceHint}</FieldDescription>
              </Field>
            </div>

            <Field orientation="horizontal">
              <Switch
                id="provider-enabled"
                checked={form.enabled}
                onCheckedChange={(enabled) => patch({ enabled })}
              />
              <FieldLabel htmlFor="provider-enabled">{COPY.field.enabled}</FieldLabel>
            </Field>

            <Field>
              <FieldLabel>{COPY.field.headers}</FieldLabel>
              <PairEditor
                entries={form.headers}
                onChange={(headers) => patch({ headers })}
                keyPlaceholder={COPY.providers.headerNamePlaceholder}
                valuePlaceholder={COPY.providers.headerValuePlaceholder}
                emptyHint={COPY.providers.headersHint}
                addLabel={COPY.action.addEntry}
              />
            </Field>

            <Field>
              <FieldLabel>{COPY.providers.modelRename}</FieldLabel>
              <PairEditor
                entries={form.model_rename}
                onChange={(model_rename) => patch({ model_rename })}
                keyPlaceholder={COPY.field.upstreamModel}
                valuePlaceholder={COPY.field.publicModel}
                emptyHint={COPY.providers.modelRenameHint}
                addLabel={COPY.action.addEntry}
              />
            </Field>

            <div className="grid gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="provider-allow">{COPY.field.allowedModels}</FieldLabel>
                <Textarea
                  id="provider-allow"
                  className="font-mono"
                  rows={4}
                  value={form.model_allow}
                  placeholder={COPY.providers.modelAllowPlaceholder}
                  spellCheck={false}
                  onChange={(event) => patch({ model_allow: event.currentTarget.value })}
                />
                <FieldDescription>{COPY.providers.modelAllowHint}</FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="provider-deny">{COPY.providers.modelDeny}</FieldLabel>
                <Textarea
                  id="provider-deny"
                  className="font-mono"
                  rows={4}
                  value={form.model_deny}
                  placeholder={COPY.providers.modelDenyPlaceholder}
                  spellCheck={false}
                  onChange={(event) => patch({ model_deny: event.currentTarget.value })}
                />
                <FieldDescription>{COPY.providers.modelDenyHint}</FieldDescription>
              </Field>
            </div>
          </FieldGroup>

          <p className="text-xs text-muted-foreground">
            {COPY.providers.priceNote(form.currency.trim().length > 0 ? form.currency.trim() : "USD")}
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {COPY.action.cancel}
            </Button>
            <PendingButton type="submit" pending={save.isPending} pendingLabel={COPY.action.saving}>
              {providerId === undefined ? COPY.action.create : COPY.action.save}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
