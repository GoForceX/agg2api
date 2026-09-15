/** Presentation-only helpers. Every one of them tolerates the `null` the API uses for "unknown". */

const DASH = "—"

export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH
  return Math.round(value).toLocaleString("en-US")
}

/** Compact token counts for stat cards: 1.2k / 3.4M. */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH
  const abs = Math.abs(value)
  if (abs < 1000) return String(Math.round(value))
  if (abs < 1_000_000) return `${(value / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(abs < 10_000_000 ? 1 : 0)}M`
}

export function formatCost(value: number | null | undefined, currency?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH
  const abs = Math.abs(value)
  const digits = abs === 0 ? 2 : abs < 0.01 ? 6 : abs < 1 ? 4 : 2
  const text = value.toFixed(digits)
  return currency ? `${text} ${currency}` : text
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH
  if (value <= 0) return DASH
  if (value < 1000) return `${Math.round(value)} ms`
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return DASH
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${Math.floor(seconds % 60)}s`
  return `${Math.floor(seconds)}s`
}

export function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return DASH
  return `${(rate * 100).toFixed(1)}%`
}

export function formatClock(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return DASH
  return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
}

export function formatDateTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) return DASH
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  })
}

export function formatAgo(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) return "never"
  const delta = Date.now() - ts
  if (delta < 60_000) return "just now"
  return `${formatDuration(delta / 1000)} ago`
}

/** Breaker state: open, degraded, or healthy. */
export function breakerLabel(openUntil: number, failures: number): string {
  const remaining = openUntil - Date.now()
  if (remaining > 0) return `open · ${formatDuration(remaining / 1000)} left`
  if (failures > 0) return `${failures} failure${failures === 1 ? "" : "s"}`
  return "healthy"
}
