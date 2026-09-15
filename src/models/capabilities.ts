/**
 * Model capabilities: what a model accepts and emits.
 *
 * A gateway that advertises models has to answer "can I send an image to this?" for
 * every client that renders a picker, and the answer cannot come from the upstream
 * model list alone: OpenAI and most OpenAI-compatible servers report only `id` and
 * `owned_by`. Two sources are available, and they are not equally trustworthy, so they
 * are layered — an explicit upstream claim always wins, `models.dev` fills the rest.
 *
 * The ordering matters more than it looks. Roughly a third of the ids in `models.dev`
 * appear under several providers with *disagreeing* modalities (394 of the 1084
 * multi-provider ids), because a reseller may serve a quantised or feature-limited
 * variant of a model another provider serves in full. So a global id → capabilities
 * table would confidently return the wrong answer. Capabilities are therefore resolved
 * per provider first, and only fall back to a cross-provider vote when the provider
 * itself cannot be identified.
 */
import * as Effect from "effect/Effect"
import type * as HttpClient from "@effect/platform/HttpClient"
import * as Schema from "effect/Schema"
import { asBoolean, asString, isRecord } from "../json.ts"

/**
 * An input or output modality.
 *
 * The vocabulary is `models.dev`'s, and it is deliberately closed: a capability the
 * gateway cannot name is one it cannot let a caller act on, and an open-ended string
 * would make "does this accept an image" a spelling question.
 */
export const Modality = Schema.Literal("text", "image", "audio", "video", "pdf")
export type Modality = typeof Modality.Type

/**
 * Where a capability claim came from, strongest first.
 *
 * Carried to the caller because the three tiers are not equally reliable: a client that
 * enables an image upload on the strength of `models.dev` should be able to tell that
 * from a claim the provider made about itself.
 */
export const CapabilitySource = Schema.Literal(
  /** The provider's own model list stated it. */
  "upstream",
  /** `models.dev`, scoped to the provider identified by base URL. */
  "models.dev",
  /** `models.dev`, matched by model id alone because the provider was not identified. */
  "models.dev-nearest"
)
export type CapabilitySource = typeof CapabilitySource.Type

export const ModelCapabilities = Schema.Struct({
  /** Non-empty; every model in `models.dev` accepts text. */
  input: Schema.Array(Modality),
  output: Schema.Array(Modality),
  /** `null` where the source did not say, rather than a guessed `false`. */
  tool_call: Schema.NullOr(Schema.Boolean),
  reasoning: Schema.NullOr(Schema.Boolean),
  structured_output: Schema.NullOr(Schema.Boolean),
  /** Accepts file attachments, per `models.dev`'s `attachment` flag. */
  attachment: Schema.NullOr(Schema.Boolean),
  source: CapabilitySource
})
export type ModelCapabilities = typeof ModelCapabilities.Type

const MODALITIES: Record<string, Modality> = {
  text: "text",
  image: "image",
  audio: "audio",
  video: "video",
  pdf: "pdf"
}

/**
 * Normalise another project's modality spelling.
 *
 * OpenRouter reports `file` where `models.dev` reports `pdf`; both mean "an attached
 * document", and PDF support is the concrete thing `models.dev` tracks. Unknown names
 * are dropped rather than passed through, so the closed vocabulary stays closed.
 */
const toModality = (value: string): Modality | null => {
  const lowered = value.trim().toLowerCase()
  if (lowered === "file") return "pdf"
  return MODALITIES[lowered] ?? null
}

const modalityList = (value: unknown): ReadonlyArray<Modality> => {
  if (!Array.isArray(value)) return []
  const out: Modality[] = []
  for (const entry of value) {
    if (typeof entry !== "string") continue
    const modality = toModality(entry)
    // Deduplicated because `file` and `pdf` can normalise onto the same modality.
    if (modality !== null && !out.includes(modality)) out.push(modality)
  }
  return out
}

// ---------------------------------------------------------------------------
// Tier 1: what the provider said
// ---------------------------------------------------------------------------

/** A capability claim parsed from a provider's own model list. */
export interface ReportedCapabilities {
  readonly input?: ReadonlyArray<string> | undefined
  readonly output?: ReadonlyArray<string> | undefined
  readonly tool_call?: boolean | undefined
  readonly reasoning?: boolean | undefined
  readonly structured_output?: boolean | undefined
  readonly attachment?: boolean | undefined
  /** The provider's legacy boolean, when it reported that instead of modalities. */
  readonly supports_images?: boolean | undefined
}

