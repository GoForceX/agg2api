/**
 * Health reporting.
 *
 * A gateway is "degraded" when it cannot serve completions — not merely when it is
 * running. The distinction matters for an orchestrator: a process that is up but has
 * no usable provider would answer every `/v1` request with a 503, so reporting `ok`
 * would keep it in a load balancer while it fails every request.
 *
 * Deliberately unauthenticated, because Docker's `HEALTHCHECK`, Kubernetes probes and
 * load balancers cannot present a bearer token. It therefore reports counts only —
 * never provider names, base URLs or keys — so leaving it open reveals nothing an
 * unauthenticated caller could act on.
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "@effect/sql/SqlClient"
import { listProviders } from "../db/providers.ts"
import { countServableRoutes } from "../db/routes.ts"
import type { HealthReport } from "./api.ts"

export const health =
  (): Effect.Effect<HealthReport, never, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      // A database failure is itself a health signal, so it reports "degraded" rather
      // than dying — a probe that crashes cannot distinguish "broken" from "absent".
      const state = yield* Effect.orElseSucceed(
        Effect.gen(function* () {
          const providers = yield* listProviders(sql)
          const routes = yield* countServableRoutes(sql)
          return {
            providers_total: providers.length,
            providers_enabled: providers.filter((provider) => provider.enabled).length,
            routes
          }
        }),
        () => ({ providers_total: 0, providers_enabled: 0, routes: 0 })
      )

      if (state.providers_enabled === 0) {
        return {
          status: "degraded" as const,
          ...state,
          detail: "no enabled provider: every completion request will fail"
        }
      }
      if (state.routes === 0) {
        return {
          status: "degraded" as const,
          ...state,
          detail: "no servable routes: every route is disabled, or its targets point at disabled or deleted providers"
        }
      }
      return { status: "ok" as const, ...state }
    })
