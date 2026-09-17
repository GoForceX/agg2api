/**
 * Domain-shaped pieces composed from the shadcn primitives.
 *
 * These exist because the admin repeats three shapes the registry has no component
 * for: a health tone that is neither success nor failure, a metric tile, and a
 * two-step destructive action. Everything else in the console is a registry
 * component used directly, so the styling stays in one place.
 */
import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import { PlusIcon, TrashIcon, TriangleAlertIcon } from "lucide-react"
import { cn } from "cn"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CardContent, CardDescription, CardHeader, CardTitle, Card as ShadcnCard } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { COPY } from "../lib/copy.ts"
import { errorMessage } from "../lib/api.ts"

/**
 * Health of an upstream or a request, which is deliberately not a boolean: a
 * breaker that has tripped once but is still serving is neither `ok` nor `bad`,
 * and collapsing it into either loses the distinction the operator acts on.
 */
export type Tone = "good" | "warn" | "bad" | "info" | "neutral"

const TONE_BADGE: Record<Tone, string> = {
  good: "bg-success/10 text-success dark:bg-success/15",
  warn: "bg-warning/10 text-warning dark:bg-warning/15",
  bad: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  info: "bg-primary/10 text-primary dark:bg-primary/15",
  neutral: "border-border text-muted-foreground"
}

export function ToneBadge({
  tone = "neutral",
  className,
  ...props
}: { tone?: Tone } & React.ComponentProps<typeof Badge>) {
  return (
    <Badge
      variant={tone === "neutral" ? "outline" : "secondary"}
      className={cn(TONE_BADGE[tone], className)}
      {...props}
    />
  )
}

/** A single figure with its label and an optional explanation underneath. */
export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
  className,
  ...props
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: Tone
} & React.ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-col gap-1 rounded-lg border bg-card p-3", className)} {...props}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-xl font-semibold tabular-nums",
          tone === "bad" && "text-destructive",
          tone === "warn" && "text-warning",
          tone === "good" && "text-success"
        )}
      >
        {value}
      </span>
      {hint === undefined ? null : <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

/** The `title`/`subtitle`/`actions` header the console uses on every panel. */
export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <ShadcnCard className={cn("overflow-hidden", className)}>
      {title === undefined && actions === undefined ? null : (
        <CardHeader className="flex flex-row items-start justify-between gap-4 border-b">
          <div className="flex flex-col gap-1">
            {title === undefined ? null : <CardTitle>{title}</CardTitle>}
            {subtitle === undefined ? null : <CardDescription>{subtitle}</CardDescription>}
          </div>
          {actions === undefined ? null : <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </CardHeader>
      )}
      <CardContent className={cn("p-0", bodyClassName)}>{children}</CardContent>
    </ShadcnCard>
  )
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-3 p-4" role="status" aria-label={label}>
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}

export function ErrorPanel({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="p-4">
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>{COPY.error.loadFailed}</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <span>{errorMessage(error)}</span>
          {onRetry === undefined ? null : (
            <Button variant="outline" size="sm" className="w-fit" onClick={onRetry}>
              {COPY.action.retry}
            </Button>
          )}
        </AlertDescription>
      </Alert>
    </div>
  )
}

