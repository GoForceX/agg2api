/**
 * Presentation-only helpers. Every one of them tolerates the `null` the API uses for
 * "unknown".
 *
 * Dates and grouped numbers are locale-sensitive, so they render through `LOCALE`
 * rather than a hardcoded tag: the admin is Chinese, and `en-US` would print
 * "Sep 15, 02:30 PM" in the middle of otherwise Chinese tables.
 */
import { COPY } from "./copy.ts"

const LOCALE = "zh-CN"

const DASH = "—"

export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH
  return Math.round(value).toLocaleString(LOCALE)
}

/** Compact token counts for stat cards: 1.2k / 3.4M. */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH
  const abs = Math.abs(value)
  if (abs < 1000) return String(Math.round(value))
  if (abs < 1_000_000) return `${(value / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(abs < 10_000_000 ? 1 : 0)}M`
}

/**
 * A credit balance.
 *
 * Deliberately not `formatCompact`: that is a token-count formatter and rounds to whole
 * numbers, so a fractional balance was displayed as a different number — 10.5 as "11",
 * 4.25 as "4", and anything under 0.5 as "0", which reads as an exhausted account.
 * Balances are small decimal quantities, so they keep their decimals and only go
 * compact once they are genuinely large.
 */
export function formatCredits(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH
  const abs = Math.abs(value)
  // A balance is a budget, so the exact figure matters more than brevity: 7032 reads as
  // "7,032" rather than "7.0k". Only a genuinely large pool is abbreviated, where the
  // precise digits stop being actionable.
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (abs >= 100_000) return `${Math.round(value / 1000)}k`
  if (abs >= 1000) return Math.round(value).toLocaleString(LOCALE)
  // Up to two decimals, trailing zeros dropped: 10.5 stays 10.5, 10.25 stays 10.25.
  return value.toFixed(2).replace(/\.?0+$/, "") || "0"
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
  if (value < 1000) return `${Math.round(value)} 毫秒`
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} 秒`
}

/**
 * A bucket width, in the units an operator reads charts in.
 *
 * `formatMs` is for latencies, where seconds is the right unit; a 30-minute bucket
 * rendered through it as "1800.0 秒", which is a duration nobody wants to convert in
 * their head. This picks the coarsest exact unit instead.
 */
export function formatBucket(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return DASH
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} 天`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`
  if (ms % 1000 === 0) return `${ms / 1000} 秒`
  return `${Math.round(ms)} 毫秒`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return DASH
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}天${h}小时`
  if (h > 0) return `${h}小时${m}分`
  if (m > 0) return `${m}分${Math.floor(seconds % 60)}秒`
  return `${Math.floor(seconds)}秒`
}

export function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return DASH
  return `${(rate * 100).toFixed(1)}%`
}

export function formatClock(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return DASH
  return new Date(ts).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" })
}

export function formatDateTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) return DASH
  return new Date(ts).toLocaleString(LOCALE, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  })
}

export function formatAgo(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) return COPY.state.never
  const delta = Date.now() - ts
  if (delta < 60_000) return "刚刚"
  return `${formatDuration(delta / 1000)}前`
}

/**
 * Breaker state as a value rather than a sentence.
 *
 * The badge and its tone are chosen together, so returning formatted text meant the
 * caller had to re-derive which of the three states produced it. `cooldownMs` is what
 * is left, so a caller can render the remaining time itself.
 */
export type BreakerState = { state: "open" | "degraded" | "healthy"; cooldownMs: number }

export function breakerState(openUntil: number): BreakerState {
  const cooldownMs = openUntil - Date.now()
  if (cooldownMs > 0) return { state: "open", cooldownMs }
  return { state: "healthy", cooldownMs: 0 }
}
