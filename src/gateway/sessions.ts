/**
 * Session affinity.
 *
 * Providers cache prompt *prefixes*, so a conversation served by the same provider
 * twice in a row pays for the cached prefix instead of re-reading it. Spreading one
 * conversation across providers destroys that: each provider sees a cold prefix. This
 * module remembers which provider served a session and lets the router try it first.
 *
 * The session key is derived from the **cacheable prefix** — the system prompt plus the
 * first user turn — rather than from a random id, for two reasons:
 *
 * - The prefix is exactly what an upstream keys its cache on, so identifying the
 *   session by its prefix is what makes the affinity actually pay off. Clients that
 *   send no session id still get affinity, which is the common case.
 * - It is stable across the turns of a conversation while the tail grows, so the key
 *   does not change as the conversation continues.
 *
 * A pin is a *hint*, never a constraint: `orderCandidates` still returns every
 * candidate, so a pinned provider that fails falls through to the normal order. The
 * store is in-process and bounded — affinity is an optimisation, and losing it on
 * restart or eviction costs one cold prefix, not correctness.
 */
import * as Context from "effect/Context"
import type { Message } from "../canonical.ts"

/**
 * Character budgets for the sampled identity.
 *
 * The turn budget is the larger one on purpose: the system prompt is mostly boilerplate
 * that repeats across every session in a workspace, while the user turn is what
 * distinguishes one session from another. Under-budgeting the turn is what made two
 * different tasks in one workspace share a pin.
 */
const SYSTEM_BUDGET = 2_048
const TURN_BUDGET = 4_096

export interface SessionKeyParts {
  /** Explicit session identity from a request header, when the client sends one. */
  readonly explicit: string | null
  /** Tenant identity, so two callers with identical prompts do not share a pin. */
  readonly tenant: string
  readonly model: string
  readonly messages: ReadonlyArray<Message>
}

/**
 * Stable identity for a conversation.
 *
 * An explicit header wins outright: a client that names its session knows more than
 * any inference, and honouring it keeps affinity across requests whose prefix has
 * already been evicted from the client's own history.
 */
export const sessionKey = (parts: SessionKeyParts): string => {
  if (parts.explicit !== null && parts.explicit !== "") {
    return `x:${parts.tenant}:${parts.model}:${parts.explicit}`
  }
  return `p:${parts.tenant}:${parts.model}:${Bun.hash(cacheablePrefix(parts.messages)).toString(36)}`
}

/**
 * Text identifying the conversation for affinity purposes.
 *
 * The hard part is that a coding agent's system prompt is long — a tool catalogue plus
 * an environment block can easily run to tens of thousands of characters — so a naive
 * "concat the prefix and truncate" scheme fails in two directions at once:
 *
 *   - Truncating after the system prompt drops the user's own turn entirely, so every
 *     session in the workspace with that prompt collapses onto one pin.
 *   - Including the system prompt verbatim makes the key sensitive to the volatile
 *     parts agents inject per request (today's date, cwd, git status), so the key
 *     changes every turn and affinity never applies.
 *
 * So the system prompt is *sampled* rather than truncated: its head, its tail, and a
 * few evenly spaced slices. That keeps a project-identifying tail (where agents put
 * their project instructions) while bounding the cost, and it stays stable when only
 * the middle of a huge prompt drifts. The user turn is then appended *whole* so it is
 * always part of the identity.
 */
const cacheablePrefix = (messages: ReadonlyArray<Message>): string => {
  const systems: string[] = []
  for (const message of messages) {
    if (message.role !== "system" && message.role !== "developer") continue
    systems.push(flatten(message.content))
  }

  // Only the opening user turn is part of the identity, and assistant/tool content is
  // excluded entirely. Both choices are about stability:
  //
  //   - An append-only conversation must not change its key as it grows. Any window
  //     that widens with the conversation (say, the first two turns) changes the key
  //     once when it fills, which costs a cold prefix right at the start.
  //   - Assistant content is volatile — a regenerated reply, a retried request, or a
  //     tool result containing a directory listing or timestamp would all change the
  //     key, and in a coding agent tool results arrive on almost every request.
  //
  // What is left is stable for the whole conversation while still separating distinct
  // sessions: different tasks in one workspace differ in their opening request, and
  // different workspaces differ in the sampled system prompt's tail.
  let opening = ""
  for (const message of messages) {
    if (message.role !== "user") continue
    opening = flatten(message.content)
    break
  }

  if (systems.length === 0 && opening === "") return ""
  return `${sample(systems.join("\n"), SYSTEM_BUDGET)}\n${sample(opening, TURN_BUDGET)}`
}