/**
 * Read capability fields out of a provider's model-list entry.
 *
 * Covers the shapes that actually occur: OpenRouter's `architecture.input_modalities`,
 * `architecture.modality` (`"text+image->text"`), and the flat booleans that
 * aggregators and `models.dev`-shaped endpoints use. Anything unrecognised yields no
 * claim, which lets a later tier answer instead of a wrong tier-1 answer blocking it.
 */
export const reportedCapabilities = (entry: Record<string, unknown>): ReportedCapabilities | null => {
  const architecture = isRecord(entry.architecture) ? entry.architecture : null
  const modalities = isRecord(entry.modalities) ? entry.modalities : null
  const cap = (key: string): unknown => entry[key] ?? modalities?.[key] ?? architecture?.[key]

  const input = modalityList(
    architecture?.input_modalities ?? modalities?.input ?? cap("input_modalities")
  )
  const output = modalityList(
    architecture?.output_modalities ?? modalities?.output ?? cap("output_modalities")
  )

  // OpenRouter's compact form predates `input_modalities`: "text+image+file->text".
  const compact = asString(architecture?.modality)
  const [compactIn, compactOut] = compact === null ? [null, null] : splitCompact(compact)

  const supportsImages = asBoolean(cap("supports_images"))
  const inputFinal = input.length > 0 ? input : (compactIn ?? [])
  const outputFinal = output.length > 0 ? output : (compactOut ?? [])

  const reported: ReportedCapabilities = {
    // `supports_images` is the one flat boolean OpenAI-compatible aggregators emit, and
    // it is a statement about input only.
    input: inputFinal.length > 0 ? inputFinal : supportsImages === true ? ["text", "image"] : undefined,
    output: outputFinal.length > 0 ? outputFinal : undefined,
    tool_call: asBoolean(cap("tool_call")) ?? asBoolean(cap("supports_tools")) ?? undefined,
    reasoning: asBoolean(cap("reasoning")) ?? asBoolean(cap("reasoning_supported")) ?? undefined,
    structured_output: asBoolean(cap("structured_output")) ?? undefined,
    attachment: asBoolean(cap("attachment")) ?? undefined,
    supports_images: supportsImages ?? undefined
  }
  return reported.input !== undefined ||
    reported.output !== undefined ||
    reported.tool_call !== undefined ||
    reported.reasoning !== undefined ||
    reported.structured_output !== undefined ||
    reported.attachment !== undefined
    ? reported
    : null
}

/** Split `"text+image->text"` into its input and output modality lists. */
const splitCompact = (value: string): [ReadonlyArray<string> | null, ReadonlyArray<string> | null] => {
  const [left, right] = value.split("->")
  if (left === undefined || right === undefined) return [null, null]
  const parse = (side: string): ReadonlyArray<string> =>
    side.split("+").map((part) => part.trim()).filter((part) => part !== "")
  return [parse(left), parse(right)]
}

/** Build capabilities from a tier-1 claim, filling unsaid fields with `null`. */
export const fromReported = (reported: ReportedCapabilities): ModelCapabilities => {
  const input = modalityList(reported.input ?? [])
  return {
    // A provider that named only an output modality still accepts text input, and an
    // empty input list would read as "accepts nothing".
    input: input.length > 0 ? input : ["text"],
    output: modalityList(reported.output ?? []).length > 0 ? modalityList(reported.output ?? []) : ["text"],
    tool_call: reported.tool_call ?? null,
    reasoning: reported.reasoning ?? null,
    structured_output: reported.structured_output ?? null,
    attachment: reported.attachment ?? null,
    source: "upstream"
  }
}

// ---------------------------------------------------------------------------
// models.dev index
// ---------------------------------------------------------------------------

export const MODELS_DEV_URL = "https://models.dev/api.json"

/** One model entry, reduced to the capability-relevant fields. */
interface CatalogueModel {
  readonly name: string | null
  readonly input: ReadonlyArray<Modality>
  readonly output: ReadonlyArray<Modality>
  readonly tool_call: boolean | null
  readonly reasoning: boolean | null
  readonly structured_output: boolean | null
  readonly attachment: boolean | null
}

interface CatalogueProvider {
  /** Base URL `models.dev` records for the provider, used to identify it. */
  readonly api: string | null
  readonly models: ReadonlyMap<string, CatalogueModel>
}

export interface CatalogueIndex {
  /** Keyed by the host of the provider's base URL. */
  readonly byHost: ReadonlyMap<string, CatalogueProvider>
  /** Keyed by normalised model id; several providers may share an id. */
  readonly byId: ReadonlyMap<string, ReadonlyArray<CatalogueModel>>
  /** How many models the index holds, for the admin UI. */
  readonly size: number
}

