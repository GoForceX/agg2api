/**
 * Runtime helpers for reading untrusted JSON.
 *
 * Upstream responses are the boundary between us and three different provider
 * dialects, so they are read defensively: fields stay `unknown` until a `typeof`
 * check establishes what they are. Parsing into full schemas would be
 * counterproductive here — providers add fields constantly and a strict parse
 * would turn a harmless addition into an outage — so this module provides the
 * one shared object guard plus the small numeric readers that all three
 * adapters need, rather than each reimplementing them.
 */

/** Canonical object guard for untrusted values. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Read a value as a finite number, accepting numeric strings. */
export const asNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/** First argument that reads as a number; 0 when none do. */
export const firstNumber = (...values: unknown[]): number => {
  for (const value of values) {
    const parsed = asNumber(value)
    if (parsed !== null) return parsed
  }
  return 0
}

/** Read a value as a string, treating empty strings as absent. */
export const asString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null

/** Read a value as a boolean, accepting the 0/1 that some providers send. */
export const asBoolean = (value: unknown): boolean | null => {
  if (typeof value === "boolean") return value
  if (value === 1 || value === "true") return true
  if (value === 0 || value === "false") return false
  return null
}

/** Read a value as an array of records, skipping entries of any other shape. */
export const asRecordArray = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter(isRecord) : []
