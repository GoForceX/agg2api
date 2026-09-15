/**
 * SQLite access layer.
 *
 * Repositories are plain modules of functions whose only requirement is
 * `SqlClient`, rather than service classes: the SQL *is* the implementation, so
 * wrapping it in another abstraction would add indirection without hiding
 * anything. Tests swap the whole database by providing an in-memory
 * `SqliteClient.layer`, which is a better seam than mocking a repository.
 *
 * SQLite has no native boolean or array type, so rows store booleans as 0/1 and
 * lists/maps as JSON text. `asBool`, `toJson` and `fromJson` are the only places
 * that conversion happens.
 */
import * as Schema from "effect/Schema"

/** Raised when a stored row cannot be interpreted — corrupt data, not user error. */
export class DataError extends Schema.TaggedError<DataError>()("DataError", {
  entity: Schema.String,
  message: Schema.String
}) {}

export const now = (): number => Date.now()

/** Domain boolean → column value. */
export const bool = (value: boolean): number => (value ? 1 : 0)

/** Column value → domain boolean. */
export const asBool = (value: unknown): boolean => value === 1 || value === true

/** Domain map/list → column text. */
export const toJson = (value: unknown): string => JSON.stringify(value)

const JSON_FALLBACK: Readonly<Record<string, unknown>> = {}

/** Column text → object, tolerating a NULL or a malformed value from an older schema. */
export const fromJsonObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "string" || value === "") return { ...JSON_FALLBACK }
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { ...JSON_FALLBACK }
  } catch {
    return { ...JSON_FALLBACK }
  }
}

/** Column text → list of strings. */
export const fromJsonStrings = (value: unknown): ReadonlyArray<string> => {
  if (typeof value !== "string" || value === "") return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

/** Narrow a stored `headers` map to `Record<string, string>`. */
export const fromJsonStringMap = (value: unknown): Record<string, string> => {
  const raw = fromJsonObject(value)
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(raw)) {
    if (typeof item === "string") out[key] = item
  }
  return out
}
