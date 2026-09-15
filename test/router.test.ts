import { describe, expect, test } from "bun:test"
import { orderCandidates, type Candidate } from "../src/gateway/router.ts"
import type { Provider } from "../src/domain.ts"

const provider = (id: number, name: string): Provider => ({
  id,
  name,
  kind: "openai-chat",
  base_url: "https://example.test",
  api_key: "",
  headers: {},
  priority: 100,
  enabled: true,
  model_rename: {},
  model_allow: [],
  model_deny: [],
  input_price: null,
  output_price: null,
  currency: "USD",
  max_retries: 0,
  created_at: 0,
  updated_at: 0
})

const candidate = (id: number, priority: number): Candidate => ({
  target: { provider: provider(id, `p${id}`), upstream_model: `m${id}` },
  priority
})

/** Deterministic generator so distribution assertions are reproducible. */
const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    // xorshift32
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x1_0000_0000
  }
}

describe("orderCandidates", () => {
  test("priority strategy orders strictly by descending priority", () => {
    const candidates = [candidate(1, 10), candidate(2, 300), candidate(3, 50), candidate(4, 300)]
    const ordered = orderCandidates(candidates, "priority", Math.random)

    expect(ordered.map((entry) => entry.priority)).toEqual([300, 300, 50, 10])
    // Every candidate survives exactly once — this is a reordering, not a filter.
    expect(ordered.length).toBe(candidates.length)
  })

  test("priority strategy is deterministic regardless of the random source", () => {
    const candidates = [candidate(1, 1), candidate(2, 9), candidate(3, 5)]
    const a = orderCandidates(candidates, "priority", seeded(1))
    const b = orderCandidates(candidates, "priority", seeded(99))
    expect(a.map((entry) => entry.target.provider.id)).toEqual(b.map((entry) => entry.target.provider.id))
  })

  test("weighted strategy is a permutation for every seed", () => {
    const candidates = [candidate(1, 500), candidate(2, 50), candidate(3, 1), candidate(4, 0)]
    const ids = [1, 2, 3, 4]

    for (let seed = 0; seed < 200; seed += 1) {
      const ordered = orderCandidates(candidates, "weighted", seeded(seed))
      expect(ordered.length).toBe(4)
      expect([...ordered.map((entry) => entry.target.provider.id)].sort((x, y) => x - y)).toEqual(ids)
    }
  })

  test("weighted strategy favours higher priority but still prefers failover over a single pick", () => {
    const candidates = [candidate(1, 900), candidate(2, 100)]
    let highFirst = 0
    const draws = 20_000

    for (let seed = 0; seed < draws; seed += 1) {
      const ordered = orderCandidates(candidates, "weighted", seeded(seed))
      if (ordered[0]?.target.provider.id === 1) highFirst += 1
    }

    const ratio = highFirst / draws
    // With a 9:1 weight ratio the high-priority provider should lead roughly 90% of
    // the time. Assert a band rather than the exact value so the test pins the
    // property (proportional, not absolute) instead of the sampler's constants.
    expect(ratio).toBeGreaterThan(0.85)
    expect(ratio).toBeLessThan(0.95)
  })

  test("weighted strategy keeps a zero-priority candidate reachable", () => {
    // A zero priority must not mean "never selected": it is deprioritised, and an
    // operator who sets 0 by accident should still get a working provider.
    const candidates = [candidate(1, 1000), candidate(2, 0)]
    let zeroFirst = 0
    const draws = 5_000

    for (let seed = 0; seed < draws; seed += 1) {
      const ordered = orderCandidates(candidates, "weighted", seeded(seed))
      if (ordered[0]?.target.provider.id === 2) zeroFirst += 1
    }

    expect(zeroFirst).toBeGreaterThan(0)
  })

  test("handles empty and single-candidate input", () => {
    expect(orderCandidates([], "weighted", Math.random)).toEqual([])
    expect(orderCandidates([], "priority", Math.random)).toEqual([])
    const single = orderCandidates([candidate(1, 5)], "weighted", Math.random)
    expect(single.length).toBe(1)
  })

  test("does not mutate the caller's array", () => {
    const candidates = [candidate(1, 1), candidate(2, 2)]
    const before = candidates.map((entry) => entry.target.provider.id)
    orderCandidates(candidates, "priority", Math.random)
    orderCandidates(candidates, "weighted", seeded(7))
    expect(candidates.map((entry) => entry.target.provider.id)).toEqual(before)
  })
})
