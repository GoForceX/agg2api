import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { KeyRoundIcon, PlusIcon } from "lucide-react"

import {
  ConfirmDelete,
  CopyButton,
  ErrorBanner,
  ErrorPanel,
  Loading,
  NumberInput,
  Panel,
  PendingButton,
  Stat,
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { api, errorMessage } from "@/lib/api.ts"
import { COPY } from "@/lib/copy.ts"
import { formatAgo, formatDateTime, formatInt } from "@/lib/format.ts"
import { fromLines, toLines } from "@/lib/forms.ts"
import { useAdminConfig, useRefreshAdmin } from "@/lib/queries.ts"
import type { ApiKeyInput, ApiKeyMasked } from "@/lib/types.ts"

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
  const keys = config.data.keys
  const enabledCount = keys.filter((key) => key.enabled).length
  const totalRequests = keys.reduce((sum, key) => sum + key.total_requests, 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{COPY.keys.title}</h1>
          <p className="text-sm text-muted-foreground">
            {settings.require_client_key ? COPY.keys.requireHint : COPY.keys.optionalHint}
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <PlusIcon data-icon="inline-start" />
          {COPY.keys.add}
        </Button>
      </div>

      {notice !== null ? <ErrorBanner message={notice} onDismiss={() => setNotice(null)} /> : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label={COPY.keys.totalRequests} value={formatInt(totalRequests)} />
        <Stat label={COPY.field.enabled} value={`${formatInt(enabledCount)} / ${formatInt(keys.length)}`} />
        <Stat
          label={COPY.keys.rpm}
          value={keys.every((key) => key.rate_limit_rpm === 0) ? COPY.keys.unlimited : COPY.keys.metered}
        />
      </div>

      {/* The secret exists in the response body once, at creation. Losing the dialog
          before copying means rotating the key, so it is a panel and not a toast. */}
      {revealed !== null ? (
        <Alert>
          <KeyRoundIcon />
          <AlertTitle>{COPY.keys.revealTitle}</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>{COPY.keys.secretOnce}</span>
            <div className="flex items-center gap-2">
              <Input
                className="font-mono"
                value={revealed}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
              <CopyButton text={revealed} onFailure={setNotice} />
              <Button variant="outline" onClick={() => setRevealed(null)}>
                {COPY.keys.doneButton}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <Panel title={COPY.keys.countTitle(keys.length)}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{COPY.field.name}</TableHead>
              <TableHead>{COPY.field.secret}</TableHead>
              <TableHead>{COPY.field.enabled}</TableHead>
              <TableHead className="text-right">{COPY.keys.rpm}</TableHead>
              <TableHead>{COPY.field.allowedModels}</TableHead>
              <TableHead className="text-right">{COPY.keys.totalRequests}</TableHead>
              <TableHead>{COPY.keys.lastUsed}</TableHead>
              <TableHead className="text-right">{COPY.column.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  {COPY.keys.empty}
                </TableCell>
              </TableRow>
            ) : null}
            {keys.map((key) => (
              <TableRow key={key.id}>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium">{key.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {COPY.keys.createdAt(formatDateTime(key.created_at))}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">{key.masked}</TableCell>
                <TableCell>
                  <Switch
                    checked={key.enabled}
                    aria-label={COPY.keys.enableToggle(key.name)}
                    onCheckedChange={(enabled) => toggleEnabled.mutate({ key, enabled })}
                  />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {key.rate_limit_rpm === 0 ? COPY.keys.unlimited : formatInt(key.rate_limit_rpm)}
                </TableCell>
                <TableCell>
                  {key.allowed_models.length === 0 ? (
                    <span className="text-xs text-muted-foreground">{COPY.keys.allModels}</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {key.allowed_models.map((model) => (
                        <ToneBadge key={model} tone="neutral">
                          {model}
                        </ToneBadge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatInt(key.total_requests)}</TableCell>
                <TableCell className="text-xs">{formatAgo(key.last_used_at)}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(key)}>
                      {COPY.action.edit}
                    </Button>
                    <ConfirmDelete
                      label={COPY.action.delete}
                      title={COPY.keys.deleteTitle(key.name)}
                      description={COPY.keys.deleteConfirm}
                      onConfirm={() => remove.mutate(key.id)}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>

      {creating ? (
        <KeyForm
          title={COPY.keys.add}
          draft={EMPTY_KEY}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false)
            // A created key returns the secret; an update returns only the mask.
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
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {keyId === undefined ? COPY.keys.secretGenerated : COPY.keys.secretImmutable}
          </DialogDescription>
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
            <Field>
              <FieldLabel htmlFor="key-name">{COPY.field.name}</FieldLabel>
              <Input
                id="key-name"
                value={form.name}
                placeholder={COPY.keys.namePlaceholder}
                onChange={(event) => patch({ name: event.currentTarget.value })}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="key-rpm">{COPY.field.rateLimit}</FieldLabel>
              <NumberInput
                id="key-rpm"
                min={0}
                value={form.rate_limit_rpm}
                onChange={(value) => patch({ rate_limit_rpm: value })}
              />
              <FieldDescription>{COPY.keys.rateLimitHint}</FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="key-models">{COPY.field.allowedModels}</FieldLabel>
              <Textarea
                id="key-models"
                className="font-mono"
                rows={4}
                value={form.allowed_models}
                placeholder={COPY.keys.modelsPlaceholder}
                spellCheck={false}
                onChange={(event) => patch({ allowed_models: event.currentTarget.value })}
              />
              <FieldDescription>{COPY.keys.allowedModelsHint}</FieldDescription>
            </Field>

            <Field orientation="horizontal">
              <Switch
                id="key-enabled"
                checked={form.enabled}
                onCheckedChange={(enabled) => patch({ enabled })}
              />
              <FieldLabel htmlFor="key-enabled">{COPY.field.enabled}</FieldLabel>
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {COPY.action.cancel}
            </Button>
            <PendingButton
              type="submit"
              pending={save.isPending}
              pendingLabel={COPY.action.saving}
            >
              {keyId === undefined ? COPY.action.create : COPY.action.save}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