const toCatalogueModel = (entry: Record<string, unknown>): CatalogueModel | null => {
  const modalities = isRecord(entry.modalities) ? entry.modalities : null
  const input = modalityList(modalities?.input)
  if (input.length === 0) return null
  return {
    name: asString(entry.name),
    input,
    output: modalityList(modalities?.output),
    tool_call: asBoolean(entry.tool_call),
    reasoning: asBoolean(entry.reasoning),
    structured_output: asBoolean(entry.structured_output),
    attachment: asBoolean(entry.attachment)
  }
}

/**
 * Strip the parts of a model id that vary without meaning anything.
 *
 * `claude-3-5-sonnet-20241022`, `anthropic/claude-3-5-sonnet` and
 * `claude-3-5-sonnet:latest` are one model. Release dates and vendor prefixes are the
 * two things that differ between a provider's id and `models.dev`'s.
 */
export const normaliseModelId = (id: string): string =>
  id
    .trim()
    .toLowerCase()
    .replace(/^[a-z0-9_.-]+\//, "")
    .replace(/[-_:]?20\d{2}[-_]?\d{2}[-_]?\d{2}$/, "")
    .replace(/[-_:]?\d{8}$/, "")
    .replace(/[-:](latest|preview|beta|exp|stable|free)$/, "")
    .replace(/^[-_]+|[-_]+$/g, "")

/** Host of a base URL, lower-cased, without port or path. */
export const hostOf = (baseUrl: string): string | null => {
  try {
    const url = new URL(baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`)
    return url.hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Build the lookup index from a raw `models.dev/api.json` document.
 *
 * Unknown shapes are skipped rather than thrown on: this is a third-party document
 * fetched over the network, and a schema change upstream must degrade to "no
 * inference", not to a gateway that refuses to start.
 */
export const buildIndex = (raw: unknown): CatalogueIndex => {
  const byHost = new Map<string, CatalogueProvider>()
  const byId = new Map<string, CatalogueModel[]>()

  if (!isRecord(raw)) return { byHost, byId, size: 0 }

  for (const providerRaw of Object.values(raw)) {
    if (!isRecord(providerRaw)) continue
    const api = asString(providerRaw.api)
    const models = new Map<string, CatalogueModel>()

    for (const [modelId, modelRaw] of Object.entries(
      isRecord(providerRaw.models) ? providerRaw.models : {}
    )) {
      if (!isRecord(modelRaw)) continue
      const model = toCatalogueModel(modelRaw)
      if (model === null) continue
      models.set(modelId, model)

      const key = normaliseModelId(modelId)
      const bucket = byId.get(key)
      if (bucket === undefined) byId.set(key, [model])
      else bucket.push(model)
    }

    const host = api === null ? null : hostOf(api)
    // The first provider claiming a host wins. `models.dev` has a handful of hosts
    // shared by two entries (a coding-plan variant of the same API), and picking
    // deterministically keeps inference stable across restarts.
    if (host !== null && !byHost.has(host)) byHost.set(host, { api, models })
  }

  let size = 0
  for (const provider of byHost.values()) size += provider.models.size
  return { byHost, byId, size }
}

/**
 * Resolve a model within one provider's catalogue.
 *
 * Exact id first, then normalised: a provider commonly serves `gpt-4o` where
 * `models.dev` also lists `gpt-4o-2024-08-06`, and the normalised form is what makes
 * those the same model.
 */
const withinProvider = (
  provider: CatalogueProvider,
  id: string
): CatalogueModel | null => {
  const exact = provider.models.get(id)
  if (exact !== undefined) return exact
  const wanted = normaliseModelId(id)
  for (const [candidateId, model] of provider.models) {
    if (normaliseModelId(candidateId) === wanted) return model
  }
  return null
}

/**
 * Pick the capabilities a bare model id most likely has.
 *
 * A plurality vote, not a first match: `gpt-4o` appears under 43 providers and the
 * most common answer (27 of them) is the real one. A tie or a single dissenting
 * provider would make this a coin flip, so the vote is reported with its confidence
 * and the caller can decline to trust it.
 */
const nearest = (
  index: CatalogueIndex,
  id: string
): { model: CatalogueModel; agreeing: number; total: number; unanimous: boolean } | null => {
  const candidates = index.byId.get(normaliseModelId(id))
  if (candidates === undefined || candidates.length === 0) return null

  const counts = new Map<string, { model: CatalogueModel; n: number }>()
  for (const model of candidates) {
    const key = JSON.stringify([model.input, model.output, model.tool_call, model.reasoning])
    const entry = counts.get(key)
    if (entry === undefined) counts.set(key, { model, n: 1 })
    else entry.n += 1
  }

  let best: { model: CatalogueModel; n: number } | null = null
  for (const entry of counts.values()) {
    if (best === null || entry.n > best.n) best = entry
  }
  if (best === null) return null
  return { model: best.model, agreeing: best.n, total: candidates.length, unanimous: counts.size === 1 }
}

const fromCatalogue = (model: CatalogueModel, source: CapabilitySource): ModelCapabilities => ({
  input: model.input,
  output: model.output.length > 0 ? model.output : ["text"],
  tool_call: model.tool_call,
  reasoning: model.reasoning,
  structured_output: model.structured_output,
  attachment: model.attachment,
  source
})

export interface InferInput {
  /** The provider's model id, as the upstream spelled it. */
  readonly upstreamId: string
  /** Base URL of the provider, used to identify it in the index. */
  readonly baseUrl: string
  /** Tier-1 claim, when the provider's model list carried one. */
  readonly reported: ReportedCapabilities | null
}

/**
 * Resolve capabilities for one model, most trustworthy source first.
 *
 * Returns `null` when nothing could be established. That is a real answer — the caller
 * prints no capability rather than a guess — and it is why the tiers are explicit
 * rather than collapsed into "check upstream, else look up".
 */
export const inferCapabilities = (
  index: CatalogueIndex | null,
  input: InferInput
): ModelCapabilities | null => {
  if (input.reported !== null) return fromReported(input.reported)
  if (index === null) return null

  // Tier 2: the provider is identified by its base URL, so only its own claims about
  // the model are considered. A reseller serving a reduced variant is answered by the
  // reseller's entry, not by the plurality of everyone else.
  const host = hostOf(input.baseUrl)
  const provider = host === null ? undefined : index.byHost.get(host)
  if (provider !== undefined) {
    const model = withinProvider(provider, input.upstreamId)
    if (model !== null) return fromCatalogue(model, "models.dev")
  }

  // Tier 3: the provider is unknown (a self-hosted proxy, a bare IP), so the id is all
  // there is to go on. A single dissenter among many is noise; a genuinely split vote
  // means the id is ambiguous and guessing would be worse than saying nothing.
  const voted = nearest(index, input.upstreamId)
  if (voted === null) return null
  if (!voted.unanimous && voted.agreeing * 2 <= voted.total) return null
  return fromCatalogue(voted.model, "models.dev-nearest")
}

/**
 * Fetch and index `models.dev`.
 *
 * A failure is not an error the caller handles: the gateway is fully functional without
 * capability inference, so a fetch problem degrades to `null` (no inference) and is
 * retried on the next refresh.
 */
export const fetchIndex = (
  client: HttpClient.HttpClient,
  url: string = MODELS_DEV_URL
): Effect.Effect<CatalogueIndex | null> =>
  Effect.gen(function* () {
    const response = yield* client.get(url).pipe(Effect.either)
    if (response._tag === "Left") return null
    if (response.right.status !== 200) return null
    const body = yield* response.right.json.pipe(Effect.either)
    if (body._tag === "Left") return null
    return buildIndex(body.right)
  })

/** The capability fields a client renders, as flat booleans for the admin UI. */
export const summarise = (
  capabilities: ModelCapabilities | null
): ReadonlyArray<string> => {
  if (capabilities === null) return []
  const out: string[] = []
  for (const modality of capabilities.input) {
    if (modality !== "text") out.push(modality)
  }
  if (capabilities.tool_call === true) out.push("tools")
  if (capabilities.reasoning === true) out.push("reasoning")
  if (capabilities.structured_output === true) out.push("structured")
  return out
}

/** Parse a stored `capabilities` JSON column, tolerating a legacy or corrupt value. */
export const parseStored = (raw: string | null): ModelCapabilities | null => {
  if (raw === null || raw === "") return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    const input = modalityList(parsed.input)
    if (input.length === 0) return null
    const source = parsed.source
    if (source !== "upstream" && source !== "models.dev" && source !== "models.dev-nearest") return null
    return {
      input,
      output: modalityList(parsed.output),
      tool_call: asBoolean(parsed.tool_call),
      reasoning: asBoolean(parsed.reasoning),
      structured_output: asBoolean(parsed.structured_output),
      attachment: asBoolean(parsed.attachment),
      source
    }
  } catch {
    return null
  }
}

