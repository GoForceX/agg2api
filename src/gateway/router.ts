/**
 * Candidate ordering — the whole of the routing policy.
 *
 * Pure and deterministic given a source of randomness, so the policy can be
 * tested exhaustively without HTTP, a database or a clock.
 */
import type { RoutingStrategy } from "../domain.ts"
import type { Target } from "../upstream/adapter.ts"

export interface Candidate {
  readonly target: Target
  readonly priority: number
}

/**
 * Weight floor.
 *
 * A non-positive or non-finite priority is treated as weight 1 rather than as a
 * tiny epsilon. The distinction matters: against a priority-1000 provider, an
 * epsilon floor makes the provider effectively unreachable (a 1-in-100000 chance),
 * which contradicts "deprioritised, not disabled" — an operator who typo's `0`
 * would see the provider never used. Weight 1 keeps it rare but genuinely
 * reachable.
 */
const MIN_WEIGHT = 1

const weightOf = (priority: number): number =>
  Number.isFinite(priority) && priority > MIN_WEIGHT ? priority : MIN_WEIGHT

/**
 * Arrange candidates into the order they will be tried.
 *
 * `priority` — strict descending order. This is the predictable setting: the top
 * provider takes every request until it fails, which is what an operator wants when
 * one upstream is cheaper or faster and the others are purely a fallback.
 *
 * `weighted` — a proportional *permutation*, not a single random pick. Trying the
 * candidates in a weighted random order preserves failover (every candidate still
 * appears exactly once) while spreading load in proportion to priority. This is
 * what "call proportionally by priority" means for a request that has to end up
 * somewhere: the highest-priority provider is tried first far more often, but not
 * always, so load is shared without giving up the fallback chain.
 *
 * Implemented as an exponential race — each candidate draws
 * `-ln(U) / weight` and the smallest wins. That is O(n log n) and yields exactly
 * the distribution of weighted sampling without replacement, unlike the common
 * shortcut of a single weighted draw followed by a priority sort (which either
 * ignores weights or ignores failover order).
 */
export const orderCandidates = (
  candidates: ReadonlyArray<Candidate>,
  strategy: RoutingStrategy,
  random: () => number
): ReadonlyArray<Candidate> => {
  if (candidates.length <= 1) return [...candidates]

  if (strategy === "priority") {
    return [...candidates].sort((a, b) => b.priority - a.priority)
  }

  return [...candidates]
    .map((candidate) => {
      // `random()` is contractually [0, 1); clamping away from 0 keeps `ln` finite
      // when a generator returns exactly 0.
      const u = Math.max(random(), Number.MIN_VALUE)
      const order = -Math.log(u) / weightOf(candidate.priority)
      return { candidate, order }
    })
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.candidate)
}
