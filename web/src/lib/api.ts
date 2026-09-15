/**
 * Admin JSON client. Every call carries the operator token from localStorage,
 * and a 401 hands control to the token modal once before surfacing the error.
 */
import type {
  AdminConfig,
  ApiKeyCreated,
  ApiKeyInput,
  ApiKeyMasked,
  CreditsResult,
  DiscoveryResult,
  Overview,
  Provider,
  ProviderInput,
  ProviderTestResult,
  Route,
  RouteInput,
  RouteSyncResult,
  UsageLogResponse,
  UsageResponse
} from "./types.ts"

const TOKEN_STORAGE_KEY = "agg2api.token"
const API_BASE = "/admin/api"

/** Stands in for localStorage when the browser denies storage access (private mode, blocked cookies). */
let volatileToken = ""

export function readToken(): string {
  try {
    const stored = localStorage.getItem(TOKEN_STORAGE_KEY)
    if (stored !== null) return stored
  } catch {
    return volatileToken
  }
  return volatileToken
}

export function writeToken(token: string): void {
  volatileToken = token
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    // Storage refused; the in-memory copy still authenticates this session.
  }
}

/** Server-provided failure: `status` for branching, `message` for display. */
export class ApiError extends Error {
  readonly status: number
  readonly detail: string | null

  constructor(status: number, message: string, detail: string | null) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.detail = detail
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return typeof error === "string" ? error : "request failed"
}

let tokenPrompt: (() => Promise<string | null>) | null = null
let manualTokenPrompt: (() => void) | null = null

/** Wired by `TokenGate`; returns the token to retry with, or null if the operator dismissed the dialog. */
export function setTokenPrompt(prompt: (() => Promise<string | null>) | null): void {
  tokenPrompt = prompt
}

/** Wired by `TokenGate` so the header can open the dialog without a pending request. */
export function setManualTokenPrompt(prompt: (() => void) | null): void {
  manualTokenPrompt = prompt
}

export function openTokenPrompt(): void {
  manualTokenPrompt?.()
}

type QueryValues = Record<string, string | number | boolean | undefined | null>

type RequestSpec = {
  method?: "GET" | "POST" | "PUT" | "DELETE"
  body?: unknown
  query?: QueryValues
}

function buildQuery(values: QueryValues | undefined): string {
  if (values === undefined) return ""
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue
    params.set(key, String(value))
  }
  const text = params.toString()
  return text.length > 0 ? `?${text}` : ""
}

async function toApiError(response: Response): Promise<ApiError> {
  const raw = await response.text().catch(() => "")
  const fallback = response.statusText.length > 0 ? response.statusText : `HTTP ${response.status}`
  let message = fallback
  let detail: string | null = null
  let parsed: unknown = null
  try {
    parsed = raw.length > 0 ? JSON.parse(raw) : null
  } catch {
    parsed = null
  }
  if (typeof parsed === "object" && parsed !== null) {
    const body = parsed as { error?: unknown; detail?: unknown }
    const error = typeof body.error === "string" && body.error.length > 0 ? body.error : null
    detail = typeof body.detail === "string" && body.detail.length > 0 ? body.detail : null
    message = error !== null ? error : fallback
    if (error !== null && detail !== null) message = `${error}: ${detail}`
  } else if (raw.trim().length > 0) {
    message = raw.trim()
  }
  return new ApiError(response.status, message, detail)
}

async function send(path: string, spec: RequestSpec, token: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (token.length > 0) headers.Authorization = `Bearer ${token}`
  const body = spec.body === undefined ? undefined : JSON.stringify(spec.body)
  if (body !== undefined) headers["Content-Type"] = "application/json"
  return fetch(`${API_BASE}${path}${buildQuery(spec.query)}`, {
    method: spec.method ?? "GET",
    headers,
    body
  })
}

async function request<T>(path: string, spec: RequestSpec = {}): Promise<T> {
  let response = await send(path, spec, readToken())
  /**
   * Prompt at most once per call: a retry that 401s again means the token itself
   * is wrong, so the server's error is surfaced instead of re-opening the dialog
   * in a loop the operator cannot escape.
   */
  if (response.status === 401 && tokenPrompt !== null) {
    const token = await tokenPrompt()
    if (token !== null && token.length > 0) response = await send(path, spec, token)
  }
  if (!response.ok) throw await toApiError(response)
  if (response.status === 204) return undefined as unknown as T
  return (await response.json()) as T
}

const pathSegment = (value: string): string => encodeURIComponent(value)

export type UsageLogParams = {
  limit: number
  offset: number
  model?: string
  provider_id?: number
  errors_only?: boolean
}

export const api = {
  overview: () => request<Overview>("/overview"),
  config: () => request<AdminConfig>("/config"),
  usage: (windowMs: number, bucketMs: number) => request<UsageResponse>("/usage", { query: { window: windowMs, bucket: bucketMs } }),
  usageLog: (params: UsageLogParams) => request<UsageLogResponse>("/usage/log", { query: { ...params } }),

  createProvider: (input: ProviderInput) => request<Provider>("/providers", { method: "POST", body: input }),
  updateProvider: (id: number, input: Partial<ProviderInput>) => request<Provider>(`/providers/${id}`, { method: "PUT", body: input }),
  deleteProvider: (id: number) => request<void>(`/providers/${id}`, { method: "DELETE" }),
  discoverProvider: (id: number) => request<DiscoveryResult>(`/providers/${id}/discover`, { method: "POST" }),
  providerCredits: (id: number) => request<CreditsResult>(`/providers/${id}/credits`, { method: "POST" }),
  testProvider: (id: number, model?: string) =>
    request<ProviderTestResult>(`/providers/${id}/test`, { method: "POST", body: model !== undefined && model.length > 0 ? { model } : {} }),
  discoverAll: () => request<{ results: DiscoveryResult[] }>("/discover", { method: "POST" }),

  createRoute: (input: RouteInput) => request<Route>("/routes", { method: "POST", body: input }),
  updateRoute: (publicModel: string, input: RouteInput) => request<Route>(`/routes/${pathSegment(publicModel)}`, { method: "PUT", body: input }),
  deleteRoute: (publicModel: string) => request<void>(`/routes/${pathSegment(publicModel)}`, { method: "DELETE" }),
  syncRoutes: () => request<RouteSyncResult>("/routes/sync", { method: "POST" }),

  createKey: (input: ApiKeyInput) => request<ApiKeyCreated>("/keys", { method: "POST", body: input }),
  updateKey: (id: number, input: ApiKeyInput) => request<ApiKeyMasked>(`/keys/${id}`, { method: "PUT", body: input }),
  deleteKey: (id: number) => request<void>(`/keys/${id}`, { method: "DELETE" })
}