/** Inline failure that sits above a panel's body rather than replacing it. */
export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>{COPY.error.requestFailed}</AlertTitle>
      <AlertDescription className="flex items-center justify-between gap-3">
        <span>{message}</span>
        {onDismiss === undefined ? null : (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            {COPY.action.dismiss}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

/**
 * Two-step destructive action.
 *
 * The confirmation lives in an `AlertDialog` rather than in the button's own state:
 * an armed button has no visible affordance once the pointer leaves it, so a
 * destructive control could sit armed and commit on an unrelated later click.
 */
export function ConfirmDelete({
  onConfirm,
  label,
  title,
  description,
  disabled
}: {
  onConfirm: () => void
  label: string
  title: string
  description: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{COPY.action.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setOpen(false)
                onConfirm()
              }}
            >
              {COPY.action.confirmDelete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** A button that reports its own in-flight state; the registry Button deliberately has none. */
export function PendingButton({
  pending,
  pendingLabel,
  children,
  ...props
}: {
  pending: boolean
  pendingLabel: string
  children: ReactNode
} & React.ComponentProps<typeof Button>) {
  return (
    <Button disabled={pending || props.disabled} {...props}>
      {pending ? <Spinner data-icon="inline-start" /> : null}
      {pending ? pendingLabel : children}
    </Button>
  )
}

/** A single editable key/value row; duplicate and empty keys stay visible until submit. */
export type PairEntry = { key: string; value: string }

export function PairEditor({
  entries,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  emptyHint,
  addLabel
}: {
  entries: PairEntry[]
  onChange: (next: PairEntry[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
  emptyHint: string
  addLabel: string
}) {
  const update = (index: number, changes: Partial<PairEntry>) => {
    onChange(entries.map((entry, at) => (at === index ? { ...entry, ...changes } : entry)))
  }

  return (
    <div className="flex flex-col gap-2">
      {entries.length === 0 ? <p className="text-xs text-muted-foreground">{emptyHint}</p> : null}
      {entries.map((entry, index) => (
        <div className="flex items-center gap-2" key={index}>
          <Input
            className="font-mono"
            value={entry.key}
            placeholder={keyPlaceholder}
            spellCheck={false}
            onChange={(event) => update(index, { key: event.currentTarget.value })}
          />
          <Input
            className="font-mono"
            value={entry.value}
            placeholder={valuePlaceholder}
            spellCheck={false}
            onChange={(event) => update(index, { value: event.currentTarget.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={COPY.action.removeEntry(entry.key.length > 0 ? entry.key : String(index + 1))}
            onClick={() => onChange(entries.filter((_, at) => at !== index))}
          >
            <TrashIcon />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => onChange([...entries, { key: "", value: "" }])}
      >
        <PlusIcon data-icon="inline-start" />
        {addLabel}
      </Button>
    </div>
  )
}

/**
 * A number that stays a string while being edited, so a half-typed `-` or empty
 * field does not become `NaN` in the draft and silently reset on submit.
 */
export function NumberInput({
  value,
  onChange,
  min,
  ...props
}: { value: string; onChange: (next: string) => void; min?: number } & Omit<
  React.ComponentProps<typeof Input>,
  "value" | "onChange" | "type" | "min"
>) {
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={min}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      {...props}
    />
  )
}

/** Clipboard write with the failure reported instead of swallowed. */
export function CopyButton({ text, onFailure }: { text: string; onFailure: (message: string) => void }) {
  return (
    <Button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).catch(() => onFailure(COPY.keys.clipboardUnavailable))
      }}
    >
      {COPY.action.copy}
    </Button>
  )
}

/** Cache-hit meter; `null` means the window had no prompt tokens, not 0%. */
export function CacheMeter({ ratio, label, note }: { ratio: number | null; label: string; note: string }) {
  const percent = ratio === null ? null : Math.round(ratio * 100)
  return (
    <Progress value={percent} aria-label={label}>
      <div className="flex w-full items-baseline justify-between">
        <ProgressLabel>{label}</ProgressLabel>
        <ProgressValue>{() => (percent === null ? COPY.state.none : `${percent}%`)}</ProgressValue>
      </div>
      <p className="w-full text-xs text-muted-foreground">{note}</p>
    </Progress>
  )
}

/** Auto-clearing notice used for the outcome of a one-off action. */
export function useAutoDismiss(value: string | null, clear: () => void, ms: number): void {
  useEffect(() => {
    if (value === null) return
    const timer = setTimeout(clear, ms)
    return () => clearTimeout(timer)
  }, [value, clear, ms])
}

export { Separator }