/**
 * Reduce `text` to at most `budget` characters, preserving its ends and a few internal
 * slices.
 *
 * Leading and trailing content are kept because prompts concentrate their meaning there:
 * the head states the role and the tail carries the project-specific instructions that
 * distinguish one workspace from another. Interior slices make the sample sensitive to
 * big changes in the middle without paying to read all of it.
 */
const sample = (text: string, budget: number): string => {
  if (text.length <= budget) return text

  const slices = 4
  const size = Math.floor(budget / (slices + 2))
  const parts: string[] = [text.slice(0, size)]

  const interior = text.length - 2 * size
  for (let index = 1; index <= slices; index += 1) {
    const start = size + Math.floor((interior * index) / (slices + 1))
    parts.push(text.slice(start, start + size))
  }

  parts.push(text.slice(text.length - size))
  return parts.join("\u0000")
}

/** Concatenate a message's text, ignoring non-text parts. */
const flatten = (content: Message["content"]): string => {
  if (content === null) return ""
  if (typeof content === "string") return content
  return content
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("")
}

export interface SessionStats {
  /** Sessions currently pinned. */
  readonly tracked: number
  readonly lookups: number
  readonly hits: number
  readonly misses: number
}

export interface SessionStore {
  /** Provider previously used for this session, or `null` when unknown/expired. */
  readonly lookup: (key: string) => number | null
  /** Remember that `providerId` served this session. */
  readonly record: (key: string, providerId: number) => void
  /** Drop the pin, e.g. because the pinned provider could not serve the request. */
  readonly forget: (key: string) => void
  readonly stats: () => SessionStats
}

export interface SessionStoreOptions {
  /** Idle lifetime of a pin. Non-positive disables affinity entirely. */
  readonly ttl_ms: number
  /** Upper bound on tracked sessions; the oldest are evicted first. */
  readonly max_entries: number
}

/**
 * In-memory, bounded, idle-expiring session store.
 *
 * A `Map` provides the insertion-order iteration used for eviction, which is why it is
 * preferred here over a plain object. Expiry is by insert time rather than last use:
 * a pin only matters while a conversation is active, and refreshing on every lookup
 * would keep a long-running-but-idle session alive indefinitely.
 */
export const makeSessionStore = (options: SessionStoreOptions): SessionStore => {
  const pins = new Map<string, { provider_id: number; at: number }>()
  let lookups = 0
  let hits = 0
  let misses = 0

  const enabled = options.ttl_ms > 0 && options.max_entries > 0

  const evictExpired = (now: number): void => {
    for (const [key, pin] of pins) {
      if (now - pin.at > options.ttl_ms) pins.delete(key)
    }
  }

  return {
    lookup: (key) => {
      if (!enabled) return null
      lookups += 1
      const pin = pins.get(key)
      if (pin === undefined) {
        misses += 1
        return null
      }
      if (Date.now() - pin.at > options.ttl_ms) {
        pins.delete(key)
        misses += 1
        return null
      }
      hits += 1
      return pin.provider_id
    },

    record: (key, providerId) => {
      if (!enabled) return
      // Re-inserting moves the key to the end of the iteration order, which is what
      // makes eviction below approximate least-recently-recorded.
      pins.delete(key)
      pins.set(key, { provider_id: providerId, at: Date.now() })

      if (pins.size <= options.max_entries) return
      evictExpired(Date.now())
      // Still over budget: drop the oldest pins until it fits.
      for (const oldest of pins.keys()) {
        if (pins.size <= options.max_entries) break
        pins.delete(oldest)
      }
    },

    forget: (key) => {
      pins.delete(key)
    },

    stats: () => ({ tracked: pins.size, lookups, hits, misses })
  }
}

/** Process-wide session store, so handlers and the executor share one view. */
export class Sessions extends Context.Tag("Sessions")<Sessions, SessionStore>() {}

/**
 * Move the pinned candidate to the front, leaving the rest untouched.
 *
 * Deliberately a stable reorder rather than a filter: every candidate is still tried
 * if the pin fails, which is what makes the affinity safe to apply unconditionally.
 */
export const preferPinned = <A extends { readonly target: { readonly provider: { readonly id: number } } }>(
  ordered: ReadonlyArray<A>,
  pinnedProviderId: number | null
): ReadonlyArray<A> => {
  if (pinnedProviderId === null || ordered.length <= 1) return ordered

  const index = ordered.findIndex((candidate) => candidate.target.provider.id === pinnedProviderId)
  if (index <= 0) return ordered

  const chosen = ordered[index] as A
  return [chosen, ...ordered.slice(0, index), ...ordered.slice(index + 1)]
}
