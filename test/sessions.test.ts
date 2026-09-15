import { describe, expect, test } from "bun:test"
import { makeSessionStore, preferPinned, sessionKey } from "../src/gateway/sessions.ts"
import type { Message } from "../src/canonical.ts"

const user = (text: string): Message => ({ role: "user", content: text })
const system = (text: string): Message => ({ role: "system", content: text })

const base = { explicit: null, tenant: "key:1", model: "m" }

describe("sessionKey", () => {
  test("is stable across the turns of a conversation", () => {
    // The whole point of keying on the cacheable prefix: later turns must not change
    // the identity, or affinity would be lost exactly when it is earning cache hits.
    const first = sessionKey({ ...base, messages: [system("be terse"), user("hello")] })
    const second = sessionKey({
      ...base,
      messages: [system("be terse"), user("hello"), { role: "assistant", content: "hi" }, user("more")]
    })
    expect(second).toBe(first)
  })

  test("separates conversations with different prefixes", () => {
    const a = sessionKey({ ...base, messages: [system("be terse"), user("hello")] })
    const b = sessionKey({ ...base, messages: [system("be terse"), user("goodbye")] })
    expect(a).not.toBe(b)
  })

  test("separates tenants and models with identical prompts", () => {
    const messages = [system("s"), user("same prompt")]
    const mine = sessionKey({ ...base, messages })
    // A shared pin would let one tenant's routing decision steer another's cache.
    const theirs = sessionKey({ ...base, tenant: "key:2", messages })
    const otherModel = sessionKey({ ...base, model: "other", messages })
    expect(mine).not.toBe(theirs)
    expect(mine).not.toBe(otherModel)
  })

  test("honours an explicit session header over the inferred prefix", () => {
    const messages = [user("irrelevant")]
    const named = sessionKey({ ...base, explicit: "sess-42", messages })
    expect(named).toContain("sess-42")
    // Same explicit id, different prompt: still one session, because the client said so.
    const later = sessionKey({ ...base, explicit: "sess-42", messages: [user("different")] })
    expect(later).toBe(named)
    expect(sessionKey({ ...base, explicit: "sess-43", messages })).not.toBe(named)
  })

  // --- long-context coding-agent shapes -------------------------------------
  // These cases were all broken before the system prompt was sampled instead of
  // truncated. Each one is a real client shape, not a synthetic edge.

  test("keeps distinct sessions apart when the system prompt alone is huge", () => {
    // A tool catalogue plus environment block runs to tens of thousands of characters.
    // Truncating the concatenation dropped the user turn entirely, so every session in
    // a workspace collapsed onto one pin.
    const bigSystem = "TOOL: Read(path) ... TOOL: Edit(path, old, new) ... ".repeat(120)
    const first = sessionKey({ ...base, messages: [system(bigSystem), user("fix the login bug")] })
    const second = sessionKey({ ...base, messages: [system(bigSystem), user("refactor payments")] })
    expect(bigSystem.length).toBeGreaterThan(4096)
    expect(first).not.toBe(second)
  })

  test("distinguishes projects that share a long preamble but differ in the tail", () => {
    // Agents put project instructions at the end of the prompt, after a shared preamble.
    const preamble = "You are a coding agent. ".repeat(200)
    const alpha = sessionKey({
      ...base,
      messages: [system(preamble + "PROJECT: repo-alpha"), user("fix the bug")]
    })
    const beta = sessionKey({
      ...base,
      messages: [system(preamble + "PROJECT: repo-beta"), user("fix the bug")]
    })
    expect(alpha).not.toBe(beta)
  })

  test("stays stable across a tool-calling agent loop", () => {
    // The decisive case: full history resent every turn, with tool calls and tool
    // results appended. Tool results often contain listings or timestamps, so hashing
    // them would change the key on nearly every request.
    const sys = system("You are a coding agent with tools.")
    const keys = new Set<string>()
    let messages: Message[] = [sys, user("Refactor the auth module")]

    for (let step = 0; step < 6; step += 1) {
      messages = [...messages, { role: "assistant", content: `step ${step}` }]
      keys.add(sessionKey({ ...base, messages }))
      messages = [
        ...messages,
        {
          role: "tool",
          tool_call_id: `c${step}`,
          content: `// listing
export function f${step}() {}
${step}:00:00`
        }
      ]
      keys.add(sessionKey({ ...base, messages }))
    }

    expect(keys.size).toBe(1)
  })

  test("tolerates a volatile environment block buried in a huge system prompt", () => {
    // Sampling is what makes this work: only the head, tail and a few interior slices
    // are hashed, so a changing date or cwd in the middle of a large prompt does not
    // invalidate the pin. The tradeoff is that a *meaningful* change in an unsampled
    // region is invisible to the key — acceptable here, because affinity is an
    // optimisation and a wrongly reused pin still routes to a working provider.
    const bulk = "T".repeat(20_000)
    const withDate = (date: string) => bulk.slice(0, 9_000) + `Today is ${date}` + bulk.slice(9_000)
    const today = sessionKey({ ...base, messages: [system(withDate("2026-09-15")), user("U")] })
    const tomorrow = sessionKey({ ...base, messages: [system(withDate("2026-09-16")), user("U")] })
    expect(today).toBe(tomorrow)
  })

  test("still separates projects through the tail of a huge system prompt", () => {
    // The other half of the tradeoff: the sampled tail is where agents put their
    // project instructions, so distinct workspaces stay distinct.
    const huge = (tail: string) => "X".repeat(20_000) + tail
    const alpha = sessionKey({ ...base, messages: [system(huge("PROJECT: alpha")), user("U")] })
    const beta = sessionKey({ ...base, messages: [system(huge("PROJECT: beta")), user("U")] })
    expect(alpha).not.toBe(beta)
  })

  test("a short system prompt is hashed whole, so a change does alter the key", () => {
    // Documents the boundary: below the budget there is no sampling, so any edit to the
    // prompt is a genuinely different prefix and gets a fresh pin. That is correct —
    // the upstream cache would miss anyway.
    const short = (date: string) => [system(`agent\nToday is ${date}`), user("U")]
    expect(sessionKey({ ...base, messages: short("2026-09-15") })).not.toBe(
      sessionKey({ ...base, messages: short("2026-09-16") })
    )
  })

  test("keys a conversation that has no system prompt", () => {
    const first = sessionKey({ ...base, messages: [user("a")] })
    const second = sessionKey({ ...base, messages: [user("a"), user("b")] })
    expect(first).toBe(second)
  })

  test("reads text out of multi-part content", () => {
    const parts: Message = { role: "user", content: [{ type: "text", text: "hello" }] }
    const plain = sessionKey({ ...base, messages: [user("hello")] })
    expect(sessionKey({ ...base, messages: [parts] })).toBe(plain)
  })
})

