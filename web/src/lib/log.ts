/**
 * `GET /usage/log` returns `rows` as opaque records, so they are narrowed here
 * once — a server field rename then shows up as `—` instead of `undefined`.
 */
import type { UsageLogRow, UsageLogResponse } from "./types.ts"

const text = (value: unknown): string => (typeof value === "string" ? value : "")
const nullableText = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null)
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)
const flag = (value: unknown): boolean => value === true

export function parseLogRow(row: unknown): UsageLogRow {
  const source = typeof row === "object" && row !== null ? (row as Record<string, unknown>) : {}
  return {
    request_id: text(source.request_id),
    ts: count(source.ts),
    endpoint: text(source.endpoint),
    stream: flag(source.stream),
    public_model: text(source.public_model),
    provider_name: nullableText(source.provider_name),
    provider_kind: nullableText(source.provider_kind),
    prompt_tokens: count(source.prompt_tokens),
    completion_tokens: count(source.completion_tokens),
    cached_tokens: count(source.cached_tokens),
    cost: count(source.cost),
    attempts: count(source.attempts),
    status: count(source.status),
    error_kind: nullableText(source.error_kind),
    error_message: nullableText(source.error_message),
    latency_ms: count(source.latency_ms),
    ttft_ms: count(source.ttft_ms),
    api_key_name: nullableText(source.api_key_name)
  }
}

export function parseUsageLog(response: UsageLogResponse | undefined): UsageLogRow[] {
  return response === undefined ? [] : response.rows.map(parseLogRow)
}
