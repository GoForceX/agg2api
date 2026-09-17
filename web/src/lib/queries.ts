/** Shared query keys, fetch hooks, and the invalidation helper mutations use. */
import { COPY } from "./copy.ts"
import { useCallback } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ApiError, api } from "./api.ts"
import type { UsageLogParams, UsageRange } from "./api.ts"

export const queryKeys = {
  overview: ["overview"] as const,
  config: ["config"] as const,
  usage: ["usage"] as const,
  usageOverview: ["usageOverview"] as const,
  usageLog: ["usageLog"] as const
}

/** Time windows offered by the usage views, with a bucket that yields ~50–60 chart points. */
export const WINDOWS = [
  { id: "1h", label: COPY.windows["1h"], windowMs: 3_600_000, bucketMs: 60_000 },
  { id: "24h", label: COPY.windows["24h"], windowMs: 86_400_000, bucketMs: 1_800_000 },
  { id: "7d", label: COPY.windows["7d"], windowMs: 604_800_000, bucketMs: 10_800_000 },
  { id: "30d", label: COPY.windows["30d"], windowMs: 2_592_000_000, bucketMs: 43_200_000 }
] as const

export const DEFAULT_WINDOW = WINDOWS[1]

/**
 * Bars in the range selector's backdrop.
 *
 * Fixed rather than derived from the window: it is a shape to aim at, and a resolution
 * that changes with the window would make the same selection mean different things to
 * the eye at different spans.
 */
export const RANGE_POINTS = 120

/** Client errors and 4xx are terminal; 5xx and transport failures are worth one more try. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false
  return failureCount < 2
}

export function useOverview() {
  return useQuery({ queryKey: queryKeys.overview, queryFn: api.overview, retry: shouldRetry })
}

export function useAdminConfig() {
  return useQuery({ queryKey: queryKeys.config, queryFn: api.config, retry: shouldRetry })
}

/**
 * The summarised window. `range` narrows it to a slice the operator selected on the
 * chart; the query key includes both bounds so a selection is its own cache entry and
 * dragging back to a previous range is served instantly.
 */
export function useUsage(windowMs: number, bucketMs: number, range?: UsageRange) {
  return useQuery({
    queryKey: [...queryKeys.usage, windowMs, bucketMs, range?.from ?? null, range?.to ?? null],
    queryFn: () => api.usage(windowMs, bucketMs, range),
    retry: shouldRetry,
    placeholderData: (previous) => previous
  })
}

/** Coarse histogram of the whole window, so the range selector has something to aim at. */
export function useUsageOverview(windowMs: number, points: number) {
  return useQuery({
    queryKey: [...queryKeys.usageOverview, windowMs, points],
    queryFn: () => api.usageOverview(windowMs, points),
    retry: shouldRetry,
    // The brush's own backdrop: it changes only as history ages, not as the operator
    // drags, so it must not refetch on every selection.
    staleTime: 60_000
  })
}

export function useUsageLog(params: UsageLogParams) {
  return useQuery({
    queryKey: [...queryKeys.usageLog, params],
    queryFn: () => api.usageLog(params),
    retry: shouldRetry,
    placeholderData: (previous) => previous
  })
}

/** Refreshes every view derived from the mutated record: config, overview cards, usage rollups. */
export function useRefreshAdmin() {
  const client = useQueryClient()
  return useCallback(async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.config }),
      client.invalidateQueries({ queryKey: queryKeys.overview }),
      client.invalidateQueries({ queryKey: queryKeys.usage })
    ])
  }, [client])
}