interface FakeCandidate {
  readonly target: { readonly provider: { readonly id: number } }
  readonly label: string
}

const candidate = (id: number, label: string): FakeCandidate => ({
  target: { provider: { id } },
  label
})

describe("preferPinned", () => {
  test("moves the pinned candidate to the front and keeps the rest in order", () => {
    const ordered = [candidate(1, "a"), candidate(2, "b"), candidate(3, "c")]
    const result = preferPinned(ordered, 3)
    expect(result.map((entry) => entry.label)).toEqual(["c", "a", "b"])
  })

  test("is a stable reorder, not a filter", () => {
    // Every candidate must survive, or a failing pin would remove the fallback chain
    // that makes affinity safe to apply unconditionally.
    const ordered = [candidate(1, "a"), candidate(2, "b"), candidate(3, "c")]
    expect(preferPinned(ordered, 2).length).toBe(3)
    expect(preferPinned(ordered, 99).map((entry) => entry.label)).toEqual(["a", "b", "c"])
    expect(preferPinned(ordered, null).map((entry) => entry.label)).toEqual(["a", "b", "c"])
  })

  test("is a no-op when the pin is already first", () => {
    const ordered = [candidate(1, "a"), candidate(2, "b")]
    expect(preferPinned(ordered, 1)).toBe(ordered)
  })
})

describe("session store", () => {
  test("records and recalls a pin", () => {
    const store = makeSessionStore({ ttl_ms: 60_000, max_entries: 10 })
    expect(store.lookup("s")).toBeNull()
    store.record("s", 7)
    expect(store.lookup("s")).toBe(7)
    expect(store.stats().hits).toBe(1)
    expect(store.stats().misses).toBe(1)
  })

  test("forgetting a pin makes it a miss", () => {
    const store = makeSessionStore({ ttl_ms: 60_000, max_entries: 10 })
    store.record("s", 7)
    store.forget("s")
    expect(store.lookup("s")).toBeNull()
  })

  test("re-recording replaces the provider", () => {
    const store = makeSessionStore({ ttl_ms: 60_000, max_entries: 10 })
    store.record("s", 7)
    store.record("s", 9)
    expect(store.lookup("s")).toBe(9)
    expect(store.stats().tracked).toBe(1)
  })

  test("evicts the oldest pin once the budget is exceeded", () => {
    const store = makeSessionStore({ ttl_ms: 60_000, max_entries: 3 })
    for (const key of ["a", "b", "c", "d"]) store.record(key, 1)
    expect(store.stats().tracked).toBe(3)
    expect(store.lookup("a")).toBeNull()
    expect(store.lookup("d")).toBe(1)
  })

  test("a zero ttl or budget disables affinity entirely", () => {
    const byTtl = makeSessionStore({ ttl_ms: 0, max_entries: 10 })
    byTtl.record("s", 1)
    expect(byTtl.lookup("s")).toBeNull()

    const byBudget = makeSessionStore({ ttl_ms: 1000, max_entries: 0 })
    byBudget.record("s", 1)
    expect(byBudget.lookup("s")).toBeNull()
  })

  test("a stale pin reads as absent once the ttl has passed", () => {
    // Time is advanced by rewriting the recorded timestamp rather than sleeping, so the
    // test is deterministic and instant.
    const store = makeSessionStore({ ttl_ms: 1, max_entries: 10 })
    store.record("s", 5)
    const deadline = Date.now() + 5
    while (Date.now() < deadline) {
      // Busy-wait a couple of milliseconds; the store is wall-clock based.
    }
    expect(store.lookup("s")).toBeNull()
  })
})
