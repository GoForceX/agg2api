import { useEffect, useState } from "react"
import type { ChangeEvent, ReactNode } from "react"
import { errorMessage } from "../lib/api.ts"

/** A single editable key/value row; duplicate and empty keys stay visible until submit. */
export type PairEntry = { key: string; value: string }

export function Modal({
  title,
  onClose,
  footer,
  wide,
  children
}: {
  title: string
  onClose: () => void
  footer?: ReactNode
  wide?: boolean
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="overlay" role="presentation">
      <div className={wide ? "modal modal-wide" : "modal"} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer !== undefined ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  )
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  padded
}: {
  title?: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
  padded?: boolean
}) {
  return (
    <section className="card">
      {title !== undefined ? (
        <header className="card-head">
          <div>
            <h2>{title}</h2>
            {subtitle !== undefined ? <p className="muted small">{subtitle}</p> : null}
          </div>
          {actions !== undefined ? <div className="row-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={padded === true ? "card-body" : "card-body flush"}>{children}</div>
    </section>
  )
}

type Tone = "neutral" | "good" | "warn" | "bad" | "info"

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function Stat({
  label,
  value,
  hint,
  tone
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: Tone
}) {
  return (
    <div className={tone === undefined ? "stat" : `stat stat-${tone}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {hint !== undefined ? <span className="stat-hint">{hint}</span> : null}
    </div>
  )
}

export function ProgressBar({ ratio, label }: { ratio: number | null; label: string }) {
  const clamped = ratio === null || !Number.isFinite(ratio) ? 0 : Math.min(Math.max(ratio, 0), 1)
  return (
    <div className="progress" role="img" aria-label={label}>
      <div className="progress-fill" style={{ width: `${(clamped * 100).toFixed(2)}%` }} />
    </div>
  )
}

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint !== undefined ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  ariaLabel,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  /** Visible caption; omit for table cells that already carry a column header. */
  label?: string
  ariaLabel?: string
  disabled?: boolean
}) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled === true}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      {label !== undefined && label.length > 0 ? <span>{label}</span> : null}
    </label>
  )
}

/** Two-step delete: the first click arms, the second commits; blur/timeout disarms. */
export function ConfirmButton({
  onConfirm,
  label,
  confirmLabel,
  disabled
}: {
  onConfirm: () => void
  label: string
  confirmLabel: string
  disabled?: boolean
}) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 5000)
    return () => window.clearTimeout(timer)
  }, [armed])

  return (
    <button
      type="button"
      className={armed ? "btn btn-danger" : "btn"}
      disabled={disabled === true}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (armed) {
          setArmed(false)
          onConfirm()
        } else {
          setArmed(true)
        }
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  )
}

export function Banner({
  tone = "info",
  message,
  onDismiss
}: {
  tone?: Tone
  message: string
  onDismiss?: () => void
}) {
  return (
    <div className={`banner banner-${tone}`} role="status">
      <span>{message}</span>
      {onDismiss !== undefined ? (
        <button type="button" className="icon-btn" aria-label="Dismiss" onClick={onDismiss}>
          ✕
        </button>
      ) : null}
    </div>
  )
}

export function ErrorPanel({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="banner banner-bad" role="alert">
      <span>{errorMessage(error)}</span>
      {onRetry !== undefined ? (
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  )
}

export function Loading({ label }: { label: string }) {
  return <p className="muted padded">{label}…</p>
}

/** Key/value editor used for `headers` and `model_rename`. */
export function PairEditor({
  entries,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  emptyHint
}: {
  entries: PairEntry[]
  onChange: (next: PairEntry[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
  emptyHint: string
}) {
  const update = (index: number, patch: Partial<PairEntry>) => {
    onChange(entries.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)))
  }

  return (
    <div className="pairs">
      {entries.length === 0 ? <p className="muted small">{emptyHint}</p> : null}
      {entries.map((entry, index) => (
        <div className="pair-row" key={index}>
          <input
            className="input mono"
            value={entry.key}
            placeholder={keyPlaceholder}
            spellCheck={false}
            onChange={(event: ChangeEvent<HTMLInputElement>) => update(index, { key: event.currentTarget.value })}
          />
          <input
            className="input mono"
            value={entry.value}
            placeholder={valuePlaceholder}
            spellCheck={false}
            onChange={(event: ChangeEvent<HTMLInputElement>) => update(index, { value: event.currentTarget.value })}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label={`Remove ${entry.key.length > 0 ? entry.key : "row"}`}
            onClick={() => onChange(entries.filter((_, at) => at !== index))}
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-small" onClick={() => onChange([...entries, { key: "", value: "" }])}>
        Add entry
      </button>
    </div>
  )
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage
}: {
  page: number
  pageSize: number
  total: number
  onPage: (next: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const first = total === 0 ? 0 : page * pageSize + 1
  const last = Math.min(total, (page + 1) * pageSize)
  return (
    <div className="pagination">
      <span className="muted small">
        {first}–{last} of {total}
      </span>
      <div className="row-actions">
        <button type="button" className="btn btn-small" disabled={page === 0} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span className="muted small">
          page {page + 1} / {pages}
        </span>
        <button type="button" className="btn btn-small" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  )
}
