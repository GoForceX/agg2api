/**
 * Form-state ↔ wire-payload conversion. `PairEntry[]` (and one-glob-per-line
 * text) is what survives editing; `ProviderInput` is what the API accepts, and
 * an omitted `api_key` means "keep the stored secret".
 */
import type { PairEntry } from "../components/ui.tsx"
import type { Provider, ProviderInput, ProviderKind } from "./types.ts"

export type ProviderDraft = {
  name: string
  kind: ProviderKind
  base_url: string
  api_key: string
  headers: PairEntry[]
  priority: string
  enabled: boolean
  model_rename: PairEntry[]
  model_allow: string
  model_deny: string
  input_price: string
  output_price: string
  currency: string
  max_retries: string
}

export function toPairs(map: Record<string, string>): PairEntry[] {
  return Object.entries(map).map(([key, value]) => ({ key, value }))
}

/** Drops incomplete rows; a half-typed key is not a header. */
export function fromPairs(entries: PairEntry[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of entries) {
    const key = entry.key.trim()
    if (key.length === 0) continue
    out[key] = entry.value
  }
  return out
}

export function toLines(values: string[]): string {
  return values.join("\n")
}

export function fromLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Empty text means "unset" — the API stores `null` for an unpriced model. */
export function fromPrice(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

export function fromCount(text: string, fallback: number): number {
  const value = Number(text.trim())
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

export const EMPTY_PROVIDER: ProviderDraft = {
  name: "",
  kind: "openai-chat",
  base_url: "",
  api_key: "",
  headers: [],
  priority: "0",
  enabled: true,
  model_rename: [],
  model_allow: "",
  model_deny: "",
  input_price: "",
  output_price: "",
  currency: "USD",
  max_retries: "0"
}

export function providerToDraft(provider: Provider): ProviderDraft {
  return {
    name: provider.name,
    kind: provider.kind,
    base_url: provider.base_url,
    // Masked on read, so an untouched form must not send it back as the secret.
    api_key: "",
    headers: toPairs(provider.headers),
    priority: String(provider.priority),
    enabled: provider.enabled,
    model_rename: toPairs(provider.model_rename),
    model_allow: toLines(provider.model_allow),
    model_deny: toLines(provider.model_deny),
    input_price: provider.input_price === null ? "" : String(provider.input_price),
    output_price: provider.output_price === null ? "" : String(provider.output_price),
    currency: provider.currency,
    max_retries: String(provider.max_retries)
  }
}

/**
 * `apiKeyChanged` is false while the operator leaves the masked placeholder
 * alone, which keeps the stored secret intact on update.
 */
export function draftToInput(draft: ProviderDraft, apiKeyChanged: boolean): ProviderInput {
  const input: ProviderInput = {
    name: draft.name.trim(),
    kind: draft.kind,
    base_url: draft.base_url.trim().replace(/\/+$/, ""),
    headers: fromPairs(draft.headers),
    priority: fromCount(draft.priority, 0),
    enabled: draft.enabled,
    model_rename: fromPairs(draft.model_rename),
    model_allow: fromLines(draft.model_allow),
    model_deny: fromLines(draft.model_deny),
    input_price: fromPrice(draft.input_price),
    output_price: fromPrice(draft.output_price),
    currency: draft.currency.trim().length > 0 ? draft.currency.trim() : "USD",
    max_retries: fromCount(draft.max_retries, 0)
  }
  const key = draft.api_key.trim()
  if (apiKeyChanged && key.length > 0) input.api_key = key
  return input
}
