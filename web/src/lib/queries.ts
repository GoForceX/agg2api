/** Shared query keys, fetch hooks, and the invalidation helper mutations use. */
import { useCallback } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ApiError, api } from "./api.ts"
import type { UsageLogParams } from "./api.ts"

export const queryKeys = {
  overview: ["overview"] as const,
  config: ["config"] as const,
  usage: ["usage"] as const,
  usageLog: ["usageLog"] as const
}

/** Time windows offered by the usage views, with a bucket that yields ~50–60 chart points. */
export const WINDOWS = [
  { id: "1h", label: "1 hour", windowMs: 3_600_000, bucketMs: 60_000 },
  { id: "24h", label: "24 hours", windowMs: 86_400_000, bucketMs: 1_800_000 },
  { id: "7d", label: "7 days", windowMs: 604_800_000, bucketMs: 10_800_000 },
  { id: "30d", label: "30 days", windowMs: 2_592_000_000, bucketMs: 43_200_000 }
] as const

export const DEFAULT_WINDOW = WINDOWS[1]

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

export function useUsage(windowMs: number, bucketMs: number) {
  return useQuery({
    queryKey: [...queryKeys.usage, windowMs, bucketMs],
    queryFn: () => api.usage(windowMs, bucketMs),
    retry: shouldRetry
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
